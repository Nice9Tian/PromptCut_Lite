import { UnifiedPreview } from "./preview/UnifiedPreview";
import { usePrerenderPreload } from "./preview/usePrerenderPreload";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { MediaLayers } from "./preview/MediaLayers";
import { Scene3DView } from "./preview/Scene3DView";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { findClip } from "../kernel/project";
import { nudgeFrame } from "../kernel/layout";
import { createStageRpc, type HostCapabilities, type StageRpcClient } from "../render/stageRpc";
import { frontStage, onStageEvent, releaseStageClient, setStageClient, swapStageClients, syncProject } from "./stageBridge";
import { bindStageCards, noteStageCards, noteStageFresh } from "./stageCards";
import { INITIAL_ROLE_OF, STAGE_IDS, dualStage, liveStage, stageSrc, stageTargetOrigin, type StageId } from "./previewMode";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { useMemberReadOnly } from "./readOnly";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { getCard, onCardRunStatesChanged, onSyncedUserCardsChanged } from "../kernel/registry";
import { fitView, frameOrigin, panBy, wheelZoomFactor, zoomAt, type View2D } from "./preview/viewport2d";
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

setCostResolver((proj, clipId) => {
  const key = clipIdentityOf(proj).identityKeys[clipId];
  return key ? currentCosts().find((r) => r.identityKey === key) : undefined;
}, () => dualStage());

let _searchCostStore: CostStore = createMemoryCostStore();
export function setSearchCostStore(store: CostStore): void {
  _searchCostStore = store;
  void _searchCostStore;
}

try { setOnlineBrowserMode(new URLSearchParams(location.search).get("platform") === "browser"); } catch { /* 没有 location */ }

