import { useEffect, useState } from "react";
import type { JSX } from "react";
import { prerenderUrl, usePrerenderBase, withBase } from "../../render/prerender";
import { tr } from "../../i18n/index.ts";

/**
 * The "visible result" of one tool step in the chat panel: the bitmap returned at the time, which
 * parameters were changed, and the before and after animated images.
 *
 * The record is handed by whoever executed the tool to the server to keep (`withVisual` in
 * src/ai/mcpExecutor.ts, or the image-viewing tools the server executes directly), and the tool
 * result carries a visualId at the very front. All four vendors' tool result summaries keep the
 * leading part, so recognizing the id from the summary is enough here, with no need to care whether
 * the step ran through direct API or agy / Claude / Codex.
 *
 * In local mode the records and animated images are stored in the prerender process (/api/ai/visual).
 */
export function visualIdOf(summary?: string): string | null {
  const m = /"visualId"\s*:\s*"(v-[0-9a-z]{6,40})"/.exec(summary || "");
  return m ? m[1] : null;
}

export interface VisualRecord {
  tool: string;
  images?: { url: string; label?: string }[];
  before?: { gif: string };
  after?: { gif: string };
  diff?: { key: string; from: string; to: string }[];
}

const inflight = new Map<string, Promise<VisualRecord>>();
const loaded = new Map<string, VisualRecord>();

export function clearVisualCache(): void {
  inflight.clear();
  loaded.clear();
}

export function loadVisualRecord(id: string): Promise<VisualRecord> {
  const hit = inflight.get(id);
  if (hit) return hit;
  const p = prerenderUrl(`/api/ai/visual/${id}.json`)
    .then((u) => fetch(u))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d) => {
      const rec = (d?.record ?? d) as VisualRecord;
      loaded.set(id, rec);
      return rec;
    });
  inflight.set(id, p);
  p.catch(() => {
    if (inflight.get(id) === p) inflight.delete(id);
  });
  return p;
}

/** A record that has already been fetched, read synchronously; undefined if not yet fetched or if the fetch failed */
export function peekVisualRecord(id: string): VisualRecord | undefined {
  return loaded.get(id);
}

/** Get a record for the UI: if it is in the cache, hand it over directly (no "Retrieving" flicker), otherwise go and fetch it */
export function useVisualRecord(id: string | null): { rec: VisualRecord | null; err: string } {
  const [state, setState] = useState<{ key: string; rec: VisualRecord | null; err: string }>(() => ({
    key: id ?? "",
    rec: (id && peekVisualRecord(id)) || null,
    err: "",
  }));

  useEffect(() => {
    if (!id) return;
    const cached = peekVisualRecord(id);
    if (cached) {
      setState((s) => (s.key === id && s.rec === cached && !s.err ? s : { key: id, rec: cached, err: "" }));
      return;
    }
    setState((s) => (s.key === id && s.rec === null && !s.err ? s : { key: id, rec: null, err: "" }));
    let alive = true;
    loadVisualRecord(id).then(
      (rec) => {
        if (alive) setState((s) => (s.key === id && s.rec === rec && !s.err ? s : { key: id, rec, err: "" }));
      },
      (e) => {
        if (alive) setState({ key: id, rec: null, err: String(e?.message || e) });
      },
    );
    return () => { alive = false; };
  }, [id]);

  if (!id) return { rec: null, err: "" };
  if (state.key !== id) return { rec: peekVisualRecord(id) || null, err: "" };
  return { rec: state.rec, err: state.err };
}

function isDirectAssetUrl(u: string): boolean {
  return u.startsWith("blob:") || u.startsWith("data:") || /^https?:\/\//i.test(u);
}

export function ToolVisual({ id }: { id: string }): JSX.Element {
  const { rec, err } = useVisualRecord(id);
  const base = usePrerenderBase();

  if (err) return <div className="ai-visual-note">{tr("The visual for this step can no longer be retrieved ({0})", err)}</div>;
  if (!rec) return <div className="ai-visual-note">{tr("Retrieving visual…")}</div>;
  if (base === null) return <div className="ai-visual-note">{tr("The prerender process is not ready yet, can't retrieve the visual")}</div>;

  const resolveSrc = (u: string) => (isDirectAssetUrl(u) ? u : withBase(base ?? "", u));
  const hasGif = !!(rec.before || rec.after);
  const afterLabel = rec.before ? tr("After") : rec.tool === "get_gif" ? tr("Full animation") : tr("New card");
  const beforeLabel = rec.after ? tr("Before") : tr("Deleted card");

  return (
    <div className="ai-visual">
      {rec.images?.length ? (
        <div className="ai-visual-images">
          {rec.images.map((im, i) => (
            <figure key={i}>
              <img src={resolveSrc(im.url)} alt={im.label || tr("Frame {0}", i + 1)} loading="lazy" />
              {im.label ? <figcaption>{im.label}</figcaption> : null}
            </figure>
          ))}
        </div>
      ) : null}

      {rec.diff?.length ? (
        <ul className="ai-visual-diff">
          {rec.diff.map((d) => (
            <li key={d.key}>
              <span className="k">{d.key}</span>
              <span className="from">{d.from}</span>
              <span className="arrow" aria-hidden>→</span>
              <span className="to">{d.to}</span>
            </li>
          ))}
        </ul>
      ) : rec.before && rec.after ? (
        <div className="ai-visual-note">{tr("Parameters unchanged (maybe only other tracks were changed, or this step was clamped back to the original value)")}</div>
      ) : null}

      {hasGif ? (
        <div className="ai-visual-gifs">
          {rec.before ? <Gif src={resolveSrc(rec.before.gif)} label={beforeLabel} /> : null}
          {rec.before && rec.after ? <div className="ai-visual-arrow" aria-hidden>→</div> : null}
          {rec.after ? <Gif src={resolveSrc(rec.after.gif)} label={afterLabel} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The server only renders the animated image (8 frames + encoding) when it is first opened, which
 * takes a few seconds to tens of seconds: show a spinner, and allow retry on failure.
 * The carousel uses it too; it starts loading as soon as it mounts, so don't mount it in a page that
 * has not been flipped to yet.
 */
/** onSettled: called when the animated image is ready or has definitively failed (the operation detail preview control uses it to tell whether this page has finished rendering, and only then lets you flip past it) */
export function Gif({ src, label, onSettled }: { src: string; label: string; onSettled?: () => void }): JSX.Element {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  const [attempt, setAttempt] = useState(0);
  const querySep = src.includes("?") ? "&" : "?";
  const retrySrc = attempt && !src.startsWith("blob:") && !src.startsWith("data:")
    ? `${src}${querySep}retry=${attempt}`
    : src;
  return (
    <figure className={`ai-visual-gif is-${state}`}>
      <div className="box">
        {state === "err" ? (
          <button type="button" onClick={() => { setState("loading"); setAttempt((n) => n + 1); }}>{tr("The animation failed to generate, click here to retry")}</button>
        ) : (
          <>
            {state === "loading" ? <span className="ai-spinner" aria-hidden /> : null}
            <img
              key={attempt}
              src={retrySrc}
              alt={label}
              onLoad={() => { setState("ok"); onSettled?.(); }}
              onError={() => { setState("err"); onSettled?.(); }}
            />
          </>
        )}
      </div>
      <figcaption>{label}{state === "loading" ? tr(" · Rendering…") : ""}</figcaption>
    </figure>
  );
}
