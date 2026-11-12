import { UnifiedPreview } from "./preview/UnifiedPreview";
import { usePrerenderPreload } from "./preview/usePrerenderPreload";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { MediaLayers } from "./preview/MediaLayers";
import { Scene3DView } from "./preview/Scene3DView";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { activeCutKind, findClip } from "../kernel/project";
import { nudgeFrame } from "../kernel/layout";
import { createStageRpc, type HostCapabilities, type StageRpcClient } from "../render/stageRpc";
import { frontStage, onStageEvent, releaseStageClient, setBeforeFullStagePush, setStageClient, swapStageClients, syncProject } from "./stageBridge";
import { alignMirrorForStageMedia } from "../render/dataMirror";
import { bindStageCards, noteStageCards, noteStageFresh } from "./stageCards";
import { INITIAL_ROLE_OF, STAGE_IDS, dualStage, liveStage, stageSrc, stageTargetOrigin, type StageId } from "./previewMode";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { useMemberReadOnly } from "./readOnly";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { getCard, onCardRunStatesChanged, onSyncedUserCardsChanged } from "../kernel/registry";
import { fitView, frameOrigin, framedFitView, framedPanBy, framedZoomAt, framedZoomPercent, isFramedFitted, panBy, resizeFramedView, wheelZoomFactor, zoomAt, type Size, type View2D } from "./preview/viewport2d";
import "./preview/preview.css";
import { atFrameGrid } from "../render/frameGrid";
import { contentStartOf } from "./timeline/utils";
import { startAssetTiers, tierHashes, useTierHashes } from "./media/assetTiers";
import { startTierBackfill } from "./io/mediaUpload";
import { clearSettled, markBaselineReset, noteSettled, pendingDemotes, setCostResolver, snapshotFeedDebug, stopSnapshotFeed, streamPlanesAt, suppressedAt, syncSnapshotSubscription } from "./snapshotFeed";
import { notePlayFrame, notePlayRunStart, playingSwapTargets, runPlayingSwap, runSettleSwap, setSwapHost, stageSwapDebug, stageSwapPlayingDebug, stageSwapTrace, swapInFlight } from "./stageSwap";
import { demotedClips, onStageDemote } from "./demote";
import { flushSync } from "react-dom";
import { useUserEditing } from "./userEditing";
import { createSharedGl, type SharedGl } from "../render/gl/glParent";
import { resolveGlRoute } from "../render/costDevice.mjs";
import { onlineBrowserMode, setOnlineBrowserMode } from "../render/placeholderHost";
import { measureGateDiag } from "./measureGate";
import { currentCosts, onPlanUpdated, sendPlanTo, setPlanDeadMs } from "./planDispatch";
import { clipIdentityOf } from "./costIdentity";
import { createMemoryCostStore, type CostStore } from "../render/boundarySearch.mjs";
import { beatSwapDebug, setBeatSwap } from "./snapshotFeed";
import { onProbeProgress, probeFrameDiag, probeProgress, probeRunDiag } from "./probeRunner";
import type { SettleResult } from "../render/settleFrame";
import { tr as trText } from "../i18n/index.ts";

setCostResolver((proj, clipId) => {
  const key = clipIdentityOf(proj).identityKeys[clipId];
  return key ? currentCosts().find((r) => r.identityKey === key) : undefined;
}, () => dualStage());
setBeforeFullStagePush(alignMirrorForStageMedia);

let _searchCostStore: CostStore = createMemoryCostStore();
export function setSearchCostStore(store: CostStore): void {
  _searchCostStore = store;
  void _searchCostStore;
}

try { setOnlineBrowserMode(new URLSearchParams(location.search).get("platform") === "browser"); } catch { /* No location */ }

/**
 * Central preview: video layer + motion graphics render surface, scaled to the container. The playback loop is here too (rAF advances store.t).
 *
 * Motion graphics do not play in this document: they run in the ?stage=1 iframe below (the render surface), whose time is taken over.
 * This side only sends down "which second of the timeline it is now", and the render surface renders that frame. So dragging the playhead to the middle of a clip
 * shows the picture that belongs at that moment, rather than replaying the entrance animation from the start. See src/StageView.tsx for details.
 *
 * Video layer: find the media clip that should be playing with videoClipAt, switch the source when src changes, and seek when the time is off (>0.2s).
 */
