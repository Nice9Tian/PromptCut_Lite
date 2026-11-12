/**
 * Which path the preview takes: **the rollback switch `?preview=legacy` and the dual-stage switch
 * `?preview=stage`** (D5 / F2).
 *
 * **R7 flipped the default**: with no parameter, with `?preview=stage`, or with any other value,
 * the preview runs on the cross-origin dual stage. The stage iframe is exposed directly, the
 * playhead is pushed by the visible stage on its frame tick (K4), and the main document keeps only
 * audio. To go back to the old path you must write `?preview=legacy` explicitly: one same-origin
 * stage iframe, a full-frame `<img>` preview, and the playhead pushed by the rAF loop in `Preview`.
 */

/** Stage instance name. **Only an instance name, unrelated to the role** (E1): which one is `front` is decided by `setRole` */
export type StageId = "A" | "B";

export const STAGE_IDS: readonly StageId[] = ["A", "B"];

/** Initial role assignment: A is the visible stage, B is the background stage. After the K5 swap this table no longer applies */
export const INITIAL_ROLE_OF: Record<StageId, "front" | "back"> = { A: "front", B: "back" };

export type PreviewMode = "legacy" | "stage";

const paramOf = (): string => (typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("preview") || "");

/**
 * **The default is stage (R7's atomic switch)**; only an explicit `?preview=legacy` falls back to
 * the single stage + full-frame path.
 */
export function previewMode(): PreviewMode {
  return paramOf() === "legacy" ? "legacy" : "stage";
}

/**
 * The stage ports the editor process actually started (injected by
 * `server/vite-plugin-stage-ports.ts`). If a port is taken, or in an environment without this
 * plugin (the vite preview bundle), this is an empty table.
 */
export function stagePorts(): number[] {
  const v = (window as unknown as { __PC_STAGE_PORTS__?: unknown }).__PC_STAGE_PORTS__;
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
}

/**
 * Which origin each stage instance loads from. **Built from the current page's hostname** (not
 * hardcoded 127.0.0.1): when the user opens from `localhost`, both iframes must also be on
 * `localhost`. Same host with different ports + OAC headers is the path that was verified in
 * practice (`docs/archive/restructure_planning/g0-a-webview2-probe.md`); any other host would be a
 * different matter.
 */
export function stageOrigins(): Record<StageId, string> | null {
  const ports = stagePorts();
  if (ports.length < STAGE_IDS.length) return null;
  const out = {} as Record<StageId, string>;
  STAGE_IDS.forEach((id, i) => { out[id] = `${location.protocol}//${location.hostname}:${ports[i]}`; });
  return out;
}

/**
 * Whether to enable the dual stage this time. Both conditions are required: `?preview=stage` was
 * explicitly set, and both stage ports are up. If either is missing, fall back to legacy's
 * same-origin single stage. Better to lack a background stage than to leave the editor unable to
 * show a picture.
 */
export function dualStage(): boolean {
  return previewMode() === "stage" && stageOrigins() !== null;
}

export function interimStage(): boolean {
  return false;
}

export function singleLiveStage(): boolean {
  return false;
}

/** The visible stage renders the live variant (dual stage): the playhead follows the stage's `frame`, and snapshots / suppression are delivered via RPC */
export function liveStage(): boolean {
  return dualStage();
}

/**
 * The address of the stage iframe. Under legacy (or when ports didn't start) it is same-origin,
 * with only A.
 */
export function stageSrc(id: StageId, opts: { dual?: boolean } = {}): string {
  const dual = opts.dual ?? dualStage();
  const origins = dual ? stageOrigins() : null;
  const mode = dual ? "&preview=stage" : previewMode() === "legacy" ? "&preview=legacy" : "";
  const platform = new URLSearchParams(location.search).get("platform") === "browser" ? "&platform=browser" : "";
  const dualFlag = dual ? "&dual=1" : "";
  const path = location.pathname;
  return `${origins ? origins[id] : ""}${path}?stage=1&id=${id}${mode}${platform}${dualFlag}`;
}

/** The `targetOrigin` for `createStageRpc`: when cross-origin it must be named explicitly, and `location.origin` can't be used */
export function stageTargetOrigin(id: StageId): string {
  const origins = dualStage() ? stageOrigins() : null;
  return origins ? origins[id] : location.origin;
}