export function Preview(props: { variant?: "mobile" } = {}) {
  const mobile = props.variant === "mobile";

  const project = useStore((s) => s.project);
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

  const [view, setView] = useState<"2d" | "3d">("2d");
  const [pickedTool, setTool] = useState<ToolType>("select");
  const readOnlyProject = useMemberReadOnly();
  const tool: ToolType = readOnlyProject ? "select" : pickedTool;
  const [rects, setRects] = useState<{ clipId: string; left: number; top: number; width: number; height: number }[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string; cardId: string } | null>(null);
  const [editingText, setEditingText] = useState<{ clipId: string; key: string; value: string; x: number; y: number } | null>(null);

  const [dragPreview, setDragPreview] = useState<{ clipId: string; dx: number; dy: number } | null>(null);
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
   * 播放循环。**播放头只停在成片真有的那些帧上。**
   *
   * 以前是按墙上时钟连续推的:显示器 60Hz 就一秒推 60 个 t,而成片是 fps 帧的,
   * 于是有一半的 t 在成片里根本不存在。单看 2D 察觉不到,一切到 3D 就露馅 ——
   * 那边显示的是预渲染好的整帧,两个视图对同一个播放头能差半帧,而进场动画最陡的就是那一段。
   * 量化之后 2D 播放显示的就是导出会写出来的那一帧,3D 贴的也是同一帧。
   *
   * 累加器 acc 必须保持不量化,不然每帧丢掉的那点余数会累起来,播放越走越慢。
   *
   * 播放范围 = 最早的卡片 ~ 最晚的卡片(project.duration 由时间轴按内容末尾同步)。
   * 按播放时播放头不在这个范围里(在第一张卡前面,或者已经播到头),从最早那张卡开始播。
   */
  const contentStart = contentStartOf(project.tracks);
  /** 舞台那一路的 `playing` effect 依赖只有三项(见那里的说明),播放起点从这里读 */
  const contentStartRef = useRef(contentStart);
  contentStartRef.current = contentStart;
  useEffect(() => {
    /*
     * E6:**非 legacy 下这个循环不启动** —— 播放头由 K4 的 `frame` 事件推进
     * (可见舞台自己按帧节拍,每拍渲完才报)。墙钟循环只留给 `?preview=legacy`。
     */
    if (live) return;
    if (!playing) return;
    const fps = Math.max(1, project.fps || 30);
    let raf = 0;
    let last = performance.now();
    let acc = tRef.current;      // 真实推进到哪儿(不量化)
    if (acc < contentStart || acc >= project.duration - 0.5 / fps) {
      acc = contentStart;
      actions.seek(contentStart);
    }
    let wrote = atFrameGrid(acc, fps);  // 上一次交出去的帧时刻
    const tick = (now: number) => {
      /*
       * 播放中外面也可能 seek(点时间轴、拖播放头),那时以外面的为准。
       * 判据是「差得比一帧还多」而不是「不相等」:tRef 在 render 里才赋值,量化之后 store 的 t
       * 可能比这里晚一帧,那不是 seek —— 按 seek 处理会让播放隔几帧倒退一格。
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
    // contentStart 不进依赖:播放中挪了第一张卡不该把播放头拽回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, playing, project.duration, project.fps]);

  /*
   * 量一次窗口有多大,顺便在「自动适应」还开着时重新算缩放比。
   *
   * 两件事都要做,原因不同:
   *   - 窗口尺寸**必须一直跟着量**,因为画框摆在哪儿是我们自己算的(见下面 frameOrigin),
   *     算式里就有窗口宽高;
   *   - 缩放比只在 auto 时重算。以前这里是无条件重算的,那时候没有手动缩放也就无所谓。
   *     现在不行了:用户放大到 200% 去调一个字的位置,拖一下侧栏宽度(ResizeObserver 就响了),
   *     画面「啪」地跳回适应窗口,刚找好的地方就没了。
   *
   * 用 useLayoutEffect 而不是 useEffect:第一次渲染时还不知道窗口多大,画框会先摆在左上角。
   * 布局效应在浏览器绘制**之前**同步跑完并触发重渲染,所以那一帧用户看不见。
   */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      setBoxSize({ width: r.width, height: r.height });
      if (camRef.current.auto) setCam(fitView(project, r, mobile ? 0 : undefined));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height, view]);

  /** 回到「适应窗口」。工具行那个徽章点一下就走这儿 */
  const fitToWindow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    setCam(fitView({ width: project.width, height: project.height }, r, mobile ? 0 : undefined));
  }, [project.width, project.height]);

  /*
   * 滚轮缩放 + 中键拖动平移。
   *
   * 为什么不用 React 的 onWheel:React 17 起把 wheel 绑成**被动**监听器,
   * 里面调 preventDefault 不但不起作用,还会在控制台报一行警告 ——
   * 于是滚轮在缩放画面的同时把整个面板也滚了。只能自己 addEventListener 并显式关掉 passive。
   *
   * 依赖里只有画幅:cam 走 ref 读最新值,否则每缩放一格就要重新解绑重绑一次监听器。
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const box = () => el.getBoundingClientRect();
    const size = { width: project.width, height: project.height };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box();
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
      if (factor === 1) return;
      const cur = camRef.current;
      setCam(zoomAt(cur, size, r, { x: e.clientX - r.left, y: e.clientY - r.top }, cur.scale * factor));
    };

    /*
     * 中键拖动:按住不放拖动画布。左键留给选择 / 移动工具(它自己判 button !== 0 就退出),
     * 右键留给菜单,所以平移只认中键 —— 三个键各管一件事,不用按修饰键。
     */
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      // 中键在很多浏览器上是「自动滚动」,不拦住就会弹出那个圆形滚动光标
      e.preventDefault();
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      // 抓住指针,拖出预览区也照样跟手。指针要是已经没了(松开得比这行还早)会抛,不该因此中断拖动
      try { el.setPointerCapture(e.pointerId); } catch { /* 没抓住就算了,照样能拖,只是出了区域会断 */ }
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!panning) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      setCam(panBy(camRef.current, size, box(), dx, dy));
    };
    const stopPan = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch { /* 已经放开了 */ }
      el.style.cursor = "";
    };
    // 中键按下默认会开自动滚动,auxclick 也要拦一下,否则松开时还会触发
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
  }, [project.width, project.height, view]);

  /*
   * 渲染面就绪:它挂载完会 postMessage 过来(带 J4 的宿主能力表);每来一次就给**那一个实例**
   * 建一个新的 RPC 客户端。跨源时 `targetOrigin` 必须点名舞台的源(不能再用 `location.origin`)。
   *
   * 握手之后立刻发一次 `setRole` 把实例和角色对上:舞台自己的缺省角色是 `front`,
   * B 那个 iframe 不发就会顶着 `front` 的身份收探针(角色闸门会挡下来,但那是兜底不是设计)。
   */
  useEffect(() => {
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    const onMessage = (e: MessageEvent) => {
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "pc-stage-cards") {
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
      const role = frontIdRef.current === id ? "front" : "back";
      noteStageFresh(id);
      rpcRef.current[id]?.dispose();
      const targetOrigin = origin && origin !== "null" ? origin : stageTargetOrigin(id);
      const client = createStageRpc(win, targetOrigin, { maxSec: () => getState().project.duration });
      rpcRef.current[id] = client;
      hostCapsRef.current[id] = caps;
      glPortTo(id, win, caps);
      setStageClient(role, client, caps);
      void client.setRole(role).catch(() => { /* iframe 又换了,下一次握手会重发 */ });
      void client.setViewScale(scaleRef.current).catch(() => { /* 同上 */ });
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
   * 卡片代码换了一般不重载舞台(C6.6 集成 3b)。以前改一张卡,热更新冒到本组件,Fast Refresh 重跑上面那个握手 effect,
   * 清掉了舞台的 RPC 客户端,舞台停在旧画面,只好每次都整页重载两个 iframe(`b25f482`)。现在热更新在 `cards/index.ts`
   * 接住、不冒到这里;舞台自己也收到同一份热更新,在舞台里重装卡片、重渲,然后发 `pc-stage-cards` 报到。
   * 只有过了时限还没报到的舞台(代码确实过期)才在这里整页重载那一个(`stageCards.ts` 的 `whenStagesHaveCards`)。
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
      console.warn(`[preview] 舞台 ${id} 没换上新的卡片代码,整页重载它`);
      frame.src = frame.src;
    });
  }, [dual]);

  /*
   * 项目选项切了 `glRoute`(R9 约束第 1 条):切到 `shared` 时给已经握过手的舞台补交端口;
   * 切回 `perDocument` 什么都不用发 —— 舞台收到新项目自己按生效路线重建 `glHost` 那一侧的连接。
   * 重走 `ProbeGate` 遮罩(`device` 变了)不在这里,见 R9 报告。
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
   * 素材和音频按墙钟播:**一拍的名义时长之外再慢这么多**就暂停它们
   * (K4 / pinned 架构 10;`mediaSync.ts` 的 `IN_SYNC_SEC` 同值)。
   * 下一拍准时到达时再放回去 —— 这就是用户能感到的「小卡」。
   *
   * 阈值按 pinned 固定 40 毫秒、不按帧算;**量的是「停顿」而不是两条 `frame` 之间的
   * 总间隔** —— 一拍本来就要 `1000/fps` 毫秒,把它算进卡顿是把正常节拍当成了停顿。
   * 24 / 25 fps 尤其明显:60 Hz 屏上一拍 41.7 / 40 ms 排不进 16.7 ms 的格子,
   * 实际到达是 33 / 50 交替(`StageView.tsx` 的节拍循环自己也这么说),
   * 按总间隔判的话每隔一拍就误判一次卡顿、音频每 ~80 ms 暂停恢复一次。
   * 按「超出名义拍长多少」判:24 fps 的 50 ms 拍只超出 8.3 ms,60 fps 掉一次 vsync
   * 也只超出 16.7 ms,都进不了 40 ms;而真的卡一下(比如 300 ms)照样当场判出来。
   */
  const MEDIA_STALL_MS = 40;
  /** E6:播放中 `refreshRects` 改成定时器,别每拍都往返一次 */
  const RECTS_POLL_MS = 500;

  /**
   * 播放中素材层 / 音频是不是被掐住了(K4 的 `mediaStalled`)。
   *
   * **通道写死**:`MediaLayers` 的 `playing` prop 改成 `playing && !mediaStalled`,舞台侧经
   * `setPlaying(false)` 同步。直接对元素 `pause()` 没用 —— `planSync` 在播放态的每个分支
   * 都返回 `play: paused`,下一拍就被 `play()` 回来了。
   */
  const [mediaStalled, setMediaStalled] = useState(false);
  const stalledRef = useRef(false);
  /** 上一条 `frame` 的**真实**到达时刻(首拍以 `play()` 回包时刻为起点) */
  const lastFrameAtRef = useRef(0);
  /** 验收口:这一轮播放判过几次卡顿、最大的一次超出名义拍长多少毫秒 */
  const stallCountRef = useRef(0);
  const gapMaxRef = useRef(0);
  /*
   * 「音频跟随时刻」(`mechanism/rendering.md`)要音频跟着舞台的拍子走,原来有两处漏着,声音会先跑出去:
   *
   * 1. **起播到第一拍之间**:`playing` 一翻,主文档的音频立刻起播,而播放头要等舞台收到项目、回了 `play`、
   *    渲完第一拍才动。舞台起步慢(刚打开项目、重卡)时声音先放出去几百毫秒,偏差过了硬 seek 的门槛又被拉回来重放一遍。
   *    `firstBeatRef`:这一轮播放的第一拍到了才放开音频。只管主文档的音频,不动舞台里的素材层。
   * 2. **卡顿是到货时才判的**:晚到的那一拍到了才知道它晚了,卡住的那几百毫秒里音频照放。
   *    看门狗:上一拍(或 `play` 回包)之后过了「名义拍长 + 40 ms」还没有下一拍,当场按卡顿掐住;
   *    判据与到货时那一条相同(超出名义拍长 40 ms),只是不等它到。
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
   * 流平面 / 抑制 / 快照的投递(C4、C5、A3c;排程在 `snapshotFeed.ts`)。
   *
   * 叫它的地方:每拍收到 `frame` 之后(播放中)、`setTime` 发完之后(暂停 / 拖动)、起播之前、舞台报 `settled` 之后,
   * 项目改了之后,以及快照字节 / 新的就绪层到货之后。33 ms 的节流在 `deliverSnapshots` 里,所以可以放心地多叫几次。
   */
  const dualRef = useRef(dual);
  dualRef.current = dual;
  const liveRef = useRef(live);
  liveRef.current = live;
  /** 上一次发出去的抑制集合(拼成一条字符串比,省掉没变也发) */
  const suppressedRef = useRef("");
  /** 上一次发出去的流平面(R8;同样拼成字符串比) */
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
  const pumpFeed = useCallback(async (at?: { t: number; playing: boolean }) => {
    if (!liveRef.current) return;
    const s = frontStage();
    if (!s) return;
    const head = { project: getState().project, t: at?.t ?? tRef.current, playing: at?.playing ?? playingRef.current, single: false, sparseOnly: false };
    if (head.playing) clearSettled("front", "playing");
    const holdForSwap = !head.playing && !head.single && swapInFlight();
    if (!holdForSwap) syncPlanes(s, head);
  }, [syncPlanes]);
  const pumpRef = useRef(pumpFeed);
  pumpRef.current = pumpFeed;

  useEffect(() => {
    if (!dual) return;
    syncSnapshotSubscription(() => { void pumpRef.current(); });
  }, [dual, project]);
  useEffect(() => {
    if (!dual) return;
    return () => stopSnapshotFeed();
  }, [dual]);

  useEffect(() => {
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (c) void c.setViewScale(scale).catch(() => { /* iframe 正在换:下一次握手会重发 */ });
    }
  }, [scale]);
  useEffect(() => {
    if (!onlineBrowserMode()) return;
    const refresh = () => {
      queueMicrotask(() => { void pumpRef.current(); });
    };
    const offSynced = onSyncedUserCardsChanged(refresh);
    const offRun = onCardRunStatesChanged(refresh);
    return () => { offSynced(); offRun(); };
  }, []);

  /* 换了 iframe:那一份投递基线跟着作废,下一次带 `reset`(A3c) */
  useEffect(() => {
    if (!live || !stageReady) return;
    markBaselineReset("front");
    suppressedRef.current = "";
    // 暂停着也发流平面了:换了一台舞台,这一份记录同样从零开始(新的那台手里没有)
    streamPlanesRef.current = "[]";
    /*
     * 在线页面:预渲染小尺寸常常在舞台握手之前就取到了(取到时 `frontStage()` 还是空,那一次投递落空)。
     * 暂停着的页面之后没有别的事件会再投,重卡就一直是占位 —— 舞台一握手就投一次(c10a-demo-probe 实测)。
     */
  }, [live, stageReady]);
  /*
   * 项目改了(store 换了新的项目对象):流平面和抑制按新项目重算一次。依赖下层的卡的流只对产它时的那一版下层有效 ——
   * 下层一改,那一层带的输入签名就对不上了(`snapshotFeed.ts` 的 `streamLayers`),旧流要当场撤下,不能等下一次 `setTime`:
   * 暂停着、手按着标尺不动时改下层,之后没有别的事件会来投。播放中下一拍自己会投,这里多投一次无妨;没变的不会重发
   * (`syncPlanes` 按内容比,快照那一半有 33 毫秒的节流)。
   */
  useEffect(() => {
    if (!live || !stageReady) return;
    void pumpRef.current();
  }, [live, stageReady, project]);

  /*
   * K5 (4) 的角色互换。**A / B 只是实例名**,谁是 `front` 由这个 state 说了算 ——
   * 起手 A,互换之后就换过来了。两件事必须在**一次 React 提交**里做完:
   * 对调两个 iframe 的可见性,和把「当前 front」指针切过去(`stageBridge` 的登记)。
   *
   * 后台那个只能用 `opacity: 0; pointer-events: none` 藏 —— `display: none` /
   * `visibility: hidden` 会让整份 OOPIF 退出渲染树,`requestVideoFrameCallback` 不再回调,
   * K5 (3) 的 `mediaReady` 就只能等到超时(见 K5 (4) 的说明)。
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
     * 基线跟着客户端走(根因 A):新 front 手里是补跑开始时灌的那一份,**不是**此刻的最新项目。
     * 以前这里 `markPushed(role, getState().project)`,补跑期间的编辑(删片段)就永远补不上;
     * 现在 `swapAndDress` 在互换之后补推一次 `syncProject`,按它真正持有的那份算增量。
     */
    swapStageClients({ client: nextFront, caps: hostCapsRef.current[nextId] }, { client: nextBack, caps: hostCapsRef.current[cur] });
    // 新 front 的抑制集合、流平面都从零开始记(暂停态互换时旧 front 挂着流平面,新 front 没有)
    suppressedRef.current = "";
    streamPlanesRef.current = "[]";
    return { front: nextFront, back: nextBack };
  }, []);
  /* 退回单舞台(握手失败)时,可见舞台回到 A(B 已经卸掉) */
  useEffect(() => {
    if (!dual && frontIdRef.current !== "A") { frontIdRef.current = "A"; setFrontId("A"); }
  }, [dual]);
  /*
   * C10 契约第 2 节「后台舞台的摆放与节拍」:在线双舞台的后台活由本页判空闲(页面可见、rAF 间隔不持续超过 500 ms、
   * 父页 rIC 在回调),经 RPC 发开始 / 停止。桌面运行环境不发(照旧)。
   */
  useEffect(() => {
    if (!dual) return;
    setSwapHost({
      swapRoles,
      // 2D 预览**不加 proxy=1**(见下面 iframe 那段注释),所以互换后重发的也是 false
      proxy: () => false,
      // A1 的换档:舞台的 VideoTrack / 像素映射素材按它选档(T1a 审查 #5);来源见 LOCAL_HASHES
      localHashes: () => [...tierHashes()],
      // 只有一个舞台时暂停后不经后台舞台追活渲(双舞台下不会是单舞台,这里只是兜一道)
      singleStage: () => false,
    });
    return () => setSwapHost(null);
  }, [dual, swapRoles]);

  /** 这一轮播放已经为哪几张卡发起过互换(别每拍都发一次) */
  const swapTriedRef = useRef(new Set<string>());

  /* 验收探针的观察口:父页这一侧的状态(哪个 iframe 是 front、素材掐住没有、降级到哪一步) */
  useEffect(() => {
    if (!live) return;
    const w = window as unknown as { __pcPreviewDiag?: () => unknown };
    w.__pcPreviewDiag = () => ({
      frontId: frontIdRef.current,
      mediaStalled: stalledRef.current,
      // K4 / pinned 架构 10:这一轮播放里判过几次卡顿(正常播放应当是 0)
      mediaStallCount: stallCountRef.current,
      mediaGapMaxMs: gapMaxRef.current,
      suppressed: suppressedRef.current ? suppressedRef.current.split("|") : [],
      // 上一次发给可见舞台的流平面(暂停 / 拖动时也有)
      streamPlanes: streamPlanesRef.current,
      pendingDemote: [...pendingDemotes()],
      demoted: [...demotedClips()],
      swapInFlight: swapInFlight(),
      swapLog: stageSwapDebug(),
      swapTrace: stageSwapTrace(),
      // 播放态互换的发起判断(整场景估时 / 追不上不发起)与停下时的让路次数
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
   * 舞台事件的分发(E0 的七种;来源过滤在 stageBridge 里按角色做完了)。
   *
   * 监听只登记一次,所以里面读的一律是 ref / store,不读闭包里的 state。
   */
  useEffect(() => onStageEvent((e) => {
    switch (e.type) {
      case "frame": {
        // K4:可见舞台每渲完一拍报一次 t,播放头跟它走(那时 Preview 的 rAF 循环不启动)
        const now = performance.now();
        const prev = lastFrameAtRef.current;
        lastFrameAtRef.current = now;
        armStallWatch();
        if (!firstBeatRef.current && playingRef.current) { firstBeatRef.current = true; setFirstBeatSeen((n) => n + 1); }
        actions.tick(e.sec);
        // 这一拍的抑制集合和快照(C5:播放中发 setSuppressed(H(t)) + setSnapshots)
        void pumpRef.current();
        /*
         * K3(b) 的 `vtOk = false` 轻卡:播放头刚进入它时整场景在后台补跑后互换。
         * 每张卡这一轮播放只发起一次 —— 补跑一次要几百毫秒,每拍发一次只会互相掐。
         * 只给从它中间开始播放的卡:这一轮播放中逐拍走过挂载帧、自然进场的不发起(`playingSwapTargets`)。
         * 拍序号先记下(连续、重复还是断开),再算目标。
         */
        notePlayFrame(e.sec);
        // 只有双舞台才有后台舞台可换;在线页面的单舞台不走;最低一档播放时不活渲,也不走
        if (dualRef.current && !swapInFlight()) {
          const targets = playingSwapTargets(getState().project, e.sec).filter((id) => !swapTriedRef.current.has(id));
          if (targets.length) {
            for (const id of targets) swapTriedRef.current.add(id);
            void runPlayingSwap(targets);
          }
        }
        if (!prev) break;
        // 一拍的名义时长之外还慢了多少(见 MEDIA_STALL_MS 上面那段)
        const overBeat = now - prev - 1000 / Math.max(1, getState().project.fps || 30);
        if (overBeat > gapMaxRef.current) gapMaxRef.current = overBeat;
        const stalled = overBeat > MEDIA_STALL_MS;
        if (stalled === stalledRef.current) break;
        if (stalled) stallCountRef.current++;
        stalledRef.current = stalled;
        setMediaStalled(stalled);
        // 舞台侧的素材层同步掐住 / 放回;主文档的音频由 MediaLayers 的 playing prop 管
        void frontStage()?.setPlaying(!stalled && playingRef.current).catch(() => {});
        break;
      }
      case "ended":
        /*
         * K4 播放到头:写 store(`pause()` + `seek(duration)`)。剩下三步
         * (`setPlaying(false)`、`pause()` 拿 `stoppedAt`、`setTime(stoppedAt, { settle: true })`)
         * 和按暂停**是同一段收尾** —— `playing` 翻成 false 之后由下面那个 effect 统一做,
         * 少了最后一步的话最后一帧的重卡永远停在抑制态(pinned 架构 9)。
         */
        actions.pause();
        actions.seek(e.sec);
        break;
      case "settled": {
        /*
         * 舞台追上之后自己把这几张卡的抑制撤了(和露出活组件同一次提交,`StageView` 的 `releaseSettled`):
         * 父页记的「上次发的抑制集合」不再可信,下一次照现状重发。互换转正的那一条(`clipIds` 为空)不走:
         * 那边由 `swapRoles` 清记录、`markAllSettled` 记整台精确。
         */
        const named = e.clipIds.length > 0;
        if (named) suppressedRef.current = "\u0000";
        // 只认这一次停下的那一秒:迟到的(用户又拖走了,舞台在新的跳转里已经把它们放回抑制)不算精确。
        // 贴流的卡按 store 此刻的播放头比(`tRef` 要等下一次渲染才更新,刚暂停的那一下会慢一步);单舞台逐层追一帧照旧按 `tRef` 比
        const stale = named && Math.abs(e.sec - getState().t) > 1e-6;
        if (stale) {
          if (named) void pumpRef.current();
          break;
        }
        // K5:暂停态活渲就绪 —— 把这几张卡从投递基线里删掉(A3c),平面舞台自己摘了
        noteSettled("front", e.clipIds);
        if (named) void pumpRef.current();
        break;
      }
      case "demote":
        // K6:这张卡降级,父页整条 PUT { ...旧记录, capped: true, demoted: true }
        void onStageDemote(e.clipId);
        break;
      case "probe":
      case "probe-frame":
        // K1(R4):探针的成绩和它顺手推出来的死素材(消费方在 probeRunner)
        break;
      case "mediaReady":
        // K5 第 (4) 步:后台舞台的素材层画出一帧了(消费方在 catchUp.ts,它自己订阅)
        break;
    }
  }), []);

  /**
   * 选中描边用的外框:不用包裹层(每张卡都占满整屏),用片段的实体范围——
   * 字幕卡的描边贴着字幕本身,而不是绕屏幕一圈。老渲染面没有 bounds 就退回包裹层。
   */
  /*
   * R7(D3 第 4 步 / D5):主文档的 `mediaRects` 已经删掉。
   *
   * 素材段现在由舞台自己画(E7 第 1 条,R3 落地),`data-pc-clip` 写在显示着的视频槽位
   * 和图片层上,所以舞台的 `rects()` / `hitTest` 本来就认得它们 —— 主文档再补一份,
   * 同一个 clipId 就会出现两次、命中时挑到错的那个。命中测试和实体框**全部走舞台**的
   * `hitTest` / `rectsWithBounds`。
   */

  /**
   * 一次往返拿全部活跃片段的外框 + 实体范围(rectsWithBounds,合并了以前 rects() 后逐个 bounds() 的 N+1)。
   * 心跳只带 pixels: 'selected':只对选中的卡扫 canvas 像素(选中描边不回退到整块画布),
   * 未选中的卡用元素矩形 —— 它们的框只进 rects 列表、不画描边。'all' 只在用户点击那一次用。
   * 回包乱序时旧的一次不能盖掉新的,用代数守着。
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
        // iframe 正在换(detached):这一次作废,新的 ready 会再刷一遍
        return;
      }
    }
    if (gen !== rectsGen.current) return;
    // R7:素材段也在舞台里了(E7 第 1 条),`rectsWithBounds` 一次就把卡片和素材段都带回来
    setRects(cards);
  }, [stage]);

  /** 刚被点中的片段:描边闪一下,让用户看清点到的是谁 */
  const [flash, setFlash] = useState<{ clipId: string; token: number } | null>(null);
  const flashClip = (clipId: string) => setFlash({ clipId, token: Date.now() });

  /**
   * 实体命中:问渲染面这一点上从最上层往下第一个「画了东西」的元素属于哪个片段。
   * 透明容器穿过去——字幕卡在最上层也不会挡住下面的卡。老渲染面没有 hitTest 时
   * 退回按包裹层外框找最上层的那个。
   */
  const hitAt = async (e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const s = stage();
    /*
     * R7:卡片和素材段都在舞台里,一次 `hitTest` 往返就是最终答案(D3)。
     * 主文档只在**完全没有舞台**时(还没握手 / iframe 正在换)退回上一轮 `rects` 找一下。
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

  // 项目文档变了就发过去:经 stageBridge 只发变了的片段(两层 diff),没有基线时整份 + reset
  useEffect(() => {
    // 界限搜索测量期间舞台上是缩水项目:不推(测完整份重灌、stageReady +1 再来一次)
    if (!stageReady) return;
    void syncProject("front", project).then(() => refreshRects(), () => {});
  }, [stageReady, project, refreshRects]);

  // 时间变了就下发。播放中是连续推进;拖播放头 / 跳转 / 重播(playToken 变)都按跳转处理:
  // 重挂载 + 从入点补跑到那一刻。两者合在一个 effect 里,一次 seek 只渲染一帧。
  /*
   * 只认「时间真的变了」:stage / refreshRects 这两个回调的引用会跟着项目、缩放一起换,
   * 以前它们一换这个 effect 就重跑,于是 Agent 每写一次项目都多来一次 jump 渲染 ——
   * 重挂载活跃的卡、从入点逐帧补跑到播放头,实测播放头在 60 秒处每次 230~350 ms 的主线程,
   * 而项目变了该不该补跑,setProject 那边(StageView)已经按「哪张卡变了、在不在画面上」判过了。
   */
  /*
   * E0:暂停、拖动只发 setTime(不重挂载、不递增 playToken —— 时钟拨过去、提交 React、钉动画);
   * 父页对可见舞台**不再**发 render(jump)。
   *
   * **E6:这个 effect 拆成了两半。** 发 `setTime(t)` 那半**播放中不跑**(K4 由舞台自己按帧节拍
   * 推进,父页再发就是两个人抢方向盘);`refreshRects()` 那半改成播放中每 500 ms 一次的定时器
   * (见下面那个 effect),结果按请求序号丢弃过期的(`refreshRects` 里的 `rectsGen`)。
   * 先同步项目再拨时间,两条 RPC 顺序不能反(setTime 要在新项目上算活跃卡)。
   */
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  /*
   * 双舞台模式下由页面触发预渲染(公共 hook,legacy 那一路在 `UnifiedPreview` 里用同一份):
   * 编辑推送成功(`frameRequest` 先 `alignMirror`)且空闲(不在播放、不在拖动)时防抖发 `preload`,没就绪就接着问。
   */
  usePrerenderPreload(project, { enabled: dual, idle: !playing && !scrubbing, waitForProbe: true });
  /** 诊断:最近几次 setTime 与上一次失败(探针排查暂停后没追到活渲用) */
  const setTimeLogRef = useRef<{ at: number; sec: number; settle: boolean }[]>([]);
  const setTimeErrorRef = useRef<{ at: number; sec: number; error: string } | null>(null);
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const lastRenderKey = useRef("");
  /**
   * 给可见舞台拨一次时间。**暂停和拖动的唯一入口**(播放走 K4)。
   *
   * `settle: true` 启动 K5 的暂停态活渲:点时间轴、拖动松开、按暂停、播放到头都带它,
   * **拖动过程中不带**(E3)。
   */
  /**
   * 发给可见舞台的 `setTime` 的代数(每发一次 +1)。单舞台停下追一帧按「此刻最新的 setTime + 秒数」去重:
   * 暂停那一下父页会连着发几次 setTime(暂停、舞台最后一拍改写的 t),各自的追一帧可能在最后一次 setTime 之后才发出;
   * 同一秒两次追一帧在舞台里并发,后一次会把前一次画好的层打断成「没画好」,画好的层又回到抑制(单舞台在线探针 G3 实测)。
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
      // iframe 正在换(detached):新的 ready 会重发
      setTimeErrorRef.current = { at: Math.round(performance.now()), sec, error: String((e as Error)?.message ?? e).slice(0, 120) };
      markBaselineReset("front");
      return;
    }
    void refreshRects();
    void pumpRef.current();
    if (dualRef.current && opts.settle) void runSettleSwap(sec).then((swapped) => { if (swapped) void pumpRef.current(); }, () => { /* 后台舞台正在换:下一次 setTime 会重来 */ });
  }, [stage, refreshRects, syncPlanes]);
  /** 单舞台停下追一帧的代数(又停了一次 / 又动了:旧的结果不记)与上一次的结果(诊断) */
  const settleResultRef = useRef<(SettleResult & { at: number }) | null>(null);
  void settleKeyRef;
  /** K4 的起 / 停节拍只认 `playing`,所以那个 effect 读这一份、不把 `sendSetTime` 进依赖 */
  const sendSetTimeRef = useRef(sendSetTime);
  sendSetTimeRef.current = sendSetTime;
  /** 上一次这个 effect 看到的 `playing` —— 「刚从播放翻成暂停」那一次要让给收尾那个 effect */
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (!stageReady) return;
    // K4:播放中播放头由舞台的 `frame` 推,父页一拍都不发
    if (live && playing) { wasPlayingRef.current = true; return; }
    /*
     * **刚暂停的那一次不在这里发**(E0 / R5-4)。收尾是下面那个 effect 的事,它按
     * `pause()` 回包的 `stoppedAt` 发;这里手上只有 `store.t`,可能比舞台落后一拍,
     * 抢着发一次会走向后跳路径(全场 stateful 卡重挂载、`.pc-settling` 闪一下),
     * 而且把 K5 的追帧 / 互换白启动一遍。播放到头(`ended`)走的是同一段。
     */
    const justPaused = live && wasPlayingRef.current;
    wasPlayingRef.current = false;
    if (justPaused) return;
    /*
     * **`scrubbing` 也进键**(E3 / pinned 架构 9)。拖动松开、在时间轴上点一下,
     * `t` 都可能一点没变(松手坐标等于最后一次 flush 的位置;点击时 `seek` 和
     * `beginScrub` 在同一个 React 事件里批成一次渲染,那一次 `scrubbing` 已经是 true)。
     * 键里不带这一位的话,拖动 / 点击结束之后永远补不上那条 `settle: true`,
     * 判重卡就停在快照上 —— 正是「点时间轴、拖动松开后不精确活渲」那条。
     * legacy 下 `dual` 为 false,后缀恒定,不会多发。
     */
    const key = `${stageReady}|${t}|${playToken}|${live && scrubbing ? "scrub" : "settle"}`;
    if (key === lastRenderKey.current) return;
    lastRenderKey.current = key;
    // 单舞台同样带 settle:停下时逐层追当前一帧,拖动过程中不带
    void sendSetTime(t, live && !scrubbingRef.current ? { settle: true } : {});
  }, [stageReady, live, playing, t, playToken, scrubbing, sendSetTime]);

  /*
   * 同步卡运行状态变成 ready、或测量结果到了导致分派表重算后，停着的舞台重新投递抑制并结算当前帧：
   * 刚打开项目时同步卡尚未 ready，首次 setTime(t, { settle: true }) 按 localOnly 把它记入抑制（显示沙漏）、
   * swapTrace 也只记下没测过的那一次；之后卡 ready、测量完成，暂停中若不再触发结算就会一直停在沙漏。
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

  /* E6:播放中 `refreshRects` 改成定时器,一次往返、结果按序号丢过期的 */
  useEffect(() => {
    if (!live || !stageReady || !playing) return;
    const id = window.setInterval(() => { void refreshRects(); }, RECTS_POLL_MS);
    return () => window.clearInterval(id);
  }, [live, stageReady, playing, refreshRects]);

  /*
   * K4 的父页侧:`playing` 翻成 true 就 `play(t)` 起节拍,翻成 false 就走收尾
   * (`setPlaying(false)` → `pause()` 拿 `stoppedAt` → `setTime(stoppedAt, { settle: true })`)。
   *
   * **以舞台最后一拍的 `t` 为准,不用 `store.t`**(E0):store 的 `t` 可能比舞台落后一拍,
   * 按它发会走向后跳路径、全场 stateful 卡重挂载。
   * 播放到头(`ended`)走的是同一段 —— 那边只写 store,`playing` 翻 false 之后落到这里。
   *
   * 起播位置见 `playStartOf`:播放头不在内容范围里就回到最早那张卡(和 legacy 循环同一条规矩)。
   */
  /**
   * 这一次按播放从哪一秒起。和 legacy 的墙钟循环(`:155-158`)逐字同一条规矩:
   * 播放头在第一张卡之前、或者已经播到头,就从最早那张卡重播。
   *
   * R7 把缺省翻成舞台之后这条规矩漏了,播到头再按播放会在舞台第一拍就
   * `rawSec >= duration`、立刻 post `ended` —— 按下去什么都不发生(R7-11 的回归)。
   */
  const playStartOf = useCallback((): number => {
    const project = getState().project;
    const fps = Math.max(1, project.fps || 30);
    const start = contentStartRef.current;
    const from = tRef.current;
    if (from >= start && from < project.duration - 0.5 / fps) return from;
    // store 也要跟着回到起点:时间轴、素材层、`ended` 之后的那次 settle 都按 store.t 走
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
           * **先等项目送到这个舞台,再起节拍。**
           *
           * 新 iframe 握手之后 `stageReady` +1,上面那个 effect 发 `syncProject`、这里发 `play` ——
           * 但 `syncProject` 走 stageBridge 的串行链(`chain.then`),真正 postMessage 要晚一个微任务,
           * 而 `play` 是同步发的。于是「带着 `playing` 换 iframe」(切回 2D、舞台热重载)时
           * 舞台先收到 `play`,手里还没有项目,回 `no-project`;这里又不重试 —— 按钮是「暂停」、画面不动。
           * 串在同一条链上等它落定,顺序就钉死了。基线没变时 `syncProject` 什么都不发,不多一次往返。
           */
          await syncProject("front", getState().project);
          if (!alive) return;
          const from = playStartOf();
          // 这一轮播放的起点:起播那一刻已经挂着的卡算「从中间开始」,之后逐拍挂上的算自然进场(播放态互换只给前者)
          notePlayRunStart(from);
          /*
           * 起播之前先把这一秒的流平面、抑制、快照摆好(以前等第一拍的 `frame` 才发:头一拍重卡是活渲的,又慢又会和流接不上)。
           * 暂停着舞台已经把播放头下这一帧先解好了,这里一抑制,头一拍就是流的画面;流还没画出来的,舞台先不藏它原来的画面。
           * 不等回包:几条消息和下面的 `play` 按发出的先后到。
           */
          void pumpRef.current({ t: from, playing: true });
          const reply = await s.play(from);
          if (!alive) return;
          // 首拍的到达间隔以 `play()` 回包时刻为起点(K4)
          if (reply.ok) { lastFrameAtRef.current = performance.now(); armStallWatch(); }
          /*
           * 舞台说起不了(没项目、角色不对):**把 store 也翻回暂停**,别让界面停在「在播」。
           * 翻回去之后下面那一支照常收尾(`pause()` 拿 `stoppedAt` → `setTime(settle)`),
           * 画面和播放头对齐到舞台真实停着的那一帧;用户再按一次播放就是一次干净的起播。
           */
          else if (getState().playing) actions.pause();
        } catch { /* iframe 正在换:新的握手会让这个 effect 带着 playing 重跑一遍 */ }
      })();
    } else {
      void (async () => {
        // **发 pause() 的这一处同步清空 lastRenderKey**(E6),否则下一次 setTime 被去重吞掉
        lastRenderKey.current = "";
        window.clearTimeout(stallWatchRef.current);
        stalledRef.current = false;
        setMediaStalled(false);
        let stoppedAt = tRef.current;
        /*
         * 只有「刚从播放停下来」才以舞台的 `stoppedAt` 为准。暂停中换了一个新的渲染面(`stageReady` +1:
         * 卡片代码装上后舞台整页重载、热更新、iframe 重挂)也会走到这一支 —— 新舞台还停在 0,
         * 照它改 store 就把用户定好的播放头冲回 0(C6.6 T9:成员加入共享项目、装上用户卡之后播放头从 2.5 s 回到 0)。
         * 那时以 store 的 `t` 为准,只把它发给新舞台。
         */
        const fromPlay = playedRef.current;
        playedRef.current = false;
        try {
          const reply = await s.pause();
          if (fromPlay && reply.ok && typeof reply.stoppedAt === "number") stoppedAt = reply.stoppedAt;
        } catch { /* iframe 正在换 */ }
        if (!alive) return;
        if (Math.abs(getState().t - stoppedAt) > 1e-6) actions.tick(stoppedAt);
        await sendSetTimeRef.current(stoppedAt, { settle: true });
      })();
    }
    return () => { alive = false; };
    /*
     * **依赖只有三项**。`t` 每拍都在变,`stage` / `sendSetTime` 的身份也会跟着换 ——
     * 进了依赖这个 effect 就每拍重跑一次:播放中会把刚起的节拍循环停掉重起,
     * 暂停中那一支的 `actions.tick(stoppedAt)` 会把自己再触发一遍(无限更新)。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, stageReady, playing]);

  /*
   * R3 的最小接线:非 legacy 下素材层在**舞台里**(E7 第 1 条),它要三样东西才动得起来 ——
   * `mediaT`(跟哪一刻)、`scrubbing`(seek 放疏一点)、`playing`(只管素材层,不碰 K4 的节拍循环)。
   *
   * **两个舞台都发**(E3:「素材层 `mediaT = t`,两种角色一样」):K5 第二路互换前
   * `back` 的素材必须已经在目标拍上,不然互换后偏差过 `HARD_SEEK_SEC`、必付一次硬 seek。
   * legacy 下一条都不发 —— 那边素材层还在主文档。
   *
   * `playing` 带上 `mediaStalled`(K4):舞台的素材层和主文档的音频一起掐、一起放。
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
  // C6.6:换档集合变了就下发给两个舞台(E3:素材层两种角色一样)
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setLocalHashes([...tierList]).catch(() => {});
    }
  }, [live, stageReady, tierList]);

  // 画面层和声音层都由 MediaLayers 管:可以同时有多条画面(重叠+淡化=交叉溶解),音频段单独出声

  // 命中测试与拖拽逻辑
  /**
   * 命中是一次异步往返(舞台在 iframe 里),但**起点不能丢**:pointerdown 时先同步抓住指针、记下起点,
   * 再 await hitTest;await 期间到达的 pointermove / pointerup 先累积,命中结果回来后再决定是选中还是开始拖动 ——
   * 「点画布后立刻拖动」的那几个 move 事件不会漏,松手早于回包也不会留下一个永远在拖的状态。
   */
  const handleOverlayPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const overlay = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    try { overlay.setPointerCapture(pointerId); } catch { /* 指针已经没了,照样能算命中 */ }

    // await 期间的事件先记着
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

    const release = () => { try { if (overlay.hasPointerCapture(pointerId)) overlay.releasePointerCapture(pointerId); } catch { /* 已经放开了 */ } };

    if (tool === "select") {
      release();
      // 选择工具：点在实体上则选中并闪一下描边，点空白(或透明区域下面没东西)则取消选中
      if (targetRect) {
        actions.select([targetRect.clipId]);
        flashClip(targetRect.clipId);
        // 点击那一次用 'all':新选中的 canvas 卡描边按像素框来,不回退到整块画布
        void refreshRects("all");
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // 移动工具：按下开始拖拽，移动时更新本地拖拽状态，松开才写入 store 记录撤销
      if (!targetRect) { release(); return; }
      actions.select([targetRect.clipId]);
      flashClip(targetRect.clipId);
      const clipId = targetRect.clipId;

      let currentDx = 0;
      let currentDy = 0;
      const applyMove = (cx: number, cy: number) => {
        // 覆盖层是按 scale 缩放显示的,位移换算回舞台像素,和 frame 用的是同一套单位
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
           * 拖动改的是 clip 的 frame(位置框),不是卡片参数:卡片没有 x / y 参数,以前往 params 里
           * 写 x / y 等于什么都没改 —— 描边跟着鼠标走了一段,松手就弹回去。
           * 走 nudgeFrame 和 Agent 的 nudge / set_position 是同一条路:没有 frame 的卡先按铺满舞台
           * 算出当前位置再加位移,松手只写一次,一次拖动 = 一步撤销。
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

      // 回包之前已经动过 / 松过手的,现在补上
      if (lastX !== startX || lastY !== startY) applyMove(lastX, lastY);
      if (released) { onUp(); return; }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    } else {
      release();
    }
  };

  // 文字工具逻辑
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
    
    // 输入框位置定位到卡片左上角（根据命中的目标矩形来换算）
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

  /** 画框左上角该摆在窗口的哪个位置。还没量到窗口大小时先不摆(那一帧在绘制前就过去了) */
  const frameXY = boxSize ? frameOrigin(cam, project, boxSize) : null;

  return (
    <div className={mobile ? "pc-pv pc-pv--mobile" : "pc-pv"} data-pc="preview">
      {!mobile && <div className="pc-pv-tabs" data-pc="preview-tabs">
        {([["2d", "2D"], ["3d", "3D"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={view === id ? "is-on" : undefined}
            onClick={() => setView(id)}
            title={id === "2d" ? "成片预览:所见即导出所得" : "三维视图:像 Blender 那样绕着看这些卡在空间里怎么摆"}
          >
            {label}
          </button>
        ))}
      </div>}

      {view === "2d" && !mobile && <ToolBar tool={tool} onToolChange={setTool} zoom={cam.scale} fitted={cam.auto} onFit={fitToWindow} />}

      {/*
        * **2D 这一页在 3D 页下面常驻,只是藏起来,不卸载。**
        *
        * 以前是 `view === "3d" ? <3D/> : <2D/>`,切到 3D 就把舞台 iframe 连同主文档的音频层一起卸掉。
        * 可播放头**跟随舞台**(docs/semantics/product/rendering.md「播放头跟随舞台」,K4:
        * 非 legacy 下只有可见舞台的 `frame` 事件在推 `t`)—— 舞台没了,3D 页按播放就什么都不会动,
        * 声音也没了。现在舞台一直在跑,3D 页读的还是同一个 `t`,播放轴和声音和 2D 页一模一样。
        *
        * 藏法只能是 `opacity: 0` + 不收指针(和后台舞台同一个理由,见 iframe B 的注释):
        * `display: none` 会让 iframe 里的 rAF 和 `<video>` 停掉,`visibility: hidden` 会让 `isSolid`
        * 判错实体框。`inert` 顺带挡掉键盘焦点落进看不见的那一页。
        * 藏起来的那一页 `inset: 0` 铺在同一块地方,窗口尺寸不变,切回 2D 不用重新适应缩放。
        */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {view === "3d" && (
        <div className="pc-pv-stage" style={{ position: "relative" }}>
          <Scene3DView project={project} t={t} />
        </div>
      )}
      <div
        ref={boxRef}
        className="pc-pv-stage"
        data-pc="preview-2d"
        aria-hidden={view === "3d" || undefined}
        inert={view === "3d"}
        style={view === "3d" ? { position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" } : undefined}
      >
        <div
          className="pc-pv-frame pc-checker"
          style={{
            width: project.width * scale,
            height: project.height * scale,
            /*
             * 位置完全由自己算(见 boxSize 那段说明:靠浏览器居中在放大之后会失准)。
             * 绝对定位到左上角,再用 transform 挪到该在的地方 —— transform 不触发重排,
             * 拖动时每一帧都在改它,用 left/top 会一路重排。
             */
            position: "absolute",
            left: 0,
            top: 0,
            transform: frameXY ? `translate(${frameXY.x}px, ${frameXY.y}px)` : undefined,
            /*
             * 透明棋盘格搬到 .pc-checker 了(见 preview/preview.css)。
             *
             * 原来这儿内联写着另一套偏暗的值,理由是「配色规范 04 条:透明格要比周围画布更暗更弱」。
             * 那条规矩本身没错,但它和这块底真正要回答的问题冲突:**这儿是不是什么都没有?**
             * 底一暗,一张深色的卡和「什么都没画」就长得一模一样 —— see_frames 和 3D 视图
             * 都因为这个踩过坑。而且 2D 和 3D 两页各用一套值,同一个项目在两页里
             * 「透明」长得都不一样。所以统一到中灰那一套,和 see_frames 逐值对齐。
             */
          }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, ...themeStyle(project.themeId) }}>
            <div style={{ position: "relative", width: project.width, height: project.height }}>
              {/* K4 的 `mediaStalled`:舞台的一拍比应到时刻晚出超过 40 ms 时,音频跟着停一下;这一轮播放的第一拍到之前音频不起播 */}
              <MediaLayers project={project} t={t} playing={playing && !mediaStalled && (!live || firstBeatRef.current)} masterVolume={muted ? 0 : volume} audioOnly localHashes={tierList} />
              {/*
                * 舞台 iframe 按槽位挂:单舞台(`single`,舞台闸门第一级、最低一档、握手失败退回,都是跨源 A)、跨源的 A(`dualA`)、
                * 跨源的 B(`dualB`),顺序固定、按槽位作 key。
                * 在线模式下一律跨源隔离:读不到舞台源时不再退回同源单舞台,直接不挂载舞台 iframe(2026-10-14 用户定);
                * 握手失败退回跨源单舞台 A(只管当次,不留崩溃记录;`mechanism/platforms.md`「三道闸门」)。
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
                    title="预览舞台"
                    onLoad={() => onStageFrameLoad("A")}
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
                    title="预览舞台"
                    src={stageSrc("A", { dual: true })}
                    onLoad={() => onStageFrameLoad("A")}
                    style={{
                      ...base,
                      ...(live && frontId === "A" ? { opacity: 1 } : hidden),
                    }}
                  />);
                  if (backStageMount) {
                    out.push(<iframe
                      key="dualB"
                      ref={frameRefOf.B}
                      data-pc="stage-frame-back"
                      title="后台舞台"
                      src={stageSrc("B", { dual: true })}
                      onLoad={() => onStageFrameLoad("B")}
                      style={{
                        ...base,
                        ...(frontId === "B" ? { opacity: 1 } : hidden),
                      }}
                    />);
                  }
                }
                return out;              })()}
              {/*
                * R7(D5):整帧 `<img>` / `MovPlayer` canvas **只留在 legacy 分支**。
                * 露出舞台之后再画一层整帧,等于把舞台盖住,而且那一层要等 HTTP
                * ——「暂停拖动画面同一帧内更新、不等待 HTTP」这条就没了。
                */}
              {!live && <UnifiedPreview project={project} t={t} playing={playing} />}
            </div>
          </div>
          
          {/* 四角标记:设计稿画面四角各一个 16 方的 L 形,提示这是可编辑画布 */}
          <span className="pc-pv-corner tl" aria-hidden="true" />
          <span className="pc-pv-corner tr" aria-hidden="true" />
          <span className="pc-pv-corner bl" aria-hidden="true" />
          <span className="pc-pv-corner br" aria-hidden="true" />

          {/* 画布覆盖层，处理命中测试以及拖拽绘制 */}
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

              // 描边贴着实体范围;刚点中的那个用 key 带上 token,每次点击都重新跑一遍脉冲动画
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
      </div>
      </div>

      {!mobile && <ControlBar />}
      
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