export function Preview(props: { variant?: "mobile" | "framed" } = {}) {
  /**
   * `mobile` (`ChatSidePanel.tsx`) and `framed` (Vibe mode `DetailEdit.tsx`) both mount only the
   * picture without Classic mode's 2D/3D tabs, tool row or playback bar (`compact`).
   * `mobile` stays fitted without hijacking wheel scrolling; `framed` enables bounded [100%, 800%] zoom,
   * four-edge-clamped pan, and the top-right percentage + "Fit" control (issue #15).
   */
  const mobile = props.variant === "mobile";
  const framed = props.variant === "framed";
  const compact = mobile || framed;

  const project = useStore((s) => s.project);
  // C6.6: the tier-switch set of the two-tier media (while the preview is mounted, ask the current asset service every 2 seconds)
  const tierList = useTierHashes();
  useEffect(() => startAssetTiers(), []);
  useEffect(() => startTierBackfill(), []);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const playToken = useStore((s) => s.playToken);
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);
  const selection = useStore((s) => s.selection);
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * The two stage iframes (E1). `A` / `B` **are only instance names, unrelated to roles**: initially A is the
   * visible stage and B is the background stage (`INITIAL_ROLE_OF`). Roles are set only through `setRole`,
   * and after the K5 swap they are reversed.
   * In legacy mode (the default) only A is mounted, same-origin, exactly as it is today.
   */
  const frameARef = useRef<HTMLIFrameElement>(null);
  const frameBRef = useRef<HTMLIFrameElement>(null);
  const dual = dualStage();
  const live = liveStage();
  const [cam, setCam] = useState<View2D>({ scale: 0.4, tx: 0, ty: 0, auto: true });
  const scale = cam.scale;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const camRef = useRef(cam);
  camRef.current = cam;
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  const [stageReady, setStageReady] = useState(0);
  const stageReadyRef = useRef(stageReady);
  stageReadyRef.current = stageReady;
  const tRef = useRef(t);
  tRef.current = t;
  const playedRef = useRef(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  /*
   * The preview has two pages. 2D is the final video (what the preview shows = what the export gives), and 3D is "how
   * these things are arranged in space".
   * Each page answers its own question, and they must not accommodate each other: a proxy color block showing up in
   * 2D breaks its contract.
   */
  const [view, setView] = useState<"2d" | "3d">("2d");
  const is3DCut = activeCutKind(project) === "3d";
  useEffect(() => {
    setView("2d");
  }, [project.activeCutId]);
  const show3DScene = is3DCut || view === "3d";
  const scene3DMode: "camera" | "space" = is3DCut && view === "2d" ? "camera" : "space";
  const [pickedTool, setTool] = useState<ToolType>("select");
  // This project was given read-only permission (guest): moving and editing text are writes, so the tool always falls back to "select" (click to select and view parameters only); the two on the toolbar are also grayed out
  const readOnlyProject = useMemberReadOnly();
  const tool: ToolType = readOnlyProject ? "select" : pickedTool;
  const [rects, setRects] = useState<{ clipId: string; left: number; top: number; width: number; height: number }[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string; cardId: string } | null>(null);
  const [editingText, setEditingText] = useState<{ clipId: string; key: string; value: string; x: number; y: number } | null>(null);

  // Records the displacement preview state while using the drag tool
  const [dragPreview, setDragPreview] = useState<{ clipId: string; dx: number; dy: number } | null>(null);
  // While dragging / editing text on the stage: tell the Agent the user is editing this card (A2)
  useUserEditing("stage-move", dragPreview?.clipId ?? null, "drag");
  useUserEditing("stage-text", editingText?.clipId ?? null, "text");

  const rpcRef = useRef<Record<StageId, StageRpcClient | null>>({ A: null, B: null });
  const hostCapsRef = useRef<Record<StageId, HostCapabilities | null>>({ A: null, B: null });
  const [backStageMount, setBackStageMount] = useState(false);
  const processReadyRef = useRef<(id: StageId, win: Window, origin: string, caps: HostCapabilities | null) => void>(() => {});
  const stage = useCallback((): StageRpcClient | null => frontStage(), []);
  const frameRefOf = useMemo(() => {
    const bind = (id: StageId, holder: React.RefObject<HTMLIFrameElement | null>) => (el: HTMLIFrameElement | null) => {
      holder.current = el;
      if (el) return;
      const client = rpcRef.current[id];
      if (!client) return;
      rpcRef.current[id] = null;
      hostCapsRef.current[id] = null;
      releaseStageClient(client);
      client.dispose();
    };
    return { A: bind("A", frameARef), B: bind("B", frameBRef) };
  }, []);
  /*
   * R9 route 2 (`shared`): the editor document opens **one** GL Worker, and the two stages share it through their own
   * `MessageChannel`.
   * Built lazily: only when the effective route really is `shared`. The ports are handed over after the handshake and
   * before any RPC (see the `pc-stage-ready` part below).
   */
  const sharedGlRef = useRef<SharedGl | null>(null);
  const glPortTo = useCallback((id: StageId, win: Window, caps: HostCapabilities | null) => {
    if (resolveGlRoute(getState().project.glRoute) !== "shared") return;
    sharedGlRef.current ??= createSharedGl({ compact: !!caps?.compact });
    sharedGlRef.current.connect(win, stageTargetOrigin(id), id);
    if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__pcSharedGlDiag = () => sharedGlRef.current?.diag() ?? Promise.resolve(null);
  }, []);
  useEffect(() => {
    setBeatSwap(false, { costOf: null });
    setPlanDeadMs(null);
  }, []);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /*
   * The playback loop. **The playhead stops only on frames the final video really has.**
   *
   * It used to advance continuously by wall clock: on a 60Hz display it pushed 60 values of t per second, while the
   * final video has fps frames, so half of the t values did not exist in the final video at all. This is
   * imperceptible in 2D alone, but it shows as soon as you switch to 3D:
   * there the displayed picture is a prerendered whole frame, the two views could differ by half a frame for the same
   * playhead, and the entrance animation is steepest exactly in that stretch.
   * After quantization, 2D playback shows the very frame the export would write, and 3D pastes the same frame.
   *
   * The accumulator acc must stay unquantized, otherwise the small remainder dropped each frame accumulates and
   * playback gets slower and slower.
   *
   * Playback range = the earliest card ~ the latest card (project.duration is synced by the timeline from the end of
   * the content).
   * If the playhead is not in this range when play is pressed (before the first card, or already played to the end),
   * playback starts from the earliest card.
   */
  const contentStart = contentStartOf(project.tracks);
  /** The stage-side `playing` effect has only three dependencies (see the note there), and the playback start point is read from here */
  const contentStartRef = useRef(contentStart);
  contentStartRef.current = contentStart;
  useEffect(() => {
    /*
     * E6: **this loop does not start when not in legacy mode**: the playhead is advanced by K4's `frame`
     * events (the visible stage ticks per frame on its own and reports after each tick finishes
     * rendering). The wall-clock loop is kept only for `?preview=legacy`.
     */
    if (live) return;
    if (!playing) return;
    const fps = Math.max(1, project.fps || 30);
    let raf = 0;
    let last = performance.now();
    let acc = tRef.current;      // Where playback has actually advanced to (not quantized)
    if (acc < contentStart || acc >= project.duration - 0.5 / fps) {
      acc = contentStart;
      actions.seek(contentStart);
    }
    let wrote = atFrameGrid(acc, fps);  // The frame time handed out last time
    const tick = (now: number) => {
      /*
       * During playback something outside may also seek (clicking the timeline, dragging the playhead);
       * in that case the outside value wins. The criterion is "differs by more than one frame", not
       * "not equal": tRef is only assigned during render, so after quantization the store's t may be one
       * frame behind this one. That is not a seek; treating it as one would make playback step back one
       * frame every few frames.
       */
      if (Math.abs(tRef.current - wrote) > 1.5 / fps) acc = tRef.current;
      acc += (now - last) / 1000;
      last = now;
      if (acc >= project.duration) {
        actions.pause();
        actions.seek(project.duration);
        return;
      }
      wrote = atFrameGrid(acc, fps);
      actions.tick(wrote);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // contentStart is not in the dependencies: moving the first card during playback must not pull the playhead back
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, playing, project.duration, project.fps]);

  /*
   * Measure the window size once and, if "auto fit" is still on, recompute the zoom ratio.
   *
   * Both need doing, for different reasons:
   *   - The window size **must always be tracked**, because we compute where the frame sits
   *     ourselves (see frameOrigin below), and the formula uses the window width and height;
   *   - The zoom ratio is recomputed only in auto mode. It used to be recomputed unconditionally,
   *     which did not matter when there was no manual zoom. Now it does: the user zooms to 200% to
   *     adjust the position of one character, drags the sidebar width (the ResizeObserver fires),
   *     and the view snaps back to fit the window, losing the spot they had just found.
   *
   * useLayoutEffect instead of useEffect: on the first render the window size is not known yet, so
   * the frame is first placed at the top left. Layout effects run synchronously **before** the
   * browser paints and trigger a re-render, so the user never sees that frame.
   */
  const prevFramedLayoutRef = useRef<{ project: Size; box: Size } | null>(null);

  const measureStageBox = (el: HTMLElement, entryRect?: DOMRectReadOnly) => {
    const r = el.getBoundingClientRect();
    if (entryRect && entryRect.width >= 1 && entryRect.height >= 1) {
      return { width: entryRect.width, height: entryRect.height, rect: r };
    }
    // Ancestor entrance animations (e.g. `.ps-detail`'s `scale(0.97)`) shrink `getBoundingClientRect()` without
    // re-firing ResizeObserver when the animation finishes; fall back to unscaled clientWidth/Height when skewed.
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const skewed = cw >= 1 && ch >= 1 && (Math.abs(r.width - cw) > 1 || Math.abs(r.height - ch) > 1);
    return {
      width: skewed ? cw : r.width,
      height: skewed ? ch : r.height,
      rect: r,
    };
  };

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const applyBox = (b: { width: number; height: number }) => {
      if (b.width < 1 || b.height < 1) return;
      const nextBox = { width: b.width, height: b.height };
      const projSize = { width: project.width, height: project.height };
      setBoxSize(nextBox);
      if (framed) {
        const nextCam = resizeFramedView(camRef.current, projSize, prevFramedLayoutRef.current, nextBox);
        prevFramedLayoutRef.current = { project: projSize, box: nextBox };
        camRef.current = nextCam;
        setCam(nextCam);
      } else if (camRef.current.auto) {
        const nextCam = fitView(projSize, nextBox, compact ? 0 : undefined);
        camRef.current = nextCam;
        setCam(nextCam);
      }
    };
    applyBox(measureStageBox(el));
    const ro = new ResizeObserver((entries) => applyBox(measureStageBox(el, entries[0]?.contentRect)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height, view, framed, compact]);

  /** Go back to "fit window". Clicking that badge in the tool row or the top-right framed pill comes here */
  const fitToWindow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const b = measureStageBox(el);
    if (b.width < 1 || b.height < 1) return;
    const nextBox = { width: b.width, height: b.height };
    const projSize = { width: project.width, height: project.height };
    const nextCam = framed ? framedFitView(projSize, nextBox) : fitView(projSize, nextBox, compact ? 0 : undefined);
    if (framed) prevFramedLayoutRef.current = { project: projSize, box: nextBox };
    camRef.current = nextCam;
    setCam(nextCam);
  }, [project.width, project.height, framed, compact]);

  /*
   * Wheel zoom + drag to pan.
   *
   * Why not React's onWheel: since React 17 the wheel is bound as a **passive** listener, so calling
   * preventDefault inside it not only has no effect but also logs a console warning:
   * the wheel then scrolls the whole panel while it zooms the view. We have to call
   * addEventListener ourselves and explicitly turn passive off.
   *
   * `mobile` (phone editor + side-panel thumbnail) skips wheel/pan binding so scrolling the side panel works
   * normally; `framed` (Vibe DetailEdit) clamps zoom to [100%, 800%] and allows both middle-drag and
   * zoomed-in left-drag panning while keeping all four video edges covering the frame.
   */
  useEffect(() => {
    if (mobile) return;
    const el = boxRef.current;
    if (!el) return;
    const size = { width: project.width, height: project.height };

    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-pc="preview-zoom"]')) return;
      e.preventDefault();
      const m = measureStageBox(el);
      if (m.width < 1 || m.height < 1) return;
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
      if (factor === 1) return;
      const sx = m.rect.width > 0 ? m.width / m.rect.width : 1;
      const sy = m.rect.height > 0 ? m.height / m.rect.height : 1;
      const cursor = { x: (e.clientX - m.rect.left) * sx, y: (e.clientY - m.rect.top) * sy };
      const nextBox = { width: m.width, height: m.height };
      const cur = camRef.current;
      const nextCam = framed
        ? framedZoomAt(cur, size, nextBox, cursor, cur.scale * factor)
        : zoomAt(cur, size, nextBox, cursor, cur.scale * factor);
      if (nextCam !== cur) {
        camRef.current = nextCam;
        setCam(nextCam);
      }
    };

    /*
     * Middle-button drag: hold and drag to move the canvas in both Classic and framed modes.
     * In framed mode (`DetailEdit`), where Classic's move/text toolbar is absent, left-button drag (>= 4px)
     * also pans whenever zoomed above 100%, while clicks (< 4px) still select/deselect stage cards.
     */
    const PAN_DRAG_PX = 4;
    let panning = false;
    let leftPending = false;
    let panPointerId = -1;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-pc="preview-zoom"]')) return;
      if (e.button === 1) {
        // On many browsers the middle button means "autoscroll"; if not intercepted, that round scroll cursor pops up
        e.preventDefault();
        panning = true;
        leftPending = false;
        panPointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        // Capture the pointer so the drag keeps following even outside the preview area
        try { el.setPointerCapture(e.pointerId); } catch { /* Already released */ }
        el.style.cursor = "grabbing";
        return;
      }
      if (framed && e.button === 0) {
        const m = measureStageBox(el);
        if (m.width < 1 || m.height < 1) return;
        if (isFramedFitted(camRef.current, size, { width: m.width, height: m.height })) return;
        leftPending = true;
        panPointerId = e.pointerId;
        startX = lastX = e.clientX;
        startY = lastY = e.clientY;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== panPointerId) return;
      if (leftPending) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < PAN_DRAG_PX) return;
        leftPending = false;
        panning = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* Already released */ }
        el.style.cursor = "grabbing";
      }
      if (!panning) return;
      const m = measureStageBox(el);
      if (m.width < 1 || m.height < 1) return;
      const sx = m.rect.width > 0 ? m.width / m.rect.width : 1;
      const sy = m.rect.height > 0 ? m.height / m.rect.height : 1;
      const dx = (e.clientX - lastX) * sx;
      const dy = (e.clientY - lastY) * sy;
      lastX = e.clientX;
      lastY = e.clientY;
      const nextBox = { width: m.width, height: m.height };
      const cur = camRef.current;
      const nextCam = framed
        ? framedPanBy(cur, size, nextBox, dx, dy)
        : panBy(cur, size, nextBox, dx, dy);
      if (nextCam !== cur) {
        camRef.current = nextCam;
        setCam(nextCam);
      }
    };
    const stopPan = (e: PointerEvent) => {
      if (e.pointerId !== panPointerId) return;
      leftPending = false;
      panPointerId = -1;
      if (!panning) return;
      panning = false;
      try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch { /* Already released */ }
      el.style.cursor = "";
    };
    // Middle-button press starts autoscroll by default; auxclick must be intercepted too, or it still fires on release
    const onAux = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", stopPan);
    el.addEventListener("pointercancel", stopPan);
    el.addEventListener("auxclick", onAux);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", stopPan);
      el.removeEventListener("pointercancel", stopPan);
      el.removeEventListener("auxclick", onAux);
    };
  }, [project.width, project.height, view, mobile, framed]);

  /*
   * Render surface ready: once mounted it posts a message over (carrying J4's host capability table);
   * each time one arrives, create a new RPC client for **that one instance**. When cross-origin,
   * `targetOrigin` must name the stage's origin explicitly (`location.origin` can no longer be used).
   *
   * Right after the handshake, send `setRole` once to match the instance with its role: the stage's
   * own default role is `front`, so if the B iframe does not send it, it receives probes under the
   * identity of `front` (the role gate would block them, but that is a fallback, not the design).
   */
  useEffect(() => {
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    const onMessage = (e: MessageEvent) => {
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "pc-stage-cards") {
        // The stage finished re-rendering for the new cards (C6.6 integration 3b, `stageCards.ts`)
        for (const id of STAGE_IDS) if (e.source === frames[id].current?.contentWindow) noteStageCards(id, Number((e.data as { stamp?: number }).stamp) || 0);
        return;
      }
      if (type !== "pc-stage-ready") return;
      const readyCaps = (e.data as { hostCapabilities?: HostCapabilities }).hostCapabilities ?? null;
      for (const id of STAGE_IDS) {
        const win = frames[id].current?.contentWindow;
        if (!win || e.source !== win) continue;
        processReadyRef.current(id, win, e.origin, readyCaps);
        return;
      }
    };
    processReadyRef.current = (id, win, origin, caps) => {
      /*
       * What role this instance should have right now. **It must not always follow `INITIAL_ROLE_OF`**:
       * after K5's swap, A may already be the background one, and one hot reload would bring it back
       * as `front` and knock out the real visible stage.
       */
      const role = frontIdRef.current === id ? "front" : "back";
      noteStageFresh(id);
      rpcRef.current[id]?.dispose();
      const targetOrigin = origin && origin !== "null" ? origin : stageTargetOrigin(id);
      const client = createStageRpc(win, targetOrigin, { maxSec: () => getState().project.duration });
      rpcRef.current[id] = client;
      hostCapsRef.current[id] = caps;
      glPortTo(id, win, caps);
      setStageClient(role, client, caps);
      void client.setRole(role).catch(() => { /* The iframe changed again; the next handshake will resend */ });
      void client.setViewScale(scaleRef.current).catch(() => { /* Same as above */ });
      if (role === "front") setStageReady((n) => n + 1);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const id of STAGE_IDS) {
        rpcRef.current[id]?.dispose();
        rpcRef.current[id] = null;
        setStageClient(INITIAL_ROLE_OF[id], null);
      }
      sharedGlRef.current?.dispose();
      sharedGlRef.current = null;
    };
  }, [glPortTo]);

  const onStageFrameLoad = useCallback((id: StageId) => {
    if (id === "A") setBackStageMount(true);
  }, []);

  /*
   * A change of card code generally does not reload the stage (C6.6 integration 3b). It used to be that editing a card bubbled the hot update up to this component, Fast Refresh reran the handshake effect above,
   * cleared the stage's RPC client, and the stage stayed on the old picture, so both iframes had to be fully reloaded every time (`b25f482`). Now the hot update is caught in `cards/index.ts`
   * and does not bubble up here; the stage itself also receives the same hot update, reinstalls the cards and re-renders in the stage, then sends `pc-stage-cards` to report in.
   * Only a stage that has not reported in after the time limit (its code is truly stale) gets that one fully reloaded here (`whenStagesHaveCards` in `stageCards.ts`).
   */
  useEffect(() => {
    const ids: StageId[] = dual ? [...STAGE_IDS] : ["A"];
    return bindStageCards(ids, (id) => {
      const frame = (id === "A" ? frameARef : frameBRef).current;
      if (!frame) return;
      const client = rpcRef.current[id];
      if (client) {
        releaseStageClient(client);
        client.dispose();
        rpcRef.current[id] = null;
        hostCapsRef.current[id] = null;
      }
      console.warn(`[preview] stage ${id} did not pick up the new card code, reloading the whole page for it`);
      frame.src = frame.src;
    });
  }, [dual]);

  /*
   * The project option switched `glRoute` (R9 constraint item 1): when switching to `shared`, hand the port to the stages that already handshook;
   * when switching back to `perDocument` nothing needs sending: on receiving the new project the stage rebuilds the `glHost` side of the connection by the effective route.
   * Re-running the `ProbeGate` overlay (`device` changed) is not here; see the R9 report.
   */
  const glRoute = project.glRoute;
  const glRouteSeen = useRef(glRoute);
  useEffect(() => {
    if (glRouteSeen.current === glRoute) return;
    glRouteSeen.current = glRoute;
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    for (const id of STAGE_IDS) {
      const win = frames[id].current?.contentWindow;
      if (win && rpcRef.current[id]) glPortTo(id, win, hostCapsRef.current[id]);
    }
  }, [glRoute, glPortTo]);

  /**
   * Media and audio play by wall clock: when **a tick runs this much slower than its nominal duration**, pause them
   * (K4 / pinned architecture 10; same value as `IN_SYNC_SEC` in `mediaSync.ts`).
   * When the next tick arrives on time they are resumed: this is the "small hitch" the user can feel.
   *
   * The threshold is pinned at a fixed 40 milliseconds, not computed in frames; **what is measured is the "stall", not the
   * total interval between two `frame` events**: a tick naturally takes `1000/fps` milliseconds, and counting that as a hitch treats the normal cadence as a stall.
   * This is especially visible at 24 / 25 fps: on a 60 Hz screen a tick of 41.7 / 40 ms does not fit into 16.7 ms slots,
   * so the actual arrivals alternate 33 / 50 (the tick loop in `StageView.tsx` says so itself),
   * and if judged by the total interval, every other tick would be misjudged as a hitch and the audio would pause and resume every ~80 ms.
   * Judge by "how much it exceeds the nominal tick length": a 50 ms tick at 24 fps exceeds it by only 8.3 ms, and 60 fps dropping one vsync
   * exceeds it by only 16.7 ms, neither reaching 40 ms; while a real hitch (say 300 ms) is still detected on the spot.
   */
  const MEDIA_STALL_MS = 40;
  /** E6: during playback `refreshRects` becomes a timer, so it does not make a round trip every tick */
  const RECTS_POLL_MS = 500;

  /**
   * Whether the media layer / audio is being choked during playback (K4's `mediaStalled`).
   *
   * **Channel hard-wired**: the `playing` prop of `MediaLayers` is changed to `playing && !mediaStalled`, and the stage side syncs via
   * `setPlaying(false)`. Calling `pause()` directly on the element is useless: in every branch of the playing state `planSync`
   * returns `play: paused`, and the next tick gets it `play()`ed back.
   */
  const [mediaStalled, setMediaStalled] = useState(false);
  const stalledRef = useRef(false);
  /** The **actual** arrival moment of the previous `frame` (for the first tick, the starting point is the moment the `play()` reply arrived) */
  const lastFrameAtRef = useRef(0);
  /** Acceptance check port: how many hitches this round of playback judged, and the largest one's excess over the nominal tick length in milliseconds */
  const stallCountRef = useRef(0);
  const gapMaxRef = useRef(0);
  /*
   * "Audio follows the beat" (`mechanism/rendering.md`) requires audio to follow the stage's beat.
   * There used to be two leaks that let sound run ahead:
   *
   * 1. **Between start of playback and the first beat**: as soon as `playing` flips, the main document's
   *    audio starts at once, while the playhead only moves after the stage has received the project,
   *    answered with `play` and rendered the first beat. When the stage starts slowly (project just
   *    opened, heavy cards), sound plays a few hundred milliseconds early, and the drift passes the hard
   *    seek threshold and gets pulled back, replaying it.
   *    `firstBeatRef`: audio is released only once the first beat of this playback run has arrived. It
   *    only governs the main document's audio and does not touch the media layers inside the stage.
   * 2. **Stalls were judged only on arrival**: a late beat was recognized as late only when it arrived,
   *    and audio kept playing through the few hundred stalled milliseconds.
   *    Watchdog: if no next beat shows up within "nominal beat length + 40 ms" after the previous beat
   *    (or the `play` reply), it is treated as a stall on the spot and audio is held;
   *    the criterion is the same as the one on arrival (exceeding the nominal beat length by 40 ms),
   *    it just does not wait for the beat to arrive.
   */
  const firstBeatRef = useRef(false);
  const [, setFirstBeatSeen] = useState(0);
  if (!playing) firstBeatRef.current = false;
  const stallWatchRef = useRef(0);
  const armStallWatch = useCallback(() => {
    window.clearTimeout(stallWatchRef.current);
    if (!playingRef.current) return;
    const beat = 1000 / Math.max(1, getState().project.fps || 30);
    stallWatchRef.current = window.setTimeout(() => {
      if (!playingRef.current || stalledRef.current || !lastFrameAtRef.current) return;
      stallCountRef.current++;
      stalledRef.current = true;
      setMediaStalled(true);
      void frontStage()?.setPlaying(false).catch(() => {});
    }, beat + MEDIA_STALL_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(stallWatchRef.current), []);

  /*
   * Delivery of stream plane / suppression / snapshots (C4, C5, A3c; scheduling is in `snapshotFeed.ts`).
   *
   * Called: after each `frame` is received per beat (while playing), after `setTime` is sent (paused /
   * dragging), before playback starts, after the stage reports `settled`, after the project changes,
   * and after snapshot bytes / newly ready layers arrive. The 33 ms throttle lives in
   * `deliverSnapshots`, so it is safe to call this several times.
   */
  const dualRef = useRef(dual);
  dualRef.current = dual;
  const liveRef = useRef(live);
  liveRef.current = live;
  /** The suppression set last sent (compared as one joined string, to skip sending when unchanged) */
  const suppressedRef = useRef("");
  /** The stream plane last sent (R8; also compared as a string) */
  const streamPlanesRef = useRef("[]");
  const syncPlanes = useCallback((s: StageRpcClient, head: { project: ReturnType<typeof getState>["project"]; t: number; playing: boolean; single: boolean; sparseOnly: boolean }) => {
    const planes = streamPlanesAt(head);
    const planesKey = JSON.stringify(planes);
    if (planesKey !== streamPlanesRef.current) {
      streamPlanesRef.current = planesKey;
      void s.setStreamPlanes(planes).catch(() => {});
    }
    const want = (!head.playing && head.single ? suppressedAt({ ...head, playing: true }) : suppressedAt(head)).join("|");
    if (want !== suppressedRef.current) {
      suppressedRef.current = want;
      void s.setSuppressed(want ? want.split("|") : []).catch(() => {});
    }
  }, []);
  /** `at`: instead of the store's current playhead, deliver once for the given time and play state (before playback starts: at the start second, treated as playing) */
  const pumpFeed = useCallback(async (at?: { t: number; playing: boolean }) => {
    if (!liveRef.current) return;
    const s = frontStage();
    if (!s) return;
    const head = { project: getState().project, t: at?.t ?? tRef.current, playing: at?.playing ?? playingRef.current, single: false, sparseOnly: false };
    if (head.playing) clearSettled("front", "playing");
    /*
     * The second paused-state path (swap after the background stage re-runs the whole scene) is running:
     * this time suppression and the stream plane are left alone. At the swap step the new visible stage
     * is already an exact live render, while "the whole stage is exact" (`markAllSettled`) is only
     * recorded a few replies later. Resending in between as "not yet exact" would overwrite the new
     * visible stage with the stream plane.
     * If the user drags again meanwhile, `sendSetTime` still sends as usual (it does not go through here).
     */
    const holdForSwap = !head.playing && !head.single && swapInFlight();
    if (!holdForSwap) syncPlanes(s, head);
  }, [syncPlanes]);
  const pumpRef = useRef(pumpFeed);
  pumpRef.current = pumpFeed;

  /*
   * The ready index of C3: the SSE connection from the page directly to the prerender process
   * (`snapshotSource.ts`).
   *
   * **Edits do not reconnect or clear the table** (root cause E): each time the project changes, this
   * only checks the session (the mirror may have just started, or the project was switched), and does
   * nothing for the same session.
   * Split into two: the session check runs with `project`, and the teardown only runs when `dual`
   * changes / on unmount.
   */
  useEffect(() => {
    if (!dual) return;
    syncSnapshotSubscription(() => { void pumpRef.current(); });
  }, [dual, project]);
  useEffect(() => {
    if (!dual) return;
    return () => stopSnapshotFeed();
  }, [dual]);

  /*
   * The preview zoom factor changed, sent to both stages (placeholders compensate accordingly: the
   * hourglass keeps its original size on screen).
   * Sent once more at handshake (see the `pc-stage-ready` part).
   */
  useEffect(() => {
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (c) void c.setViewScale(scale).catch(() => { /* The iframe is being replaced: the next handshake will resend */ });
    }
  }, [scale]);
  useEffect(() => {
    if (!onlineBrowserMode()) return;
    const refresh = () => {
      // planDispatch recomputes currentPlan with queueMicrotask within the same batch of notifications; redeliver the stream plane and suppression set once after it,
      // so synced user cards that have just become ready are unsuppressed on the spot (no need to wait for the user to click play or drag the timeline)
      queueMicrotask(() => { void pumpRef.current(); });
    };
    const offSynced = onSyncedUserCardsChanged(refresh);
    const offRun = onCardRunStatesChanged(refresh);
    return () => { offSynced(); offRun(); };
  }, []);

  /* The iframe was replaced: that delivery baseline is void, and the next one carries `reset` (A3c) */
  useEffect(() => {
    if (!live || !stageReady) return;
    markBaselineReset("front");
    suppressedRef.current = "";
    // The stream plane is also sent while paused: after a stage swap, this record likewise starts from zero (the new stage has none)
    streamPlanesRef.current = "[]";
    /*
     * Online page: the small-size prerender is often fetched before the stage handshake (when fetched, `frontStage()` is still empty, and that delivery falls through).
     * A paused page has no other event that would deliver afterwards, so heavy cards stay as placeholders forever --- deliver once as soon as the stage handshakes (measured in c10a-demo-probe).
     */
  }, [live, stageReady]);
  /*
   * The project changed (the store swapped in a new project object): recompute the stream plane and suppression for the new project once. A stream of a card that depends on lower layers is only valid for the version of the lower layers at the time it was produced ---
   * once a lower layer changes, the input signature carried by that layer no longer matches (`streamLayers` in `snapshotFeed.ts`), and the old stream must be withdrawn on the spot, not wait for the next `setTime`:
   * when paused with the hand held still on the ruler, after a lower layer is edited no other event will come to deliver. While playing, the next beat delivers by itself, so one extra delivery here does no harm; unchanged ones are not resent
   * (`syncPlanes` compares by content, and the snapshot half has a 33 ms throttle).
   */
  useEffect(() => {
    if (!live || !stageReady) return;
    void pumpRef.current();
  }, [live, stageReady, project]);

  /*
   * K5 (4) role swap. **A / B are only instance names**; which one is `front` is decided by this
   * state: A starts as front, and after a swap it flips. Two things must be done in **one React
   * commit**: swap the visibility of the two iframes, and switch the "current front" pointer over
   * (the `stageBridge` registration).
   *
   * The background one can only be hidden with `opacity: 0; pointer-events: none`: `display: none` /
   * `visibility: hidden` takes the whole OOPIF out of the render tree, `requestVideoFrameCallback`
   * stops firing, and the `mediaReady` of K5 (3) can only wait until it times out (see the note on
   * K5 (4)).
   */
  const [frontId, setFrontId] = useState<StageId>("A");
  const frontIdRef = useRef<StageId>("A");
  frontIdRef.current = frontId;
  const swapRoles = useCallback(() => {
    const cur = frontIdRef.current;
    const nextId: StageId = cur === "A" ? "B" : "A";
    const nextFront = rpcRef.current[nextId];
    if (!nextFront) return null;
    const nextBack = rpcRef.current[cur];
    frontIdRef.current = nextId;
    flushSync(() => setFrontId(nextId));
    /*
     * The baseline follows the client (root cause A): the new front holds the copy that was loaded when
     * the catch-up run started, **not** the latest project right now. Before, this did
     * `markPushed(role, getState().project)`, so edits made during the catch-up run (deleting a clip)
     * could never be made up; now `swapAndDress` pushes `syncProject` once more after the swap and
     * computes the delta against the copy it actually holds.
     */
    swapStageClients({ client: nextFront, caps: hostCapsRef.current[nextId] }, { client: nextBack, caps: hostCapsRef.current[cur] });
    // The new front's suppressed set and stream plane both start from zero (when swapping while paused, the old front still holds the stream plane and the new front has none)
    suppressedRef.current = "";
    streamPlanesRef.current = "[]";
    return { front: nextFront, back: nextBack };
  }, []);
  /* Falling back to a single stage (handshake failed): the visible stage returns to A (B is already unmounted) */
  useEffect(() => {
    if (!dual && frontIdRef.current !== "A") { frontIdRef.current = "A"; setFrontId("A"); }
  }, [dual]);
  /*
   * C10 contract section 2, "Placement and pacing of the background stage": for the online dual stage,
   * this page decides when the background work is idle (page visible, rAF interval not persistently
   * above 500 ms, parent page rIC calling back), and sends start / stop through RPC. The desktop app
   * runtime does not send it (unchanged).
   */
  useEffect(() => {
    if (!dual) return;
    setSwapHost({
      swapRoles,
      // The 2D preview **does not add proxy=1** (see the comment on the iframe below), so what is resent after a swap is false too
      proxy: () => false,
      // A1 tier switch: the stage's VideoTrack / pixel map assets pick their tier by it (T1a review #5); see LOCAL_HASHES for the source
      localHashes: () => [...tierHashes()],
      // With only one stage, after pausing it does not go through the background stage to catch up the live render (with the dual stage this cannot be a single stage, this is just a safety net)
      singleStage: () => false,
    });
    return () => setSwapHost(null);
  }, [dual, swapRoles]);

  /** For which cards this round of playback has already started a swap (do not send it on every tick) */
  const swapTriedRef = useRef(new Set<string>());

  /* Observation port for the acceptance-check probe: state on the parent page side (which iframe is front, whether the assets are frozen, which step it downgraded to) */
  useEffect(() => {
    if (!live) return;
    const w = window as unknown as { __pcPreviewDiag?: () => unknown };
    w.__pcPreviewDiag = () => ({
      frontId: frontIdRef.current,
      mediaStalled: stalledRef.current,
      // K4 / pinned architecture 10: how many stalls were detected in this round of playback (normal playback should be 0)
      mediaStallCount: stallCountRef.current,
      mediaGapMaxMs: gapMaxRef.current,
      suppressed: suppressedRef.current ? suppressedRef.current.split("|") : [],
      // The last stream plane sent to the visible stage (also set on pause / drag)
      streamPlanes: streamPlanesRef.current,
      pendingDemote: [...pendingDemotes()],
      demoted: [...demotedClips()],
      swapInFlight: swapInFlight(),
      swapLog: stageSwapDebug(),
      swapTrace: stageSwapTrace(),
      // Decision to start a swap in the playing state (whole-scene time estimate / cannot catch up means no start), and the count of yields when stopping
      swapPlaying: stageSwapPlayingDebug(),
      setTimeLog: setTimeLogRef.current.slice(),
      setTimeError: setTimeErrorRef.current,
      tier: null,
      single: false,
      lowest: false,
      lastSettle: settleResultRef.current,
      dual: dualRef.current,
      onlineStages: null,
      cardExec: null,
      handover: null,
      beatSwap: beatSwapDebug(),
      backWork: null,
      probeFrames: probeFrameDiag(),
      probeRun: probeRunDiag(),
      measureGate: measureGateDiag(),
      hostCaps: { ...hostCapsRef.current },
      snapshotFeed: snapshotFeedDebug({ project: getState().project, t: tRef.current, playing: playingRef.current, single: false, sparseOnly: false }),
    });
    return () => { delete w.__pcPreviewDiag; };
  }, [live]);

  /*
   * Dispatch of stage events (the seven of E0; source filtering is already done by role in
   * stageBridge).
   *
   * The listener is registered only once, so everything read inside is always a ref / store, never
   * state from the closure.
   */
  useEffect(() => onStageEvent((e) => {
    switch (e.type) {
      case "frame": {
        // K4: the visible stage reports t once after each tick it finishes rendering, and the playhead follows it (the Preview rAF loop does not start then)
        const now = performance.now();
        const prev = lastFrameAtRef.current;
        lastFrameAtRef.current = now;
        armStallWatch();
        if (!firstBeatRef.current && playingRef.current) { firstBeatRef.current = true; setFirstBeatSeen((n) => n + 1); }
        actions.tick(e.sec);
        // The suppressed set and snapshots of this tick (C5: during playback send setSuppressed(H(t)) + setSnapshots)
        void pumpRef.current();
        /*
         * Light cards with `vtOk = false` from K3(b): when the playhead has just entered one, the whole scene
         * is caught up in the background and then swapped.
         * Each card starts only once per round of playback: a catch-up run takes a few hundred
         * milliseconds, and sending one every tick would only make them pin each other down.
         * Only for cards that playback starts in the middle of: those that this round of playback walks
         * through the mount frame tick by tick and enters naturally do not start (`playingSwapTargets`).
         * Record the tick number first (consecutive, repeated or broken), then compute the target.
         */
        notePlayFrame(e.sec);
        // Only the dual stage has a background stage to swap with
        if (dualRef.current && !swapInFlight()) {
          const targets = playingSwapTargets(getState().project, e.sec).filter((id) => !swapTriedRef.current.has(id));
          if (targets.length) {
            for (const id of targets) swapTriedRef.current.add(id);
            void runPlayingSwap(targets);
          }
        }
        if (!prev) break;
        // How much slower than the nominal duration of one tick (see the comment above MEDIA_STALL_MS)
        const overBeat = now - prev - 1000 / Math.max(1, getState().project.fps || 30);
        if (overBeat > gapMaxRef.current) gapMaxRef.current = overBeat;
        const stalled = overBeat > MEDIA_STALL_MS;
        if (stalled === stalledRef.current) break;
        if (stalled) stallCountRef.current++;
        stalledRef.current = stalled;
        setMediaStalled(stalled);
        // The stage-side media layer is frozen / released in sync; the audio of the main document is managed by the playing prop of MediaLayers
        void frontStage()?.setPlaying(!stalled && playingRef.current).catch(() => {});
        break;
      }
      case "ended":
        /*
         * K4 playback reached the end: write the store (`pause()` + `seek(duration)`). The remaining three
         * steps (`setPlaying(false)`, `pause()` to get `stoppedAt`,
         * `setTime(stoppedAt, { settle: true })`) are **the same wrap-up as pressing pause**: after
         * `playing` flips to false, the effect below does it uniformly. Without the last step, the heavy
         * cards of the last frame would stay in the suppressed state forever (pinned architecture 9).
         */
        actions.pause();
        actions.seek(e.sec);
        break;
      case "settled": {
        /*
         * After the stage catches up, it removes the suppression of these cards by itself (in the same commit
         * as revealing the live component, `releaseSettled` of `StageView`): the "last sent suppressed set"
         * recorded by the parent page is no longer trustworthy, and the next send resends it as things stand.
         * The entry for a swap that became official (`clipIds` empty) is not handled here: there
         * `swapRoles` clears the record and `markAllSettled` marks the whole stage as exact.
         */
        const named = e.clipIds.length > 0;
        if (named) suppressedRef.current = "\u0000";
        // Only the second of this stop counts: late ones (the user dragged away again, and the stage already put them back into suppression in the new jump) do not count as exact.
        // Cards attached to the stream compare against the store's current playhead (`tRef` only updates on the next render, so right after a pause it lags one step)
        const stale = named && Math.abs(e.sec - getState().t) > 1e-6;
        if (stale) {
          if (named) void pumpRef.current();
          break;
        }
        // K5: live render ready in the paused state: remove these cards from the delivery baseline (A3c), and the flat stage removed them by itself
        noteSettled("front", e.clipIds);
        if (named) void pumpRef.current();
        break;
      }
      case "demote":
        // K6: this card is downgraded, and the parent page PUTs the whole record { ...old record, capped: true, demoted: true }
        void onStageDemote(e.clipId);
        break;
      case "probe":
      case "probe-frame":
        // K1 (R4): the probe's results and the dead assets it incidentally derived (consumed in probeRunner)
        break;
      case "mediaReady":
        // K5 step (4): the background stage's media layer drew a frame (consumed in catchUp.ts, which subscribes by itself)
        break;
    }
  }), []);

  /**
   * Outer frame for the selection outline: do not use the wrapper layer (every card fills the whole
   * screen), use the clip's entity extent: the outline of a captions card hugs the captions
   * themselves instead of going around the screen. An old render surface without bounds falls back to
   * the wrapper layer.
   */
  /*
   * R7 (D3 step 4 / D5): the `mediaRects` of the main document has been removed.
   *
   * Media clips are now drawn by the stage itself (E7 item 1, landed in R3), and `data-pc-clip` is
   * written on the displayed video slot and image layer, so the stage's `rects()` / `hitTest` already
   * recognize them: adding another copy in the main document would make the same clipId appear twice,
   * and a hit would pick the wrong one. Hit testing and entity frames **all go through the stage's**
   * `hitTest` / `rectsWithBounds`.
   */

  /**
   * One round trip fetches the outer frames + entity extents of all active clips (rectsWithBounds,
   * which merged the N+1 of the former rects() followed by bounds() one by one).
   * The heartbeat only carries pixels: 'selected': only the selected card has its canvas pixels
   * scanned (the selection outline does not fall back to the whole canvas); unselected cards use the
   * element rectangle: their frames only go into the rects list and no outline is drawn. 'all' is
   * used only at the moment of a user click.
   * When replies arrive out of order, the old one must not overwrite the new one, guarded by a
   * generation counter.
   */
  const rectsGen = useRef(0);
  const refreshRects = useCallback(async (pixels: "selected" | "all" = "selected") => {
    const s = stage();
    const gen = ++rectsGen.current;
    let cards: { clipId: string; left: number; top: number; width: number; height: number }[] = [];
    if (s) {
      try {
        const list = await s.rectsWithBounds(pixels === "selected" ? { pixels, clipIds: selectionRef.current } : { pixels });
        cards = list.map((r) => ({ clipId: r.clipId, ...(r.bounds ?? r.rect) }));
      } catch {
        // The iframe is being swapped (detached): this round is void, and the new ready will refresh once more
        return;
      }
    }
    if (gen !== rectsGen.current) return;
    // R7: media clips are in the stage now too (E7 item 1), and `rectsWithBounds` brings back both cards and media clips in one go
    setRects(cards);
  }, [stage]);

  /** The clip just clicked: the outline flashes so the user can see clearly which one was hit */
  const [flash, setFlash] = useState<{ clipId: string; token: number } | null>(null);
  const flashClip = (clipId: string) => setFlash({ clipId, token: Date.now() });

  /**
   * Entity hit: ask the render surface which clip the first "drawn" element, from the top layer
   * down, at this point belongs to. Transparent containers are passed through: a captions card on the
   * top layer does not block the cards below. An old render surface without hitTest falls back to
   * finding the topmost one by wrapper layer outer frame.
   */
  const hitAt = async (e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const s = stage();
    /*
     * R7: cards and media clips are all in the stage, and one `hitTest` round trip is the final answer
     * (D3). The main document falls back to the previous round's `rects` only when there is **no stage
     * at all** (handshake not done yet / iframe being swapped).
     */
    let card: { clipId: string; left: number; top: number; width: number; height: number } | null = null;
    if (s) {
      try { card = await s.hitTest(x, y); } catch { card = null; }
    }
    const inside = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    const hit = card ?? (s ? null : [...rects].reverse().find(inside)) ?? null;
    return { hit, overlayRect: rect };
  };

  // Send the project document when it changes: through stageBridge only the changed clips are sent (two-level diff), and the whole copy + reset when there is no baseline
  useEffect(() => {
    if (!stageReady) return;
    void syncProject("front", project).then(() => refreshRects(), () => {});
  }, [stageReady, project, refreshRects]);

  // Send down when time changes. During playback it advances continuously; dragging the playhead / jump / replay (playToken changes) are all handled as a jump:
  // remount + catch up from the in-point to that moment. Both are merged in one effect, so one seek renders only one frame.
  /*
   * Only recognize "time really changed": the references of the stage / refreshRects callbacks change
   * along with the project and zoom. Before, this effect reran whenever they changed, so every time the
   * Agent wrote the project there was an extra jump render: remount the active cards and catch up
   * frame by frame from the in-point to the playhead, measured at 230~350 ms of main thread each time
   * with the playhead at 60 seconds. Whether a project change needs a catch-up run is already judged
   * by setProject (StageView) by "which card changed, and whether it is on screen".
   */
  /*
   * E0: pause and drag only send setTime (no remount, no playToken increment: the clock is moved over,
   * React commits, animations are pinned); the parent page **no longer** sends render(jump) to the
   * visible stage.
   *
   * **E6: this effect is split into two halves.** The half that sends `setTime(t)` **does not run
   * during playback** (K4 is advanced by the stage itself on its frame ticks, and the parent page
   * sending it too would be two people fighting over the steering wheel); the `refreshRects()` half
   * becomes a timer that fires every 500 ms during playback (see the effect below), and stale results
   * are discarded by request number (`rectsGen` in `refreshRects`).
   * Sync the project first and then move the time; the order of the two RPCs must not be reversed
   * (setTime needs to compute the active cards on the new project).
   */
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  /*
   * In dual stage mode the page triggers the prerender (shared hook; the legacy path uses the same one
   * in `UnifiedPreview`): when an edit push succeeds (`frameRequest` does `alignMirror` first) and it
   * is idle (not playing, not dragging), send `preload` with debounce, and keep asking if it is not ready.
   */
  usePrerenderPreload(project, { enabled: dual, idle: !playing && !scrubbing, waitForProbe: true });
  /** Diagnostics: the last few setTime calls and the last failure (for the probe to investigate why the live render was not caught up after pausing) */
  const setTimeLogRef = useRef<{ at: number; sec: number; settle: boolean }[]>([]);
  const setTimeErrorRef = useRef<{ at: number; sec: number; error: string } | null>(null);
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const lastRenderKey = useRef("");
  /**
   * Move the time of the visible stage once. **The only entry for pause and drag** (playback goes
   * through K4).
   *
   * `settle: true` starts the paused-state live render of K5: clicking the timeline, releasing a drag,
   * pressing pause, and playback reaching the end all carry it, and
   * **it is not carried during a drag** (E3).
   */
  /**
   * Generation of the `setTime` sent to the visible stage (+1 on each send). The single stage's
   * stop-and-catch-up-one-frame dedupes by "the latest setTime right now + the second": at the moment
   * of pausing, the parent page sends setTime several times in a row (the pause, and the t rewritten
   * by the stage's last tick), and each one's catch-up of one frame may be sent only after the last
   * setTime; two catch-ups of one frame at the same second run concurrently in the stage, and the
   * later one would interrupt the layers the earlier one had drawn into "not drawn", and the drawn
   * layers would go back to suppression (measured by the single-stage online probe G3).
   */
  const setTimeEpochRef = useRef(0);
  const settleKeyRef = useRef<string | null>(null);
  const sendSetTime = useCallback(async (sec: number, opts: { settle?: true } = {}) => {
    setTimeLogRef.current.push({ at: Math.round(performance.now()), sec, settle: !!opts.settle });
    if (setTimeLogRef.current.length > 12) setTimeLogRef.current.shift();
    const s = stage();
    if (!s) return;
    try {
      await syncProject("front", getState().project);
      if (liveRef.current) {
        clearSettled("front", `setTime ${sec}`);
        syncPlanes(s, { project: getState().project, t: sec, playing: false, single: false, sparseOnly: false });
      }
      setTimeEpochRef.current++;
      await s.setTime(sec, opts);
    } catch (e) {
      // The iframe is being swapped (detached): the new ready will resend
      setTimeErrorRef.current = { at: Math.round(performance.now()), sec, error: String((e as Error)?.message ?? e).slice(0, 120) };
      markBaselineReset("front");
      return;
    }
    void refreshRects();
    void pumpRef.current();
    /*
     * K5 second path: as long as at this moment there is a card judged heavy with `vtOk = false`, make the
     * background stage catch up the whole scene and, once done, swap into an exact live render. Those
     * with `vtOk` already catch up by themselves in the visible stage (K5 first path, stage side).
     */
    // Deliver once more after the swap is done: the new visible stage holds no stream plane, so first decode the frame under the playhead (during the swap `pumpFeed` does not touch the stream plane)
    if (dualRef.current && opts.settle) void runSettleSwap(sec).then((swapped) => { if (swapped) void pumpRef.current(); }, () => { /* The background stage is being swapped: the next setTime will start over */ });
  }, [stage, refreshRects, syncPlanes]);
  const settleResultRef = useRef<(SettleResult & { at: number }) | null>(null);
  void settleKeyRef;
  /** The start / stop tick of K4 only recognizes `playing`, so that effect reads this copy and does not put `sendSetTime` in its dependencies */
  const sendSetTimeRef = useRef(sendSetTime);
  sendSetTimeRef.current = sendSetTime;
  /** The `playing` this effect saw last time: the "just flipped from playing to paused" occasion must be left to the wrap-up effect */
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (!stageReady) return;
    // K4: during playback the playhead is driven by the stage's `frame`, and the parent page sends nothing on any tick
    if (live && playing) { wasPlayingRef.current = true; return; }
    /*
     * **The occasion of just pausing is not sent here** (E0 / R5-4). The wrap-up is the job of the effect
     * below, which sends by the `stoppedAt` in the `pause()` reply; here we only have `store.t`, which
     * may lag the stage by one tick, and rushing to send once would take the backward-jump path (remount
     * of all stateful cards in the whole scene, a flash of `.pc-settling`), and would also start the
     * catch-up / swap of K5 in vain. Playback reaching the end (`ended`) goes through the same path.
     */
    const justPaused = live && wasPlayingRef.current;
    wasPlayingRef.current = false;
    if (justPaused) return;
    /*
     * **`scrubbing` also goes into the key** (E3 / pinned architecture 9). On releasing a drag or
     * clicking once on the timeline, `t` may not have changed at all (the release coordinate equals the
     * position of the last flush; on a click, `seek` and `beginScrub` are batched into one render in the
     * same React event, and `scrubbing` is already true at that render).
     * Without this bit in the key, after a drag / click ends the `settle: true` one is never made up,
     * and the cards judged heavy stay on the snapshot: exactly the "after clicking the timeline or
     * releasing a drag, the live render is not exact" case.
     * Under legacy `dual` is false and the suffix is constant, so nothing extra is sent.
     */
    const key = `${stageReady}|${t}|${playToken}|${live && scrubbing ? "scrub" : "settle"}`;
    if (key === lastRenderKey.current) return;
    lastRenderKey.current = key;
    // The single stage carries settle too: on stop, catch up the current frame layer by layer; not carried during a drag
    void sendSetTime(t, live && !scrubbingRef.current ? { settle: true } : {});
  }, [stageReady, live, playing, t, playToken, scrubbing, sendSetTime]);

  /*
   * After a sync card's run state becomes ready, or measurement results arrive and the dispatch table
   * is recomputed, the stopped stage redelivers the suppression and settles the current frame:
   * when a project has just been opened the sync card is not ready yet, so the first
   * setTime(t, { settle: true }) records it into the suppression per localOnly (showing an hourglass),
   * and swapTrace only records that one unmeasured occasion; after that the card becomes ready and
   * measurement completes, and if settling is not triggered again while paused it stays on the hourglass forever.
   */
  useEffect(() => {
    if (!live) return;
    let queued = false;
    const settlePaused = () => {
      queued = false;
      if (!liveRef.current || !stageReadyRef.current || playingRef.current || scrubbingRef.current) return;
      void sendPlanTo("front");
      void pumpRef.current();
      if (!probeProgress().running) {
        void sendSetTimeRef.current(tRef.current, { settle: true });
      }
    };
    const trigger = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(settlePaused);
    };
    const offPlan = onPlanUpdated(trigger);
    const offRunStates = onCardRunStatesChanged(trigger);
    let wasRunning = probeProgress().running;
    const offProbe = onProbeProgress((p) => {
      const finished = wasRunning && !p.running;
      wasRunning = p.running;
      if (finished) trigger();
    });
    return () => { offPlan(); offRunStates(); offProbe(); };
  }, [live]);

  /* E6: during playback `refreshRects` becomes a timer, one round trip, and stale results are discarded by sequence number */
  useEffect(() => {
    if (!live || !stageReady || !playing) return;
    const id = window.setInterval(() => { void refreshRects(); }, RECTS_POLL_MS);
    return () => window.clearInterval(id);
  }, [live, stageReady, playing, refreshRects]);

  /*
   * Parent-page side of K4: when `playing` flips to true, call `play(t)` to start the tick loop; when it
   * flips to false, run the wrap-up
   * (`setPlaying(false)` → `pause()` to get `stoppedAt` → `setTime(stoppedAt, { settle: true })`).
   *
   * **Use the `t` of the stage's last tick, not `store.t`** (E0): the store's `t` can lag the stage by
   * one tick, and sending it would take the backward-jump path and remount every stateful card.
   * Reaching the end of playback (`ended`) goes through the same code: that side only writes the store,
   * and after `playing` flips to false it lands here.
   *
   * For the start position see `playStartOf`: if the playhead is outside the content range, go back to
   * the earliest card (the same rule as the legacy loop).
   */
  /**
   * The second from which this playback run starts. It is word for word the same rule as the legacy
   * wall-clock loop (`:155-158`): if the playhead is before the first card, or has already reached the
   * end, replay from the earliest card.
   *
   * After R7 made the stage the default, this rule was missed: pressing play after reaching the end hit
   * `rawSec >= duration` on the stage's first tick and posted `ended` immediately, so pressing play did
   * nothing (the R7-11 regression).
   */
  const playStartOf = useCallback((): number => {
    const project = getState().project;
    const fps = Math.max(1, project.fps || 30);
    const start = contentStartRef.current;
    const from = tRef.current;
    if (from >= start && from < project.duration - 0.5 / fps) return from;
    // The store must also go back to the start: the timeline, the media layer and the settle after `ended` all follow store.t
    actions.seek(start);
    return start;
  }, []);
  useEffect(() => {
    if (!live || !stageReady) return;
    let alive = true;
    const s = stage();
    if (!s) return;
    if (playing) {
      playedRef.current = true;
      lastFrameAtRef.current = 0;
      stalledRef.current = false;
      stallCountRef.current = 0;
      gapMaxRef.current = 0;
      setMediaStalled(false);
      swapTriedRef.current = new Set();
      void (async () => {
        try {
          /*
           * **First wait for the project to reach this stage, then start the tick loop.**
           *
           * After a new iframe handshake `stageReady` is incremented; the effect above sends `syncProject` and
           * this one sends `play`. But `syncProject` goes through stageBridge's serial chain (`chain.then`), so
           * the real postMessage is one microtask later, while `play` is sent synchronously. So when "swapping
           * the iframe while `playing`" (switching back to 2D, stage hot reload), the stage receives `play`
           * first, has no project yet and replies `no-project`; there is no retry here, so the button shows
           * "Pause" and the picture does not move.
           * Chaining on the same line and waiting for it to settle pins the order down. When the baseline is
           * unchanged `syncProject` sends nothing, so there is no extra round trip.
           */
          await syncProject("front", getState().project);
          if (!alive) return;
          const from = playStartOf();
          // Start of this playback run: cards already mounted at the moment playback starts count as "starting mid-way", and those mounted tick by tick afterwards count as natural entrances (the playing-state swap only applies to the former)
          notePlayRunStart(from);
          /*
           * Before playback starts, set up this second's stream plane, suppression and snapshots first (before,
           * this was sent only when the first tick's `frame` arrived: heavy cards on the first tick are live
           * rendered, which is slow and can fail to join up with the stream).
           * While paused the stage has already decoded the frame under the playhead; once suppressed here, the
           * first tick shows the stream's picture. If the stream has not drawn yet, the stage does not hide its
           * original picture first.
           * Do not wait for replies: the several messages arrive in the order they were sent, before the `play` below.
           */
          void pumpRef.current({ t: from, playing: true });
          const reply = await s.play(from);
          if (!alive) return;
          // The first tick's arrival interval starts from the moment the `play()` reply arrives (K4)
          if (reply.ok) { lastFrameAtRef.current = performance.now(); armStallWatch(); }
          /*
           * The stage says it cannot start (no project, wrong role): **flip the store back to paused too**, so
           * the UI does not stay stuck on "playing".
           * After flipping back, the branch below wraps up as usual (`pause()` to get `stoppedAt` →
           * `setTime(settle)`), aligning the picture and playhead to the frame the stage is really stopped on;
           * when the user presses play again it is a clean start.
           */
          else if (getState().playing) actions.pause();
        } catch { /* The iframe is being swapped: the new handshake will rerun this effect with playing */ }
      })();
    } else {
      void (async () => {
        // **Clear lastRenderKey synchronously at the one place that sends pause()** (E6), otherwise the next setTime is swallowed by dedup
        lastRenderKey.current = "";
        window.clearTimeout(stallWatchRef.current);
        stalledRef.current = false;
        setMediaStalled(false);
        let stoppedAt = tRef.current;
        /*
         * Only when "just stopped from playing" is the stage's `stoppedAt` authoritative. A new render surface
         * swapped in while paused (`stageReady` +1: the whole stage page reloads after card code is installed,
         * hot update, iframe remount) also reaches this branch: the new stage is still at 0, and updating the
         * store from it would wash the user-set playhead back to 0 (C6.6 T9: after a member joined a shared
         * project and installed a user card, the playhead went from 2.5 s back to 0).
         * In that case the store's `t` is authoritative, and it is only sent to the new stage.
         */
        const fromPlay = playedRef.current;
        playedRef.current = false;
        try {
          const reply = await s.pause();
          if (fromPlay && reply.ok && typeof reply.stoppedAt === "number") stoppedAt = reply.stoppedAt;
        } catch { /* The iframe is being swapped */ }
        if (!alive) return;
        if (Math.abs(getState().t - stoppedAt) > 1e-6) actions.tick(stoppedAt);
        await sendSetTimeRef.current(stoppedAt, { settle: true });
      })();
    }
    return () => { alive = false; };
    /*
     * **Only three dependencies.** `t` changes every tick, and the identities of `stage` / `sendSetTime`
     * change along with it: if they were in the dependencies this effect would rerun every tick, stopping
     * and restarting the tick loop just started during playback, and while paused the branch's
     * `actions.tick(stoppedAt)` would trigger itself again (infinite updates).
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, stageReady, playing]);

  /*
   * R3's minimal wiring: outside legacy the media layer lives **in the stage** (E7 item 1), and it needs
   * three things to run: `mediaT` (which moment to follow), `scrubbing` (seek more sparsely) and
   * `playing` (only drives the media layer, does not touch K4's tick loop).
   *
   * **Send to both stages** (E3: "media layer `mediaT = t`, same for both roles"): before K5's second
   * swap, the media of `back` must already be at the target tick, otherwise after the swap the drift
   * exceeds `HARD_SEEK_SEC` and a hard seek must be paid.
   * Under legacy none of these is sent: there the media layer is still in the main document.
   *
   * `playing` carries `mediaStalled` (K4): the stage's media layer is paused and resumed together with
   * the main document's audio.
   */
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setScrubbing(scrubbing).catch(() => {});
      void c.setPlaying(playing && !mediaStalled).catch(() => {});
    }
  }, [live, stageReady, scrubbing, playing, mediaStalled]);
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setMediaT(t).catch(() => {});
    }
  }, [live, stageReady, t]);
  // C6.6: when the tier-switch set changes, send it to both stages (E3: media layer is the same for both roles)
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setLocalHashes([...tierList]).catch(() => {});
    }
  }, [live, stageReady, tierList]);

  // Both the picture layer and the sound layer are managed by MediaLayers: several pictures can be present at once (overlap + fade = crossfade), and audio clips sound on their own

  // Hit-test and drag logic
  /**
   * A hit is an async round trip (the stage is in an iframe), but **the start point must not be lost**:
   * on pointerdown, synchronously capture the pointer and record the start point first, then await
   * hitTest; pointermove / pointerup events arriving during the await accumulate first, and once the hit
   * result returns we decide whether to select or start dragging.
   * The first few move events of "click the canvas and drag at once" are not missed, and releasing
   * before the reply arrives will not leave a state that drags forever.
   */
  const handleOverlayPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const overlay = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    if (framed && !isFramedFitted(camRef.current, project, boxSize ?? { width: project.width, height: project.height })) {
      // While zoomed in framed mode, dragging >= 4px pans on `boxRef`; do not steal pointer capture or fire selection on a pan drag.
      const panned = await new Promise<boolean>((resolve) => {
        const cleanup = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onEnd);
          window.removeEventListener("pointercancel", onEnd);
        };
        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 4) { cleanup(); resolve(true); }
        };
        const onEnd = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          cleanup();
          resolve(Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 4);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onEnd);
        window.addEventListener("pointercancel", onEnd);
      });
      if (panned) return;
    } else {
      try { overlay.setPointerCapture(pointerId); } catch { /* The pointer is already gone, but the hit can still be computed */ }
    }

    // Events during the await are recorded first
    let lastX = startX;
    let lastY = startY;
    let released = false;
    const onEarlyMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) { lastX = ev.clientX; lastY = ev.clientY; } };
    const onEarlyUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) released = true; };
    window.addEventListener("pointermove", onEarlyMove);
    window.addEventListener("pointerup", onEarlyUp);
    window.addEventListener("pointercancel", onEarlyUp);

    const { hit: targetRect } = await hitAt({ clientX: startX, clientY: startY, currentTarget: overlay });

    window.removeEventListener("pointermove", onEarlyMove);
    window.removeEventListener("pointerup", onEarlyUp);
    window.removeEventListener("pointercancel", onEarlyUp);

    const release = () => { try { if (overlay.hasPointerCapture(pointerId)) overlay.releasePointerCapture(pointerId); } catch { /* Already released */ } };

    if (tool === "select") {
      release();
      // Select tool: clicking an entity selects it and flashes its outline; clicking blank space (or nothing under a transparent area) deselects
      if (targetRect) {
        actions.select([targetRect.clipId]);
        flashClip(targetRect.clipId);
        // Use 'all' for this click: the outline of a newly selected canvas card follows the pixel box, and does not fall back to the whole canvas
        void refreshRects("all");
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // Move tool: press to start dragging, update the local drag state while moving, and only write to the store on release to record undo
      if (!targetRect) { release(); return; }
      actions.select([targetRect.clipId]);
      flashClip(targetRect.clipId);
      const clipId = targetRect.clipId;

      let currentDx = 0;
      let currentDy = 0;
      const applyMove = (cx: number, cy: number) => {
        // The overlay is displayed scaled by scale; convert the displacement back to stage pixels, the same units frame uses
        currentDx = (cx - startX) / scale;
        currentDy = (cy - startY) / scale;
        setDragPreview({ clipId, dx: currentDx, dy: currentDy });
      };
      const onMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) applyMove(ev.clientX, ev.clientY); };
      const onUp = () => {
        setDragPreview(null);
        release();
        if (Math.abs(currentDx) > 0.5 || Math.abs(currentDy) > 0.5) {
          /*
           * Dragging changes the clip's frame (the position box), not the card parameters: cards have no x / y
           * parameters, and writing x / y into params used to change nothing: the outline followed the mouse for
           * a while and then snapped back on release.
           * It goes through nudgeFrame, the same path as the Agent's nudge / set_position: for a card without a
           * frame, first compute the current position as if it filled the stage, then add the displacement; it
           * writes only once on release, so one drag = one undo step.
           */
          const hit = findClip(getState().project, clipId);
          if (hit) {
            const stageSize = { width: getState().project.width, height: getState().project.height };
            actions.setClipFrame(clipId, nudgeFrame({ dx: Math.round(currentDx), dy: Math.round(currentDy) }, hit.clip.frame, stageSize));
          }
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      // If it already moved / was released before the reply arrived, catch up now
      if (lastX !== startX || lastY !== startY) applyMove(lastX, lastY);
      if (released) { onUp(); return; }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    } else {
      release();
    }
  };

  // Text tool logic
  const handleOverlayDoubleClick = async (e: React.MouseEvent) => {
    if (tool !== "text") return;
    const { hit: targetRect, overlayRect: rect } = await hitAt(e);
    if (!targetRect) return;
    flashClip(targetRect.clipId);

    const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
    if (!clip) return;
    const def = getCard(clip.cardId);
    if (!def) return;
    const textControl = def.controls.find((c) => c.type === "text");
    if (!textControl) return;

    const val = (clip.params[textControl.key] as string) ?? def.defaults[textControl.key] ?? "";
    
    // Position the input box at the card's top-left corner (converted from the hit target's rectangle)
    const inputX = targetRect.left * scale + rect.left;
    const inputY = targetRect.top * scale + rect.top;

    setEditingText({
      clipId: clip.id,
      key: textControl.key,
      value: val,
      x: inputX,
      y: inputY,
    });
  };

  const handleOverlayContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { clientX, clientY, currentTarget } = e;
    const { hit: targetRect } = await hitAt({ clientX, clientY, currentTarget });
    if (targetRect) {
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
      if (clip) {
        actions.select([clip.id]);
        flashClip(clip.id);
        setContextMenu({ x: clientX, y: clientY, clipId: clip.id, cardId: clip.cardId });
      }
    }
  };

  const submitTextEdit = () => {
    if (editingText) {
      actions.setClipParams(editingText.clipId, { [editingText.key]: editingText.value }, { merge: true });
    }
    setEditingText(null);
  };

  /** Where in the window the frame's top-left corner should go. Not placed until the window size is measured (that frame passes before paint) */
  const frameXY = boxSize ? frameOrigin(cam, project, boxSize) : null;
  const effectiveBox = boxSize ?? { width: project.width, height: project.height };
  const framedFitted = framed ? isFramedFitted(cam, project, effectiveBox) : true;
  const framedPct = framed ? framedZoomPercent(cam, project, effectiveBox) : 100;

  return (
    <div className={compact ? (framed ? "pc-pv pc-pv--mobile pc-pv--framed" : "pc-pv pc-pv--mobile") : "pc-pv"} data-pc="preview">
      {!compact && <div className="pc-pv-tabs" data-pc="preview-tabs">
        {([["2d", is3DCut ? trText("Camera") : "2D"], ["3d", is3DCut ? trText("Space") : "3D"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-pc-view={is3DCut ? (id === "2d" ? "camera" : "space") : id}
            className={view === id ? "is-on" : undefined}
            onClick={() => setView(id)}
            title={
              id === "2d"
                ? (is3DCut ? trText("Camera view: live output camera frame of this 3D cut") : trText("Final video preview: what you see is what you export"))
                : (is3DCut ? trText("Space view: orbit freely in 3D space with the live output camera frustum") : trText("3D view: orbit around like in Blender to see how these cards are arranged in space"))
            }
          >
            {label}
          </button>
        ))}
      </div>}

      {!show3DScene && !compact && <ToolBar tool={tool} onToolChange={setTool} zoom={cam.scale} fitted={cam.auto} onFit={fitToWindow} />}

      {/*
        * **The 2D page resides permanently under the 3D page; it is only hidden, not unmounted.**
        *
        * Previously it was `view === "3d" ? <3D/> : <2D/>`; switching to 3D unmounted the stage iframe
        * along with the audio layer of the main document. But the playhead **follows the stage**
        * (docs/semantics/product/rendering.md "Playhead follows stage", K4: under non-legacy, only the
        * `frame` event of the visible stage advances `t`): once the stage is gone, pressing play on the
        * 3D page moves nothing and audio is gone too. Now the stage runs continuously, the 3D page still
        * reads the same `t`, and the playback timeline and audio are identical to the 2D page.
        *
        * The only way to hide it is `opacity: 0` + ignoring pointer events (same reason as the background
        * stage; see comments on iframe B): `display: none` stops rAF and `<video>` inside the iframe, while
        * `visibility: hidden` causes `isSolid` to misclassify the entity box. `inert` additionally blocks
        * keyboard focus from falling into the invisible page.
        * The hidden page covers the same area with `inset: 0`; the window size is unchanged, so switching
        * back to 2D requires no zoom re-adaptation.
        */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {show3DScene && (
        <div className="pc-pv-stage" style={{ position: "relative" }}>
          <Scene3DView
            project={project}
            t={t}
            mode={scene3DMode}
            onSelectCamera={(id) => (actions as any).selectCamera?.(id)}
          />
        </div>
      )}
      <div
        ref={boxRef}
        className="pc-pv-stage"
        data-pc="preview-2d"
        data-zoomed={framed && !framedFitted ? "true" : undefined}
        aria-hidden={show3DScene || undefined}
        inert={show3DScene}
        style={show3DScene ? { position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" } : undefined}
      >
        <div
          className="pc-pv-frame pc-checker"
          style={{
            width: project.width * scale,
            height: project.height * scale,
            /*
             * The position is computed entirely by ourselves (see the note at boxSize: relying on the browser's
             * centering becomes inaccurate after zooming in).
             * Absolutely positioned at the top-left corner, then moved to where it should be with transform:
             * transform does not trigger reflow, and it is changed on every frame while dragging, whereas
             * left/top would reflow all the way.
             */
            position: "absolute",
            left: 0,
            top: 0,
            transform: frameXY ? `translate(${frameXY.x}px, ${frameXY.y}px)` : undefined,
            /*
             * The transparent checkerboard has moved to .pc-checker (see preview/preview.css).
             *
             * It used to be written inline here with a different, darker set of values, on the grounds of "color
             * spec item 04: transparent cells must be darker and weaker than the surrounding canvas".
             * That rule is not wrong in itself, but it conflicts with the question this background really has to
             * answer: **is there nothing here?**
             * Once the background is dark, a dark card looks exactly like "nothing drawn": see_frames and the 3D
             * view have both been bitten by this. Also, the 2D and 3D tabs each used their own values, so the same
             * project looked "transparent" differently on the two tabs. So it is unified onto the mid-gray set,
             * aligned value by value with see_frames.
             */
          }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, ...themeStyle(project.themeId) }}>
            <div style={{ position: "relative", width: project.width, height: project.height }}>
              {/* K4's `mediaStalled`: when a stage tick comes more than 40 ms later than its due time, the audio pauses along with it; audio does not start before the first tick of this playback run arrives */}
              <MediaLayers project={project} t={t} playing={playing && !mediaStalled && (!live || firstBeatRef.current)} masterVolume={muted ? 0 : volume} audioOnly localHashes={tierList} />
              {/*
                * Stage iframes are mounted by slot: single stage (`single`, first level of the stage gate, lowest
                * tier, fallback on handshake failure, all are cross-origin A), cross-origin A (`dualA`),
                * cross-origin B (`dualB`), in fixed order, keyed by slot.
                * Online mode always uses cross-origin isolation: when the stage origin cannot be read, it no longer
                * falls back to a same-origin single stage, but simply does not mount the stage iframe
                * (user decision, 2026-10-14); handshake failure falls back to cross-origin single stage A
                * (only applies to the current run, leaving no crash records; `mechanism/platforms.md` "Three gates").
                */}
              {(() => {
                const base = {
                  position: "absolute" as const,
                  inset: 0,
                  width: project.width,
                  height: project.height,
                  border: 0,
                  display: "block",
                  background: "transparent",
                  colorScheme: "normal" as const,
                };
                const hidden = { opacity: 0, pointerEvents: "none" as const };
                const out: React.ReactNode[] = [];
                if (!dual) {
                  out.push(<iframe
                    key="single"
                    ref={frameRefOf.A}
                    data-pc="stage-frame"
                    title={trText("Preview stage")}
                    onLoad={() => onStageFrameLoad("A")}
                    /*
                     * **Do not add proxy=1** here: the 2D preview's contract is "what the preview shows = what the export
                     * gives", and swapping in color blocks during playback breaks it: when the user presses play they
                     * want to see what the final video looks like, not a composition sketch. The proxy lives only in the
                     * 3D view, and only as a transition while the prerender has not caught up.
                     */
                    src={stageSrc("A", { dual: false })}
                    style={{
                      ...base,
                      opacity: live ? 1 : 0,
                    }}
                  />);
                }
                if (dual) {
                  out.push(<iframe
                    key="dualA"
                    ref={frameRefOf.A}
                    data-pc="stage-frame"
                    title={trText("Preview stage")}
                    src={stageSrc("A", { dual: true })}
                    onLoad={() => onStageFrameLoad("A")}
                    style={{
                      ...base,
                      // The background one must also block the pointer: after the K5 swap, A may be the background one
                      ...(live && frontId === "A" ? { opacity: 1 } : hidden),
                    }}
                  />);
                  if (backStageMount) {
                    out.push(<iframe
                      key="dualB"
                      ref={frameRefOf.B}
                      data-pc="stage-frame-back"
                      title={trText("Background stage")}
                      src={stageSrc("B", { dual: true })}
                      onLoad={() => onStageFrameLoad("B")}
                      style={{
                        ...base,
                        /*
                         * The background stage **can only be hidden this way** (K5 (4)): `display: none` would stop the
                         * `<video>` and rAF inside it and zero out the whole layout, so the caught-up picture would not match
                         * the visible stage;
                         * `visibility: hidden` would make `isSolid` in `solid.ts` judge it not a solid, and the measured solid
                         * box would fall back to the full screen. `opacity: 0` keeps layout and rendering, it just cannot be seen.
                         *
                         * R7: after the swap B may be the visible one, and then it is exposed along with it.
                         */
                        ...(frontId === "B" ? { opacity: 1 } : hidden),
                      }}
                    />);
                  }
                }
                return out;              })()}
              {/*
                * R7(D5): full-frame `<img>` / `MovPlayer` canvas **remains only in the legacy branch**.
                * Drawing another full frame after revealing the stage amounts to covering the stage, and that layer
                * must wait for HTTP: the rule "paused scrubbing updates in the same frame without waiting for HTTP"
                * would be lost.
                */}
              {!live && <UnifiedPreview project={project} t={t} playing={playing} />}
            </div>
          </div>
          
          {/* Corner marks: one 16-square L shape at each corner of the design frame, hinting that this is an editable canvas */}
          <span className="pc-pv-corner tl" aria-hidden="true" />
          <span className="pc-pv-corner tr" aria-hidden="true" />
          <span className="pc-pv-corner bl" aria-hidden="true" />
          <span className="pc-pv-corner br" aria-hidden="true" />

          {/* Canvas overlay, handles hit-testing and drag drawing */}
          <div
            style={{ position: "absolute", inset: 0, zIndex: 10 }}
            onPointerDown={handleOverlayPointerDown}
            onDoubleClick={handleOverlayDoubleClick}
            onContextMenu={handleOverlayContextMenu}
          >
            {rects.map((r) => {
              const isSelected = selection.includes(r.clipId);
              if (!isSelected) return null;
              const dragDx = (dragPreview?.clipId === r.clipId) ? dragPreview.dx : 0;
              const dragDy = (dragPreview?.clipId === r.clipId) ? dragPreview.dy : 0;

              // The outline hugs the entity's extent; the one just hit carries a token in its key, so the pulse animation reruns on every click
              const pulsing = flash?.clipId === r.clipId;
              return (
                <div
                  key={pulsing ? `${r.clipId}:${flash!.token}` : r.clipId}
                  className={`pc-pv-hit${pulsing ? " is-pulse" : ""}`}
                  style={{
                    left: (r.left + dragDx) * scale,
                    top: (r.top + dragDy) * scale,
                    width: r.width * scale,
                    height: r.height * scale,
                  }}
                />
              );
            })}
          </div>
        </div>
        {framed && (
          <div className="pc-pv-zoom-bar" data-pc="preview-zoom" role="group" aria-label={trText("Zoom")}>
            <span className="pc-pv-zoom-pct" data-pc="preview-zoom-pct">{`${framedPct}%`}</span>
            <button
              type="button"
              className="pc-pv-zoom-fit"
              data-pc="preview-zoom-fit"
              disabled={framedFitted}
              onClick={fitToWindow}
              title={trText("Fit window")}
            >
              {trText("Fit")}
            </button>
          </div>
        )}
      </div>
      </div>

      {!compact && <ControlBar />}
      
      {contextMenu && (
        <PreviewContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          clipId={contextMenu.clipId}
          cardId={contextMenu.cardId}
          onClose={() => setContextMenu(null)}
        />
      )}
      
      {editingText && (
        <div style={{ position: "fixed", left: editingText.x, top: editingText.y, zIndex: 9999 }}>
          <input
            autoFocus
            type="text"
            value={editingText.value}
            onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
            onBlur={submitTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTextEdit();
              if (e.key === "Escape") setEditingText(null);
            }}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--ui-accent)",
              borderRadius: 4,
              background: "var(--ui-panel-2)",
              color: "var(--ui-fg)",
              outline: "none",
              fontSize: 14,
            }}
          />
        </div>
      )}
    </div>
  );
}
