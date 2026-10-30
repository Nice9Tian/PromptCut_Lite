import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FrameScene } from "./render/FrameScene";
import { Stage } from "./render/Stage";
import { installExportClock } from "./kernel/exportClock";
import type { Timeline } from "./kernel/types";
import { flattenOverlay, type Project } from "./kernel/project";
import { flatPlanProject, withFlatNodes } from "./kernel/cutFlatten.mjs";
import { themeStyle } from "./themes";
import { allCards, getCard, unknownCardClipIds, userCardSources } from "./kernel/registry";
import { cardSourceVersion } from "./render/cardSourceVersion.mjs";
import { builtinCardSourceFiles } from "./render/cardSourceFiles.mjs";
import { projectCardGraph } from "./kernel/cardGraph.mjs";
import { withMediaRates } from "./kernel/clipTime.mjs";
import { planFrameWindow } from "./render/frameWindow.mjs";
import { createSnapshot } from "./render/createSnapshot";
import { solidApi } from "./render/solid";
import { settleDom } from "./render/snapshotSettle";
import { installFrameMedia } from "./render/frameMedia";
import { clipFrameMode } from "./kernel/frameMode.mjs";
import { fontFingerprintOf } from "./render/fontFingerprint";
import { frameWorkStatus, waitForFrameWork } from "./kernel/frameReady";
import { demoTimeline } from "./demo";
import { createGlHost, type GlHost } from "./render/gl/glHost";
import { grabCanvasPixels } from "./render/gl/canvasGrab";
import "./cards";

// 只要进了导出视图就把页面时钟量化到导出帧(见 exportClock.ts),必须早于任何卡片挂载
if (new URLSearchParams(location.search).has("export")) installExportClock();
// 素材装载器也必须早于任何卡片挂载:推进动画的过程中一律不给素材赋 URL(原 scripts/frame-media.mjs,现 server/bakery/frame-media.mjs)
if (new URLSearchParams(location.search).has("export")) installFrameMedia();

/*
 * ?cardsOnly=1:素材(视频 / 图片)一概不挂,只渲卡片的透明层。
 * 默认导出和 see_frames 走完整的 Chrome FrameScene；显式 --media=ffmpeg 时才走这条
 * 卡片透明层旁路。保留 cardsOnly 是为了兼容旁路和需要只渲卡片的调用。
 */
const CARDS_ONLY = new URLSearchParams(location.search).get("cardsOnly") === "1";
function stripMedia(p: Project): Project {
  return { ...p, media: [], tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => !c.mediaId) })) };
}

/**
 * 导出视图(?export=1)。导出脚本的每帧顺序:
 *   1. page.evaluate(window.__pcSetT(sec))  → 写 __pcExportMs、setT 触发 React 重渲染
 *   2. 推进 CDP 虚拟时间 1/fps(React 提交、rAF、Motion 建动画都在这一格里发生)
 *   3. window.__pcSyncAnims() 把所有 Web Animations 的 currentTime 钉到导出时间
 *   4. 等素材(图片 decode、视频 seek)→ 截图
 * 页面挂载后把 window.__pcReady 置 true,脚本等它。
 * 时间轴可由 ?timeline=<url> 指定(JSON),默认用 demo。
 */
