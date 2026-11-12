/**
 * Export progress dialog.
 *
 * Previously clicking "Export video" popped up nothing: progress went only to console.log, success showed one
 * alert, and failure showed another
 * alert (with gibberish like "Exited with code 3221225794"). Rendering several hundred frames takes tens of
 * seconds,
 * during which the UI did not react at all, so it looked like the button was broken.
 *
 * Now the whole process happens in this window: choose location → progress → result, and it can be cancelled
 * at any time.
 */
import { useEffect, useRef, useState } from "react";
import "./ExportDialog.css";
import { tr } from "../i18n/index.ts";

export type ExportPhase = "running" | "done" | "error" | "cancelled";

export interface ExportState {
  phase: ExportPhase;
  /** Server-side task id; "Open output folder" still needs it after the task ends, so it is kept in state rather than in a ref */
  id?: string;
  /** Completed frames / total frames of the current step */
  done: number;
  total: number;
  /**
   * sound = generate the audio first when export starts (done / total count segments, done may be fractional);
   * render = the browser renders cards frame by frame; compose = ffmpeg composes the video media and
   * the cards into the final video. Each step runs its own progress bar
   */
  stage?: "sound" | "render" | "compose";
  /** The destination chosen by the user; if none, the server's output directory */
  target: string;
  outDir?: string;
  message?: string;
  startedAt?: number;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return tr("{0} s", s);
  return tr("{0} min {1} s", Math.floor(s / 60), String(s % 60).padStart(2, "0"));
}

export function ExportDialog(props: {
  state: ExportState | null;
  onCancel: () => void;
  onClose: () => void;
  onReveal: () => void;
}) {
  const { state, onCancel, onClose, onReveal } = props;
  // Progress is only meaningful in the render phase, but elapsed time must keep running, so the timer lives on the dialog
  const [now, setNow] = useState(Date.now());
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state?.phase !== "running") return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [state?.phase]);

  // When done, give focus to the only button so keyboard users do not have to hunt for it
  useEffect(() => {
    if (state && state.phase !== "running") closeRef.current?.focus();
  }, [state?.phase]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Pressing Esc while rendering means "cancel export", not "close the window and leave the task in the background"
      if (state.phase === "running") onCancel();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onCancel, onClose]);

  if (!state) return null;

  const pct = state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  // The timer ticks only every half second: right after entering "in progress", `now` is still stale, so keep it from showing a negative value
  const elapsed = state.startedAt ? Math.max(0, now - state.startedAt) : 0;

  return (
    <div className="pc-export-backdrop" onClick={state.phase === "running" ? undefined : onClose}>
      <div
        className="pc-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr("Export video")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pc-export-title">
          {state.phase === "running" ? tr("Exporting video") :
           state.phase === "done" ? tr("Export complete") :
           state.phase === "cancelled" ? tr("Export canceled") : tr("Export failed")}
        </div>

        <div className="pc-export-target">
          <span className="pc-export-label">{tr("Save to")}</span>
          <span className="pc-export-path" title={state.target}>{state.target}</span>
        </div>

        {state.phase === "running" && (
          <>
            <div
              className="pc-export-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="pc-export-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="pc-export-meta">
              <span>{pct}%</span>
              <span data-pc="export-stage" data-stage={state.stage ?? "render"}>{state.stage === "sound"
                ? tr("Generating audio {0} / {1} segments", Math.min(state.total, Math.floor(state.done) + 1), state.total)
                : tr("{0} {1} / {2} frames", state.stage === "compose" ? tr("Compositing video") : tr("Rendering cards"), state.done, state.total)}</span>
              <span>{tr("{0} elapsed", fmtDuration(elapsed))}</span>
            </div>
            <div className="pc-export-hint">
              {tr("During rendering a separate hidden browser takes a screenshot of each frame, so high resource usage is normal.")}
            </div>
          </>
        )}

        {state.phase === "done" && (
          <div className="pc-export-ok">
            {tr("Video saved. The transparent card-only layer (overlay.mov) is in the output folder.")}
          </div>
        )}

        {/* Done, but some media were skipped because they are missing (TopBar writes this into message via exportSkippedMessage): list them, do not stay silent */}
        {state.phase === "done" && state.message && (
          <div className="pc-export-err" data-pc="export-skipped" style={{ whiteSpace: "pre-line" }}>{state.message}</div>
        )}

        {/* Cancel was clicked by the user, and the title already says "Export canceled", so repeating it
            here adds no information; changed to clearly explain what was left behind on site. */}
        {state.phase === "cancelled" && (
          <div className="pc-export-ok">
            {tr("Render stopped. Intermediate files were removed; exporting again creates a new output folder.")}
          </div>
        )}

        {state.phase === "error" && state.message && (
          <div className="pc-export-err">{state.message}</div>
        )}

        <div className="pc-export-actions">
          {state.phase === "running" ? (
            <button className="pc-export-btn" onClick={onCancel}>{tr("Cancel export")}</button>
          ) : (
            <>
              {state.outDir && (
                <button className="pc-export-btn" onClick={onReveal}>{tr("Open output folder")}</button>
              )}
              <button ref={closeRef} className="pc-export-btn pc-export-primary" onClick={onClose}>
                {tr("Close")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