export default function ExportView() {
  const [t, setT] = useState(0);
  const [directT, setDirectT] = useState(0);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [playToken, setPlayToken] = useState(1);
  const [frameClipIds, setFrameClipIds] = useState<Set<string> | null>(null);
  const renderProject = useMemo(() => !project || !frameClipIds ? project : ({ ...project,
    tracks: project.tracks.map(tr => ({ ...tr, clips: tr.clips.filter(c => (!c.cardId && !c.nodeId) || frameClipIds.has(c.id)) })),
  }), [project, frameClipIds]);
  const renderTimeline = useMemo(() => !timeline || !frameClipIds ? timeline : ({ ...timeline,
    clips: timeline.clips.filter(c => frameClipIds.has(c.id)),
  }), [timeline, frameClipIds]);
  /*
   * canvas 卡的共享 WebGL 渲染器(R9 M2)。**导出页永远走路线 1**:预渲染进程里没有父页,自己持一个上下文
   * (懒建:这一帧真有 canvas 卡要画才建,纯 DOM 的项目一个都不开,DOM 一个字不变)。
   *
   * **现在在导出页的主线程上画**(同一份渲染器代码、同一张 `programs.ts`、同一套 MSAA FBO → blit → 裁位图),
   * 不开 Worker:受帧控制的导出页里,Worker 主脚本那个请求的收尾事件报在 Worker 自己的 target 上,
   * `server/bakery/chrome.mjs` 的 `waitNet` 在页面的 Network 域里看它一直「在路上」,每帧白等 30 秒后报错(实测)。
   * 导出页的主线程不是用户的交互线程,在这里画不卡任何人。`chrome.mjs` 放过 `blob:` 脚本之后
   * (补丁见 R9 报告),带 `?glWorker=1` 就改走 Worker —— 像素相同,那是同一份代码。
   */
  const glHost = useRef<GlHost | null>(null);
  useEffect(() => {
    const worker = new URLSearchParams(location.search).get("glWorker") === "1";
    const host = createGlHost({ stageId: "export", compact: false, route: "perDocument", mainThread: !worker });
    glHost.current = host;
    return () => { host.dispose(); if (glHost.current === host) glHost.current = null; };
  }, []);
  /*
   * 导出页 / 预渲染页**每一帧**发一拍(M3)。帧推进由 `__pcSetT` 的 `flushSync` 驱动,`beat` 就发在
   * **那次提交的 layout effect** 里 —— gl 平面的登记(子组件的 layout effect)这时已经做完。
   * 严格的拍:编译、纹理没好就等,不留空帧。`glHost` 自己领 `beginFrameWork('gl')` 的票、收到 `done` 再还,
   * 所以 `__pcFrameReady`(下面挂的 `waitForFrameWork`)天然把 `done` 等进来,Node 端照旧等它。
   * 不写依赖:任何一次提交(换帧、换分片窗口、重挂载)都可能换了 gl 平面上该画的那一帧。
   */
  useLayoutEffect(() => {
    void glHost.current?.beat({ strict: true, t });
  });
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, []);

  useEffect(() => {
    const url = new URLSearchParams(location.search).get("timeline");
    (url ? fetch(url).then((r) => r.json()) : Promise.resolve(demoTimeline))
      .then(async (json: unknown) => {
        // 素材保持占位,到截图那一帧才加载。
        if (json && Array.isArray((json as Project).tracks)) return CARDS_ONLY ? stripMedia(json as Project) : (json as Project);
        return json;
      })
      // 命名函数表达式:函数体既是首次加载的装配流程,也是换项目时要重跑的那一套。
      // 取个名字就能在体内自己调用(见下面的 __pcLoadProject),不用把这一大块抽出去。
      .then(function install(json: any, options?: { deferCards?: boolean }) {
      let tl: Timeline;
      let proj: Project | null = null;
      /*
       * 整个 install() 只算这一次图,下面的 __pcCardPlan 闭包和渲染体都复用它。
       * **必须兜底**:projectCardGraph 会对悬空输入抛(删掉套了滤镜素材效果卡的素材段就是这种),
       * 在这一层不接住就是舞台整棵树卸载、预渲染页永远不 ready。
       */
      let graph: ReturnType<typeof projectCardGraph> | undefined;

      if (json && Array.isArray(json.tracks)) {
        proj = json as Project;
        // 变速段的素材节点补上倍率(kernel/clipTime.mjs 的 withMediaRates;没有变速段时原样)
        try { graph = withMediaRates(proj, projectCardGraph(proj, getCard)); } catch { graph = undefined; }
        tl = flattenOverlay(proj, graph);
      } else {
        tl = json as Timeline;
      }

      setProject(proj);
      setTimeline(tl);
      setFrameClipIds(options?.deferCards ? new Set() : null);
      setT(0);
      setDirectT(0);
      window.__pcTimeline = tl;
      window.__pcCardPlan = () => {
        if (!proj) return null;
        const user = userCardSources();
        const sourceVersions: Record<string, string> = {};
        for (const card of allCards()) {
          const file = user.fileOf[card.id];
          if (file && user.files[file] !== undefined) {
            // This is the exact TSX text received from cards/index.  A user
            // edit changes the server's content key without making unrelated
            // builtin controls cold.
            sourceVersions[card.id] = `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`;
          } else {
            // Builtins have no user-source file.  Component source plus the
            // declarative runtime contract is a stable in-process dependency
            // fingerprint and catches HMR replacement of their implementation.
            sourceVersions[card.id] = `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
          }
        }
        /*
         * 剪辑段换成它里面的卡(`kernel/cutFlatten.mjs` 的摊平视图):剪辑段里的卡和父时间轴上的卡一样进卡片计划
         * (测量、分派、各自产单卡流)。渲染用的图(上面的 `graph`)不变,画面照旧走嵌套场景。没有剪辑段的项目原样不变
         */
        const flat = flatPlanProject(proj);
        let planGraph = graph;
        if (flat !== proj) { try { planGraph = withFlatNodes(flat, withMediaRates(flat, projectCardGraph(flat, getCard))); } catch { planGraph = undefined; } }
        return { graph: planGraph ?? withMediaRates(flat, projectCardGraph(flat, getCard)), sourceVersions,
          /*
           * 这个页面的注册表里查不到定义的卡片段(未知卡片;预渲染进程里没有同步表,等于「没有定义」)。舞台不画它们,
           * `CardFrameCache.plan()` 据此不给它们出控件:不排预渲染、不进预渲染集合、层表里没有它们那一层。
           * 图本身不动(别的卡的键逐字不变)。
           */
          unknownClipIds: [...unknownCardClipIds(flat.tracks.flatMap((track) => track.clips))].sort(),
          environment: { width: proj.width, height: proj.height, fps: proj.fps, theme: proj.themeId,
            // I0:这一帧排版实际用上的字体集合。共享快照键要它 —— 缺字体的机器
            // 画出来的 HTML 不一样,不能和有字体的机器共用一份快照。
            fontFingerprint: fontFingerprintOf(document.fonts as unknown as Iterable<{ family: string; status: string }>) } };
      };
      /** 音频素材效果卡的片段:有 nodeId、没有 cardId(按 H2 它不写 cardId) */
      const audioNode = (nodeId?: string) => !!nodeId && !!proj?.cardNodes?.some(node => node.id === nodeId && node.kind === 'audio');
      /*
       * 音频素材效果卡的片段整个排除:它没有 cardId,照字面收进来就是 getCard('') → 兜底 stateful,
       * 于是一条铺满全片的音频卡被算进 replayClips,每个导出分片都从第 0 帧回放。
       */
      const plannedClips = [...tl.clips, ...(proj?.tracks.filter(track => !track.hidden).flatMap(track => track.clips
        .filter(clip => clip.nodeId && !clip.cardId && !audioNode(clip.nodeId)).map(clip => ({ ...clip, cardId: '' }))) || [])];
      // Parallel export cuts only where no stateful card is mounted on both sides.
      // 只有**不出画**的音频素材效果卡才无条件 direct;其余素材效果卡片段照它自己的声明算 ——
      // 沿用「有节点就 direct」会让声明 stateful 的素材效果卡在导出里不进回放窗口,
      // 而预览按 clipFrameMode 给它回放钟,两边时间口径静默分叉且不报错。
      window.__pcClipFrameModes = () => plannedClips.map(clip => ({ id: clip.id, start: clip.start, end: clip.end,
        mode: audioNode(clip.nodeId) ? 'direct' : clipFrameMode(clip, getCard(clip.cardId)) }));
      window.__pcPlanFrameWindow = (frames, fps) => planFrameWindow(plannedClips, frames, fps,
        clip => {
          const runtime = (proj as any)?._cardRender;
          const requested = frames.filter(frame => frame / fps >= clip.start && frame / fps < clip.end);
          if (audioNode(clip.nodeId) || requested.length && requested.every(frame => runtime?.frames?.[clip.id]?.[frame] || runtime?.missing?.[frame]?.includes(clip.id))) return 'direct';
          return clipFrameMode(clip, getCard(clip.cardId));
        });
      window.__pcExportMs = 0;
      // 排空 / 生成快照:原来由 export-frames.mjs(现 server/bakery/chrome.mjs)的 PAGE_PRELUDE 注入,现在是页面 bundle 的一部分(J1)。
      window.__bfSettle = settleDom;
      window.__pcCreateSnapshot = () => createSnapshot(document.querySelector("[data-pc-scene]"));
      // D3(c):实体几何的导出面,只给 puppeteer 侧 page.evaluate 用(/api/cards/layout 对快照 DOM 量 contentBox),页面内部不经它
      window.__pcSolid = solidApi;
      window.__pcCanvasBox = solidApi.canvasPaintedBox;
      // 画布直取(己一):产轨道流时预渲染进程问页面要画布的像素,不经过截图(`server/bakery/capture-canvas.mjs`)
      (window as unknown as { __pcGrabCanvas?: typeof grabCanvasPixels }).__pcGrabCanvas = grabCanvasPixels;


      window.__pcSetT = (sec: number, directSec = sec) => {
        window.__pcExportMs = sec * 1000;
        // flushSync:和下面 __pcRestartCards 同一个理由 —— 这一帧的渲染(尤其是 clip 边界上
        // 卡片的挂载/卸载)必须在这次调用里同步提交完。不然 React 把它排进调度器,落在
        // 下一格虚拟时间的哪个位置取决于这一帧截图花了多少真实时间;Motion 要等挂载提交后的
        // 下一次 rAF 才建 WAAPI 动画,于是动画有时算进这一帧、有时要到下一帧才被 __pcSyncAnims
        // 看见,锚点差一帧,整段入场差一帧相位。实测 demo 时间轴 blur-fade 卡切进来那一段
        // (第 60~71 帧)连导两趟约一半概率全不同,就是它。同步提交之后,挂载在推进虚拟时间之前
        // 就已落地,第一次 rAF 里 Motion 就把动画建好,不再依赖截图耗时。
        flushSync(() => { setT(sec); setDirectT(directSec); });

      };
      window.__pcFrameReady = waitForFrameWork;
      window.__pcFrameWorkStatus = frameWorkStatus;
      window.__pcSetFrameWindow = (clipIds, startTime, directTime = startTime) => {
        // Dispose the preceding pass before moving its clock. Mount only the
        // selected cards, with the clock already at their first replay frame.
        flushSync(() => setFrameClipIds(new Set()));
        window.__pcExportMs = startTime * 1000;
        window.__pcResetRandom?.(1);
        window.__pcResetAnims?.();
        flushSync(() => {
          setT(startTime);
          setDirectT(directTime);
          setFrameClipIds(clipIds === null ? null : new Set(clipIds));
          setPlayToken(n => n + 1);
        });
      };

      // flushSync:重挂载在这次调用里同步完成。否则 React 的调度任务落在下一格虚拟时间的哪个位置
      // 两次导出不一样,卡片的第一帧就会差一帧。
      window.__pcRestartCards = () => {
        // 随机种子先拨回起点,再重挂载:卡片挂载时抽的随机数(粒子初始位置之类)每趟都一样
        window.__pcResetRandom?.(1);
        flushSync(() => setPlayToken((n) => n + 1));
      };

      // 动画锚点:每个 Web Animation 首次出现那一帧的导出毫秒。
      // 导出脚本每帧推进完虚拟时间后调 __pcSyncAnims,把 currentTime 钉到「现在 − 锚点」再截图。
      // CSS / WAAPI 动画钟和虚拟时钟不同步,用实测比值校正 playbackRate 会随机器负载变;显式钉时间与负载无关。
      let anchors = new WeakMap<Animation, number>();
      window.__pcResetAnims = () => {
        anchors = new WeakMap<Animation, number>();
      };
      // 必须 pause:transform / opacity 这类动画跑在合成线程上,只设 currentTime 不暂停的话,
      // 截图那一帧合成器仍按它自己的时钟采样,两次导出差零点几帧。暂停后数值只由 currentTime 决定。
      // 越过结尾的用 finish():Motion 等 finished 才提交终态样式,CSS 动画则回到自然样式,和正常播完一致。
      // 这一帧被 finish() 收束的动画数。静态判定要看它:动画在这一帧从"还差一小段"跳到终态,
      // 画面是变了的,但收束之后 getAnimations() 里它已经是 finished、DOM 也没被改过 ——
      // 探针只看得见"结束后的状态",看不见"在这一帧结束"这件事。实测 type-shift 外层过渡恰好在
      // 第 6 帧结束,静态跳过复用了第 5 帧,和不跳过差 28085 个像素。
      let finishedThisFrame = 0;
      window.__pcSyncAnims = () => {
        const now = window.__pcExportMs ?? 0;
        finishedThisFrame = 0;
        for (const a of document.getAnimations()) {
          if (a.playState === "finished" || a.playState === "idle") continue;
          let s0 = anchors.get(a);
          if (s0 === undefined) {
            s0 = now;
            anchors.set(a, s0);
          }
          const target = Math.max(0, now - s0);
          const end = a.effect?.getComputedTiming().endTime;
          if (typeof end === "number" && Number.isFinite(end) && target >= end) {
            a.finish();
            finishedThisFrame++;
            continue;
          }
          if (a.playState !== "paused") a.pause();
          a.currentTime = target;
        }
      };
      /**
       * 这一帧画面静不静止。四个条件同时成立才算,因为单看任何一个都会漏:
       *   anims —— getAnimations() 只看得见 CSS/过渡/WAAPI;
       *   mut   —— 补上它看不见的 JS 动画(Motion 的 MotionValue,例如 rank-bars 的滚动数值),
       *            以及卡片刚重挂载、动画还没建起来那几帧 —— 那时 anims 是 0,画面却在变;
       *   raf   —— 走了被替换的 rAF 的第三方循环。Motion 走不到这里(见 exportClock.ts),
       *            留着是因为不要钱,多罩一层算一层;
       *   video —— 前三个都看不见的第四种变化:底下 <video> 在放。它自己会变,而且
       *            卡片上的 backdrop-filter 毛玻璃会把它的变化采样进来,于是毫无动画的玻璃板也在逐帧变。
       * 判静态是为了复用上一帧的截图,判错了会渲出坏帧,所以宁可保守。
       */
      window.__pcStaticProbe = () => ({
        anims: document.getAnimations().filter((a) => a.playState !== "finished" && a.playState !== "idle").length,
        finished: finishedThisFrame,
        raf: window.__pcRafCount ?? 0,
        mut: window.__pcMutationCount ?? 0,
        video: Array.from(document.querySelectorAll("video")).some((v) => {
          const s = getComputedStyle(v);
          return s.visibility !== "hidden" && parseFloat(s.opacity) > 0;
        }),
        // canvas 上画的东西不在 DOM 里,MutationObserver 看不见;有可见的 canvas 就不敢判静止
        canvas: Array.from(document.querySelectorAll("canvas")).some((c) => {
          const s = getComputedStyle(c);
          return s.visibility !== "hidden" && parseFloat(s.opacity) > 0 && c.width > 0 && c.height > 0;
        }),
      });
      /**
       * 原地换一个项目,不重新导航。常驻预渲染进程靠它复用同一个页面:
       * 起 Chrome + goto + 字体首次布局加起来是固定的几秒钟,每渲一次都重付一遍太贵。
       * 走的是 install 自己,和重新加载页面同一条路径,不会两套行为。
       */
      window.__pcLoadProject = async (raw: unknown, options?: { deferCards?: boolean }) => {
        window.__pcReady = false;
        const next = raw && Array.isArray((raw as Project).tracks)
          ? (CARDS_ONLY ? stripMedia(raw as Project) : (raw as Project))
          : raw;
        install(next, options);
      };

      window.__pcReady = true;
    });
  }, []);


  if (!timeline) return null;

  return (
    <div
      data-pc-scene=""
      style={{
        position: "relative",
        width: timeline.width,
        height: timeline.height,
        overflow: "hidden",
        background: "transparent",
        /*
         * **主题变量必须挂在这里**,和 StageView 那一处对齐。
         *
         * 少了它,卡片里每一处 `var(--pc-…, 兜底)` 在导出里都会走兜底 —— 而预览走的是主题值。
         * 默认主题下大部分兜底和主题值碰巧相同,所以这条漏了很久都没被发现;只有等宽字体
         * 露了馅:主题是 `ui-monospace, Consolas, monospace`,兜底是 `ui-monospace, monospace`,
         * 后者在 Windows 上落到 NSimSun —— 预览里是带斜杠零的 Consolas,成片里是一套衬线字。
         * 换个主题(比如 Courier New 那套、或者任何改了配色的)就是全线不一致。
         */
        ...themeStyle(timeline.themeId),
      }}
    >
      {renderProject ? <FrameScene project={renderProject} sourceProject={project!} t={t} directT={directT} playToken={playToken} graph={timeline.graph} />
        : <Stage timeline={renderTimeline!} t={t} directT={directT} playToken={playToken} mountClock />}

    </div>
  );
}
