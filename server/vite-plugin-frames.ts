import type { Plugin } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { captureCode, frameCode, invalidateFrameCode } from "./frame-code.mjs";
import { FramePipeline } from "./frame-pipeline.mjs";
import { unpackFrameArchive } from "./frame-archive.mjs";
import { overLimit } from "./http-guard.mjs";
import { prerenderState, proxyToPrerender } from "./prerender-client.mjs";
import { isPrerender } from "./render-role.mjs";
import { prerenderModeOf, modeServesPrerender } from "./prerender-mode.mjs";

/**
 * 本进程的预渲染模式(`prerender-mode.mjs`;`PROMPTCUT_PRERENDER_MODE`,由编辑器进程拉起时传)。只在预渲染进程里有意义;
 * 编辑器进程恒为 `full`(它的管线 `interactive: false`,本来就没有这些 lane)。
 */
const prerenderMode = isPrerender ? prerenderModeOf(process.env) : "full";
/** 本进程做不做预渲染:`agent` 模式不做 —— 不起渲染节点、不建推送队列、`/preload` 回 `skipped` */
const servesPrerender = modeServesPrerender(prerenderMode);
import { ensureMirror } from "./vite-plugin-mirror";

import { latestPlayhead, reportReadySession } from "./vite-plugin-mirror";
import { readySessionOf } from "./ready-index.mjs";
import { sessionDiagOf, sessionLogger } from "./render-node/session-diag.mjs";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { assetServiceOrigin, setMediaFallbackBases, setMediaFallbackTicket } from "./asset-client";
import { renderProject } from "./render-project.mjs";
import { resolvePublishVersion } from "./queue-publish.mjs";
import { createCardCodeIndex } from "./card-code.mjs";
import { cardCodeIdentityOf, onCardSourceChange, overridesRoot } from "./card-overrides.mjs";
import { foreignAssetEndpoints, selectAssetClient as selectAssetClientImpl } from "./asset-select.mjs";
import { setBakeRemote } from "./bake-store.mjs";
import { ALL as SCOPE_ALL, createPushScope } from "./push-scope.mjs";
import { closeStorage, createExportSummary, storageDataDir, storageFor } from "./frame-library-storage.mjs";
import { createStorageHandler, storageRouteOf } from "./storage-routes.mjs";

const services = new Map<string, FramePipeline>();
/**
 * 卡片代码身份(c66-host-cards,`server/card-code.mjs`):每个根一份。算法由卡片插件注入(`setCardIdentifier`),
 * 卡片源码一变(Vite 已经作废了模块之后)整表清空。整场景键、队列切分的 `requires.cardSources`、节点的
 * `cardSourceVersions` 都从这里取。
 */
const cardCodes = new Map<string, ReturnType<typeof createCardCodeIndex>>();
function cardCode(root: string) {
  let index = cardCodes.get(root);
  if (!index) {
    index = createCardCodeIndex({ identityOf: (cardId: string) => cardCodeIdentityOf(cardId) });
    cardCodes.set(root, index);
  }
  return index;
}
onCardSourceChange(() => { for (const index of cardCodes.values()) index.invalidate(); });
/** C6.4:每个帧库根上的推送队列怎么收尾(停队列、关文档服务连接);没建推送队列的根不在这里 */
const pushTeardowns = new Map<string, () => Promise<void>>();

const pushLog = (event: string, fields: object = {}) => {
  // 每段推完一条太吵(预渲染进程的 stdout 由编辑器进程收走),只打建队、跳过、重试和出错
  if (event === "push.done" || event === "push.empty") return;
  try { console.info("[artifact-push]", event, JSON.stringify(fields)); } catch { console.info("[artifact-push]", event); }
};

/**
 * C6.4 第 4 节末段的接线(`docs/plan/manifest-contract.md`;阶段报告 `docs/reports/REPORT-c6-4.md`):
 * 预渲染进程只在**同时**满足下面两条时才建推送队列,否则什么都不建,行为与现在相同 —— 这就是离线。
 *
 *   1. 能解析到素材服务的基址:`asset-client.ts` 的 `assetServiceOrigin()`(预渲染进程里就是 `PROMPTCUT_EDITOR_URL`),
 *      API 基址 `<源>/api/asset`;真正推到哪一台按 D7 选(`selectAssetClient`,契约 J.13);
 *   2. 能连上文档服务:`render-node` 的 `resolveDocservice()` 回 `remote`、`local` 或 `editor`(M5b J.3:编辑器里挂的
 *      那一份,地址从 `PROMPTCUT_EDITOR_URL` 推出)。**`editor` 只在显式要推送时才算**(契约 J.12):
 *      进程设了 `PROMPTCUT_QUEUE_NODE=1` 或 `PROMPTCUT_PUSH=1`。都没设时编辑器里挂的那一份不算,不建推送队列、
 *      preload 前也不拉别人的结果,行为与 C6.4 之前逐字节相同 —— 默认的开发环境(含用户常驻的编辑器)不变,
 *      探针能在同一个工作副本里反复跑。`remote`、`local`(显式设了地址、或起了独立文档服务)照旧建。
 *   3. `PROMPTCUT_PUSH=0`:一律不建,不管哪种模式。
 *
 * 内容库客户端 `createContentClient` 在 `render-node/index.mjs` 里(C6.4 节点侧);取不到这个函数也不建。
 * 任何一步出错都只打日志,不影响预渲染进程。
 */
/**
 * 推送、拉取用的素材服务客户端(契约 J.13,按 D7 选基址;实现与第一次调用前等登记见 `asset-select.mjs`)。
 * 这里只把日志接到 `[artifact-push]`。
 */
function selectAssetClient(opts: { node: any; endpoint: any; origin: string; ticket: ((opts?: { refresh?: boolean }) => Promise<string | null>) | null; createAssetClient: any; owner: string;
    /** 自动渲染节点:页面此刻用的素材服务基址(页面给了就排在登记之前;现取,页面换了基址下一次调用就换) */
    preferred?: () => string | null }) {
  return selectAssetClientImpl({ ...opts, log: pushLog });
}

/**
 * `resolveDocservice` 这几种结果算「连得上文档服务」;`editor` 是 J.3 新加的(编辑器里挂的文档服务);`shared` 是 M6a 的共享项目配置;
 * `page` 是自动渲染节点(页面交来的共享配置,`auto-render-node.mjs`)
 */
const DOCSERVICE_MODES = new Set(["remote", "local", "editor", "shared", "page"]);

/**
 * `contentIds`:这条连接只推哪几个项目文档的产物(`push-scope.mjs`)。老路径凭 `PROMPTCUT_SHARED_CONFIG` 进入、配置里写了
 * `contentId` 时是 `[contentId]`;没写、或本机身份(没有共享项目的边界)时不设 = 不限。
 */
type DocLink = { mode: string; url: string; tried?: any[]; protocols?: () => Promise<string[]>; shared: boolean; projectId?: string | null; contentIds?: string[] | null };

/**
 * 连哪个文档服务、凭什么进入(M6a,`docs/plan/auth-contract.md` 第 11 节):
 *   - 设了 `PROMPTCUT_SHARED_CONFIG`:用配置的第一项(是数组时只取第一项,多项目留给独立主机),
 *     凭共享项目的证明进入,角色 `render`;素材票据经这条连接的 `auth.ticket` 取。配置读不了回 `bad-config`;
 *   - 没设:照原来按 `resolveDocservice` 探活(远端 → 编辑器 → 本机回环),不带任何凭证 —— 连回环时是本机身份,
 *     连不上就回落本机。集群令牌不再用于数据面。
 */
async function resolveDocLink(node: any): Promise<DocLink | { mode: string; tried?: any[]; url?: undefined; shared: false; detail?: string }> {
  const resolved = await node.resolveDocservice();
  return { mode: resolved?.mode, url: resolved?.url, tried: resolved?.tried, shared: false };
}

async function ticketFor(_link: DocLink, _endpoint: any) {
  return null;
}
/**
 * 到文档服务的端点(`createDocEndpoint`,HT-a 契约 `docs/plan/http-transport-contract.md` 第 9 节)打的日志里,
 * 会话事件(建成、结束、脱开、接续、接续被拒、建不成等,`render-node/session-diag.mjs` 的 `SESSION_FORWARD_EVENTS`)
 * 按事件节流后进预渲染进程的日志,行首 `[queue-node] docservice.session.*` / `[artifact-push] docservice.session.*`;
 * 编辑器进程(`vite-plugin-prerender.ts`)把这几行转进自己的日志,独立渲染主机(`cloud/scripts/render-host.mjs`)照转
 * `[queue-node]` 行。传输的断开与接续只进日志与诊断,不打断队列。
 */
/** 诊断里的会话状态:实际用的传输(脱开时为 null)、接续次数、是否对着旧服务端退化,加会话计数 `session` */
const sessionDiag = (endpoint: any) => sessionDiagOf(endpoint);
/**
 * 推送队列认哪几种文档服务(契约 J.12):`remote`、`local` 总认;`editor` 只在显式要推送时认 ——
 * `PROMPTCUT_QUEUE_NODE=1` 或 `PROMPTCUT_PUSH=1`。
 */
const pushModeAllowed = (mode: unknown) => mode === "remote" || mode === "local" || mode === "shared"
  || (mode === "editor" && (process.env.PROMPTCUT_QUEUE_NODE === "1" || process.env.PROMPTCUT_PUSH === "1"));
async function startArtifactPush(root: string, service: FramePipeline, auto: AutoLink | null = null) {
  if (!isPrerender) return;
  if (process.env.PROMPTCUT_PUSH === "0") return pushLog("push.skip", { reason: "disabled" });
  // M6b:独立渲染主机没有页面、不做 preload,产物由各项目节点的 sink 推(契约 render-host-contract 第 3 节「产物」)
  if (hostProfile()) return pushLog("push.skip", { reason: "host-profile" });
  const origin = assetServiceOrigin();
  if (!origin) return pushLog("push.skip", { reason: "no-asset-service" });
  const node: any = await import("./render-node/index.mjs");
  if (typeof node.createContentClient !== "function") return pushLog("push.skip", { reason: "no-content-client" });
  /*
   * 连哪个文档服务:自动渲染节点(页面交来的共享配置,`auto-render-node.mjs`)直接用它;否则照原来按环境变量解析(J.12 的开关只管这一支)。
   */
  let resolved: any;
  if (auto) resolved = autoDocLink(auto);
  else {
    resolved = await resolveDocLink(node);
    if (resolved.mode === "bad-config") return pushLog("push.skip", { reason: "bad-shared-config", detail: (resolved as any).detail });
    if (!DOCSERVICE_MODES.has(resolved?.mode) || !resolved.url) {
      return pushLog("push.skip", { reason: "docservice-offline", tried: (resolved?.tried ?? []).map((t: any) => ({ url: t.url, ok: t.ok, reason: t.reason })) });
    }
    // J.12:编辑器里挂的文档服务,没显式要推送就不建(开关关着时与 C6.4 之前相同)
    if (!pushModeAllowed(resolved.mode)) return pushLog("push.skip", { reason: "editor-docservice-not-enabled", mode: resolved.mode });
  }
  if (services.get(root) !== service || (service as any).closed || (auto && !auto.alive())) return;
  const link = resolved as DocLink;
  const endpoint = node.createDocEndpoint({ url: link.url, ...(link.protocols ? { protocols: link.protocols } : {}),
    log: sessionLogger((event: string, fields: object) => pushLog(`docservice.${event}`, fields)) });
  const content = node.createContentClient(endpoint);
  const { createAssetClient }: any = await import("./asset-store/client.mjs");
  // J.13:按 D7 选推送的素材服务(环境变量 → 页面给的(自动渲染节点)→ 别的机器登记的 → 本机)
  // 第一次推送前先等登记(没有环境变量、页面也没给基址时),不先推到本机素材服务(`asset-select.mjs`)
  const assets = selectAssetClient({ node, endpoint, origin, ticket: await ticketFor(link, endpoint), createAssetClient, owner: "push", preferred: auto ? auto.assetBase : undefined });
  const client = assets.client;
  const { createPushQueue }: any = await import("./artifact-push.mjs");
  // 只推绑定项目的(`push-scope.mjs`):自动渲染节点按页面交来的项目文档 id(还没交来时先扣着);老路径按配置的 `contentId`
  const scoped = scopeOf(link, auto);
  const scope = scoped ? createPushScope({ pipeline: service, contentIds: scoped }) : null;
  // settleMs:同一段最后一次进队后静置 1.5 s 再推,边渲边推时一段不被推十几遍。
  // 限了项目的队列文件按项目分目录:撤掉时没推完的段留给同一个项目下次接着推,不推进别的项目的素材服务
  const queue = createPushQueue({ pipeline: service, client, content, dir: scoped && link.projectId ? pushDirOf(service, link.url, link.projectId) : service.root,
    log: pushLog, settleMs: 1500, scope });
  queue.start();
  /*
   * 卡片快照(bake_card、3D 视图的贴图)也是预渲染产物:写进本机素材服务之后再推一份到这一台(`bake-store.mjs`)。
   * 选定的就是本机素材服务时 bake-store 自己跳过。
   */
  const bakeRemote = { get base() { return assets.base(); }, put: (ns: string, bytes: Buffer, o?: any) => client.put(ns, bytes, o) };
  setBakeRemote(() => bakeRemote);
  pushTeardowns.set(root, async () => {
    setBakeRemote(null);
    try { await queue.stop(); } catch {}
    if ((service as any).pushQueue === queue) (service as any).pushQueue = null;
    assets.stop();
    try { endpoint.close(); } catch {}
  });
  pushLog("push.started", { docservice: resolved.mode, url: resolved.url, asset: assets.base(), assetSettled: assets.settled(), restored: queue.stats().restored,
    scope: scope ? scope.describe() : SCOPE_ALL, ...(link.projectId ? { projectId: link.projectId } : {}) });
}

/**
 * 推送队列只推哪几个项目文档的产物;回 null = 不限。
 *   - 自动渲染节点:页面交来的项目文档 id(`contentId`,现取;还没交来时回 null,推送队列先扣着);
 *   - 老路径凭 `PROMPTCUT_SHARED_CONFIG` 进入:配置里的 `contentId`;没写就不限(记一行 `push.scope`);
 *   - 本机身份(`editor` / `local` / `remote`,没有共享项目的边界):不限。
 */
function scopeOf(link: DocLink, auto: AutoLink | null): (() => typeof SCOPE_ALL | string[] | null) | null {
  if (auto) return () => (auto.contentId ? [auto.contentId] : null);
  if (link.shared && link.contentIds?.length) { const ids = [...link.contentIds]; return () => ids; }
  if (link.shared) pushLog("push.scope", { scope: SCOPE_ALL, reason: "no-content-id", projectId: link.projectId ?? null });
  return null;
}

/** 自动渲染节点交来的链接(`auto-render-node.mjs` 的 `link`) */
type AutoLink = { mode: "page"; url: string; shared: true; projectId: string; contentId: string | null; assetBase: () => string | null; protocols: () => Promise<string[]>; alive: () => boolean };
const autoDocLink = (auto: AutoLink): DocLink => ({ mode: "page", url: auto.url, protocols: auto.protocols, shared: true, projectId: auto.projectId });
/** 限了项目的推送队列文件所在目录:帧库下 `push/<文档服务 host>-<项目 id>`(只留安全字符);自动渲染节点与老路径同一个规则 */
function pushDirOf(service: FramePipeline, url: string, projectId: string) {
  let host = "doc";
  try { host = new URL(url).host; } catch { /* 地址已经校验过 */ }
  const name = `${host}-${projectId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return path.join((service as any).root, "push", name);
}

/* ======================================================================== *
 * 队列模式的预渲染进程(契约 `docs/plan/render-queue-contract.md` J.5)
 * ======================================================================== */

/** 开关:`PROMPTCUT_QUEUE_NODE=1`,缺省关。关着时下面的东西一样都不建,行为与现在完全一样 */
const queueNodeSwitch = () => process.env.PROMPTCUT_QUEUE_NODE === "1";
/**
 * M6b(`docs/plan/render-host-contract.md`):`PROMPTCUT_NODE_PROFILE=host` 时这个预渲染进程是独立渲染主机 ——
 * 节点 `profile: 'host'`,`PROMPTCUT_SHARED_CONFIG` 每项一条 `render` 连接、一个节点,不发布也不认领 `plan`。
 * 其余取值(含不设)都是本机 PC 节点,行为与 M6a 相同。
 */
const hostProfile = () => process.env.PROMPTCUT_NODE_PROFILE === "host";
/**
 * 测试开关(M6b 探针 H2 用):主机节点对外报的代码版本改用这个值,不取 `frameCode(root)`。
 * 只影响 `profile: 'host'` 的 `codeVersions`(本机 PC 节点与帧库的键都不看它)。生产不设。
 */
const TEST_CODE_VERSION_ENV = "PROMPTCUT_TEST_CODE_VERSION";
/** 文档服务项目模块认的 projectId(`docservice/modules/project.mjs` 的 `PROJECT_ID_RE`) */
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** 发布 `plan` 之后等 `task.published` 的上限 */
const PUBLISH_TIMEOUT_MS = 10_000;
/** 节点节拍:续约、认领、让路都在这一拍里判 */
const QUEUE_TICK_MS = 500;
/** 诊断里留最近这么多条事件 */
const QUEUE_LOG = 80;
/** 诊断里认领先后的条数(`claims`,c10a 契约第 17 节的验收用) */
const CLAIM_LOG = 400;
/** 诊断里本机节点认领 / 完成的任务 id,每类最多留几个 */
const MINE_MAX = 5000;

const queueLog = (event: string, fields: object = {}) => {
  try { console.info("[queue-node]", event, JSON.stringify(fields)); } catch { console.info("[queue-node]", event); }
};

/**
 * 逐任务的收尾事件进日志(`docs/archive/agent-reports/AGENT-stall-phases.md`):local-node 的 `lost` / `failed` / `discarded` / `completed` / `dedup`
 * 各打一行 `[queue-node] node.task-<类型> {…}`,带时刻、任务 id、原因、所处阶段、距上次帧数变化与距认领的毫秒数,推送阶段另带块数与用时
 * (task-runner 的 `info`)。编辑器进程的转发器(`session-diag.mjs` 的 `createSessionLineForwarder`)放行这几种行,
 * 独立渲染主机的日志(`cloud/scripts/render-host.mjs`)与 PC 编辑器的日志都看得到。只带诊断字段,不带会话号、票据、口令。
 */
const TASK_LOG_TYPES = new Set(["lost", "failed", "superseded", "discarded", "completed", "dedup"]);
function taskEventLog(event: any, extra: object = {}) {
  const type = event?.type;
  if (!TASK_LOG_TYPES.has(type)) return;
  const pick: Record<string, unknown> = { at: new Date().toISOString(), id: typeof event.id === "string" ? event.id : null, ...extra };
  for (const k of ["reason", "error", "why", "retryable", "phase", "detail", "done", "sinceDoneMs", "sinceClaimMs", "phaseMs", "push"]) {
    if (event[k] !== undefined) pick[k] = typeof event[k] === "string" ? event[k].slice(0, 300) : event[k];
  }
  queueLog(`node.task-${type}`, pick);
}

type QueueNode = {
  /** 连着文档服务、本机节点已经报到:`/preload` 走队列模式 */
  active(): boolean;
  /**
   * `/preload` 的队列那一半:定版本、发布 `plan`。回 true = 这一版交给队列了;false = 本机自己产。
   * `entryKey`:这一版的 entry(M6c X1 空档:切分方没切出流任务时,把这一版的流交还本机自动生产)
   * `raw` 是页面推来的原样项目(`project` 是 `renderProject` 之后的):项目在文档服务里有真身时拿它与真身比对(C6.5)。
   */
  publish(session: string, project: any, entryKey?: string, raw?: any): Promise<boolean>;
  describe(): object;
  /** `GET /api/frames/queue`(契约 render-host-contract 第 3 节「诊断」):`{ nodes, codeVersion, envFingerprint, maxConcurrent }` */
  summary(): object;
  /** `POST /api/frames/queue/release`:让掉手里全部认领、停节点、关连接(主机退出前调)。回让掉的条数 */
  release(): Promise<number>;
  close(): Promise<void>;
};
const queueNodes = new Map<string, QueueNode>();
/**
 * M6c X5:每个帧库根最近一次交互帧请求的时刻(`/see` 的 `user` lane、`/playback`)。本机队列节点的闲时门槛
 * (`queue-idle.mjs`)读它:最近 500 ms 有过就不认领新任务。开关关着时只是记一个数,别的什么都不做。
 */
const lastInteraction = new Map<string, number>();
const noteInteraction = (root: string) => { lastInteraction.set(root, Date.now()); };

/**
 * 本机节点(PC 与独立渲染主机)`node.hello` 报的能力(M6c X1,`docs/plan/m6c-contract.md`):
 *   - `userCards: true, graphCards: false`:同 M5b / M6b;
 *   - `streams`:按实报 —— 预渲染管线有轨道流生产者、开关开着(`PROMPTCUT_STREAMS` 不是 0)、探到了能用的 H.264
 *     编码器(`FramePipeline.streamCapable`,一次进程只探一次)才是 true;
 *   - `transcode`:与 `streams` 同一个判据(本机有 ffmpeg 且编码器能用)。节点侧过滤的规则 2 对流任务同时查
 *     `requires.capabilities.streams` 与转码能力(B.2),只报 `streams` 的节点认领不了流任务。
 */
async function nodeCapabilities(service: FramePipeline) {
  let streams = false;
  try { streams = (await (service as any).streamCapable?.()) === true; } catch { streams = false; }
  return { userCards: true, graphCards: false, transcode: streams, streams };
}

/**
 * J.5:开关打开、又连得上文档服务时,在预渲染进程里起一个本机渲染节点,并替页面发布 `plan`。
 *
 *   - 节点:`createLocalNode`(`profile: 'pc'`、`maxConcurrent: 1`、`capabilities` 见 `nodeCapabilities`(M6c X1 起带 `streams`),
 *     `codeVersions: [frameCode(root)]`;环境指纹在报到前借一次流预渲染间来探),执行器是 J.4 的
 *     `createPrerenderExecutor`,产物库是 C6.2 / C6.4 的 `createAssetSink({ pipeline, client, content })`;
 *   - 发布:`/preload` 在 `service.preload(…, { queue: true })` 之前调 `publish`:`project.announce` 拿 `projectRev`、
 *     `putSnapshot` 传快照、以本节点的发布方身份发布 `plan:<projectId>@<projectRev>`(`requires` 带版本与指纹);
 *     项目在文档服务里有真身时(C6.5)不发号、不上传,以真身的 rev 发布(`server/queue-publish.mjs`);
 *   - 收到 `task.done`:细任务的清单经 C6.2 的 `applyResult` 拉取并发布(本机产的已经在盘上,按「已有跳过」处理);
 *   - 连不上文档服务(断线):`service.leaveQueueMode()` 退回本机自己产,在跑的任务让掉;重连后新的 preload 再走队列;
 *   - 远端素材回退(J.6):订阅服务地址登记里的 `asset`,排除自己,填进 `setMediaFallbackBases`。
 *
 * M6c(`docs/plan/m6c-contract.md`):
 *   - X2:`executor.plan` 之后按这一版项目加本地档能力闸(`queue-local-media.mjs`),用到没有内容哈希的素材的细任务
 *     只给发布方的节点;
 *   - X4:发布 `plan` 时 `requires.preferNode` = 本机节点(队列给它 `PLAN_PREFER_MS` 的独占窗口);
 *   - X5:闲时门槛换成 `queue-idle.mjs`(最近 500 ms 没有交互帧请求即可认领,不等 preload 到 ready),
 *     忙时不认领新的、手里在做的做完。
 *
 * `createProjectClient`(J.2)在 `render-node/index.mjs` 里;取不到它(svc 分支还没合进来)就不起,打日志,
 * 预渲染进程照原来的路径跑。任何一步出错都只打日志。
 */
async function startQueueNode(root: string, service: FramePipeline, auto: AutoLink | null = null) {
  // 自动渲染节点(页面交来的共享配置)不看 `PROMPTCUT_QUEUE_NODE`:它由 `auto-render-node.mjs` 的开关管
  if (!isPrerender || (!auto && !queueNodeSwitch())) return;
  const stale = () => services.get(root) !== service || (service as any).closed || (auto !== null && !auto.alive());
  const origin = assetServiceOrigin();
  if (!origin) return queueLog("queue.skip", { reason: "no-asset-service" });
  const node: any = await import("./render-node/index.mjs");
  const missing = ["createProjectClient", "createContentClient", "createLocalNode", "createDocEndpoint", "planTaskOf", "watchServiceEndpoints"]
    .filter(name => typeof node[name] !== "function");
  if (missing.length) return queueLog("queue.skip", { reason: "render-node-exports-missing", missing });
  const resolved: any = auto ? autoDocLink(auto) : await resolveDocLink(node);
  if (resolved.mode === "bad-config") return queueLog("queue.skip", { reason: "bad-shared-config", detail: (resolved as any).detail });
  if (!DOCSERVICE_MODES.has(resolved?.mode) || !resolved.url) {
    return queueLog("queue.skip", { reason: "docservice-offline", tried: (resolved?.tried ?? []).map((t: any) => ({ url: t.url, ok: t.ok, reason: t.reason })) });
  }
  if (stale()) return;
  const link = resolved as DocLink;
  /** 只替哪几个项目文档发布 plan(同推送队列的范围,`scopeOf`);null = 不限 */
  const publishScope = auto ? () => (auto.contentId ? [auto.contentId] : null)
    : link.shared && link.contentIds?.length ? (() => { const ids = [...link.contentIds!]; return () => ids; })() : null;
  const outOfScopePublishLogged = new Set<string>();

  // 指纹:报到前借一次流预渲染间探(`leaseStreamBakery` 开起来就定下本进程的环境),什么都不做就还
  try {
    const bakery = await (service as any).leaseStreamBakery();
    (service as any).returnStreamBakery(bakery);
  } catch (error: any) {
    return queueLog("queue.skip", { reason: "no-environment", message: String(error?.message ?? error) });
  }
  const envFingerprint: string | null = (service as any).envFingerprint;
  if (!envFingerprint) return queueLog("queue.skip", { reason: "no-environment" });
  if (stale()) return;
  const capabilities = await nodeCapabilities(service);
  if (stale()) return;

  const { createPrerenderExecutor }: any = await import("./prerender-executor.mjs");
  const { createAssetSink, applyResult }: any = await import("./artifact-transfer.mjs");
  const { createAssetClient }: any = await import("./asset-store/client.mjs");

  const endpoint = node.createDocEndpoint({ url: link.url, ...(link.protocols ? { protocols: link.protocols } : {}),
    log: sessionLogger((event: string, fields: object) => queueLog(`docservice.${event}`, fields)) });
  const projects = node.createProjectClient(endpoint);
  const content = node.createContentClient(endpoint);
  // J.13:sink 推、task.done 拉,都用按 D7 选的素材服务
  const assetTicket = await ticketFor(link, endpoint);
  const assets = selectAssetClient({ node, endpoint, origin, ticket: assetTicket, createAssetClient, owner: "queue", preferred: auto ? auto.assetBase : undefined });
  // J.6 的回退读别的机器的素材服务:凭共享项目进入时带票据
  setMediaFallbackTicket(assetTicket ? () => assetTicket() : null);
  const client = assets.client;
  const events: object[] = [];
  const note = (event: string, fields: object = {}) => {
    events.push({ at: Date.now(), event, ...fields });
    while (events.length > QUEUE_LOG) events.shift();
  };
  const log = (event: string, fields: object = {}) => { note(event, fields); if (!/^executor\.render$/.test(event)) queueLog(event, fields); };
  const sink = createAssetSink({ pipeline: service, client, content, log });
  const baseExecutor = createPrerenderExecutor({ pipeline: service, projects, prepareProject: renderProject, log, codeStamp: () => cardCode(root).epoch });
  const host = String(os.hostname() || "host").replace(/[^A-Za-z0-9._:-]/g, "-");
  let editorPort = "";
  try { editorPort = new URL(origin).port; } catch { /* 没有端口就不带 */ }
  // 同一台机器上可能有几个编辑器各带一个预渲染进程:按编辑器端口区分节点身份
  const nodeId = `prerender:${host}${editorPort ? `:${editorPort}` : ""}`.slice(0, 128);
  const { withLocalMedia }: any = await import("./queue-local-media.mjs");
  const { createQueueIdleGate }: any = await import("./queue-idle.mjs");
  /**
   * M6c X2:算完计划,按这一版 entry 里的项目给 PlanContext 加本地档能力闸 —— 有没有内容哈希的素材时,用到它们的
   * 细任务写 `requires.localMedia = <plan 的发布方>`(素材在发布方本机;PC 节点的发布方 id 就是它的 nodeId)。
   * 执行器本身不变(`prerender-executor.mjs` 的 `plan-mismatch` 照旧兜底)。
   */
  const executor = {
    ...baseExecutor,
    plan: async (planTask: any, opts: any) => {
      const ctx = await baseExecutor.plan(planTask, opts);
      const project = (service as any).entries?.get(ctx?.entryKey)?.project;
      const owner = typeof planTask?.source?.publisher?.id === "string" ? planTask.source.publisher.id : nodeId;
      const gated = withLocalMedia(ctx, { project, owner });
      if (gated !== ctx) log("queue.local-media", { planId: planTask?.id ?? null, owner });
      return gated;
    },
  };
  /**
   * M6c X5 的闲时门槛:执行器有空位(会话自己守 maxConcurrent)且最近 500 ms 没有交互帧请求就认领细任务,
   * 不再等 preload 到 ready。播放、拖动时不认领新的,手里在做的做完(不再 yieldAll)。
   */
  const idleGate = createQueueIdleGate({ pipeline: service, lastInteractionAt: () => lastInteraction.get(root) ?? -Infinity });
  /**
   * 认领闸(`queue-agent-spare.mjs`;`mechanism/rendering.md`「Agent 优先只是插队」):Agent 专用实例开着且空闲、
   * `'queue'` 预渲染间正做着一项时,多认领一项快照任务交给专用实例做。专用实例没开时不多认领。
   */
  const { createAgentSpareGate }: any = await import("./queue-agent-spare.mjs");
  const spareGate = createAgentSpareGate({ pipeline: service, base: 1 });
  /** X5 的证据(诊断 `queue.firstClaims`):第一次认领 plan / 细任务时 preload 各代际的状态 */
  const firstClaims: { plan: object | null, fine: object | null } = { plan: null, fine: null };
  const preloadStatuses = () => [...((service as any).generations?.values?.() ?? [])].map((g: any) => ({
    key: String(g?.key ?? "").slice(0, 12), status: (service as any).entries?.get(g?.key)?.status ?? null, aborted: g?.controller?.signal?.aborted === true,
  }));

  /** 诊断与 queue-mode-probe 的读口 */
  const stats = { claimed: 0, completed: 0, dedup: 0, failed: 0, discarded: 0, lost: 0, planSplit: 0, done: 0, failedTasks: 0, applied: 0, applyErrors: 0,
    written: 0, fetched: 0, skipped: 0 };
  const taskState = new Map<string, { state: string, at: number, error?: string }>();
  /** M6b 探针 H1:每个任务收到几次 `task.done`(恰好一次才对) */
  const doneCounts = new Map<string, number>();
  const planDerived = new Map<string, string[]>();
  /**
   * 本机节点自己认领、完成的任务 id(诊断 `queue.local`):W4 跨机时区分哪些活是本机做的。
   * `claimed` 取自发给本连接的 `task.claimed`,其余取自 local-node 的 `onEvent`。每类最多留 MINE_MAX 个。
   */
  const mine = { claimed: new Set<string>(), completed: new Set<string>(), dedup: new Set<string>(), failed: new Set<string>() };
  /**
   * 认领的先后(c10a 契约第 17 节的验收:预渲染重试细任务排在本机判重的任务之后):每条 `task.claimed` 记 id、时刻、优先级,
   * 最多留 CLAIM_LOG 条。只给诊断与 c10a-demo-probe 看。
   */
  const claimLog: { id: string, at: number, priority: unknown }[] = [];
  const remember = (set: Set<string>, id: unknown) => {
    if (typeof id !== "string") return;
    set.delete(id); set.add(id);
    while (set.size > MINE_MAX) set.delete(set.values().next().value as string);
  };
  /** `<projectId>\0<digest>` → 已发布的那一版 */
  const published = new Map<string, { projectId: string, projectRev: number, planId: string, digest: string, at: number, entryKey?: string }>();
  /**
   * M6c X1 的空档(集成裁定,m6c-contract「集成时的裁定」):自己发布的 plan 完成了,切分方却一个流任务都没切
   * (它关着流或探不到编码器),而本机能产流 —— 这一版的流交还本机自动生产(不经队列),快照照旧走队列。
   */
  const streamsFallback = (planId: string, derived: unknown) => {
    if (capabilities.streams !== true || !Array.isArray(derived)) return;
    if (derived.some(id => typeof id === "string" && id.startsWith("stream:"))) return;
    for (const record of published.values()) {
      if (record.planId !== planId || !record.entryKey) continue;
      const released = (service as any).releaseQueueStreams?.(record.entryKey) ?? 0;
      if (released) log("queue.streams-local", { planId, entryKey: record.entryKey.slice(0, 12), derived: derived.length });
    }
  };

  let codeVersion: string = frameCode(root);
  /** 仅供测试(M7 契约 D15):只切分、不认领细任务 */
  const testPlanOnly: boolean = typeof node.testPlanOnly === "function" && node.testPlanOnly(process.env) === true;
  if (testPlanOnly) log("queue.test-plan-only", { nodeId });
  let localNode: any = null;
  let started = false;
  let closed = false;
  const buildNode = () => {
    localNode?.stop();
    localNode = node.createLocalNode({
      nodeId,
      // cardSourceVersions:本机此刻有的卡片代码(现取现算的视图),任务的 requires.cardSources 按它过滤(c66-host-cards)
      node: { profile: "pc", envFingerprint, codeVersions: [codeVersion], capabilities, maxConcurrent: 1, cardSourceVersions: cardCode(root).view,
        // 仅供测试(M7 契约 D15):PROMPTCUT_TEST_PLAN_ONLY=1 时只认领 plan、不认领细任务(节点侧过滤规则 8),验收时不和纯浏览器抢卡;生产不设
        ...(testPlanOnly ? { planOnly: true } : {}) },
      endpoint, now: Date.now, isIdle: () => idleGate.idle(), maxConcurrent: 1, codeVersion, executor: spareGate.wrap(executor), sink,
      claimLimit: spareGate.claimLimit, canClaim: spareGate.canClaim,
      // M7 D2:队列锁的锁定方闲置严格超 30 s、这张卡又没做完,切分时带 takeover 按本机指纹接手整张卡
      takeoverLocked: node.idleLockTakeover,
      onEvent: (event: any) => {
        const id = event?.id;
        if (event?.type === "completed") { stats.completed++; remember(mine.completed, id); }
        else if (event?.type === "dedup") { stats.dedup++; remember(mine.dedup, id); }
        else if (event?.type === "failed") { stats.failed++; remember(mine.failed, id); }
        else if (event?.type === "discarded") stats.discarded++;
        else if (event?.type === "lost") stats.lost++;
        else if (event?.type === "plan-split") { stats.planSplit++; planDerived.set(id, [...(event.derived ?? [])]); }
        if (event?.type === "quota-paused") queueLog("render.quota", { profile: "host", projectId: event.projectId, until: event.until, detail: "素材服务回 507 service-quota:渲染服务的产物到了容量上限,暂停认领" });
      if (event?.type && event.type !== "publish-result") note(`node.${event.type}`, { id, ...(event.error ? { error: event.error } : {}), ...(event.derived ? { derived: event.derived.length } : {}) });
        taskEventLog(event);
      },
    });
  };
  buildNode();

  /** 队列那边回来的消息:`task.done` 拉取并发布,`task.failed` 记下 */
  let applyChain: Promise<unknown> = Promise.resolve();
  endpoint.onMessage((message: any) => {
    if (message?.type === "task.claimed") {
      stats.claimed++; remember(mine.claimed, message.id);
      if (typeof message.id === "string") {
        claimLog.push({ id: message.id, at: Date.now(), priority: message.task?.priority ?? null });
        if (claimLog.length > CLAIM_LOG) claimLog.splice(0, claimLog.length - CLAIM_LOG);
      }
      const which = typeof message.id === "string" && message.id.startsWith("plan:") ? "plan" : "fine";
      if (!firstClaims[which]) {
        firstClaims[which] = { id: message.id, at: Date.now(), preload: preloadStatuses() };
        log("queue.first-claim", { kind: which, id: message.id, preload: (firstClaims[which] as any).preload.map((p: any) => p.status) });
      }
    }
    if (message?.type === "task.done" && typeof message.id === "string") {
      stats.done++;
      doneCounts.set(message.id, (doneCounts.get(message.id) ?? 0) + 1);
      taskState.set(message.id, { state: "done", at: Date.now() });
      const result = message.result;
      if (message.id.startsWith("plan:") && Array.isArray(result?.derived)) {
        planDerived.set(message.id, [...result.derived]);
        streamsFallback(message.id, result.derived);
      }
      // 细任务的清单(C6.2 形状,`v: 1`)才拉;M5b 之前的 local-node 完成时不带清单,本机产的由执行器自己发层
      if (result && typeof result === "object" && result.v === 1 && (result.kind === "snapshot" || result.kind === "stream")) {
        applyChain = applyChain.catch(() => {}).then(async () => {
          try {
            const applied = await applyResult(service, client, result);
            stats.applied++; stats.written += applied?.written ?? 0; stats.fetched += applied?.fetched ?? 0; stats.skipped += applied?.skipped ?? 0;
          } catch (error: any) {
            stats.applyErrors++;
            log("queue.apply-failed", { id: message.id, code: error?.code ?? null, message: String(error?.message ?? error) });
          }
        });
      }
    } else if (message?.type === "task.failed" && typeof message.id === "string") {
      stats.failedTasks++;
      taskState.set(message.id, { state: "failed", at: Date.now(), error: String(message.error ?? "") });
      log("queue.task-failed", { id: message.id, error: message.error ?? null });
    }
  });
  const onOpen = () => {
    if (closed) return;
    // G.7 约定写法:(重)连上就报到,接续本实例仍持有的认领
    localNode.start(localNode.session.held().map(({ id, token }: any) => ({ id, token })));
    started = true;
    log("queue.started", { docservice: resolved.mode, url: resolved.url, nodeId, envFingerprint, codeVersion: codeVersion.slice(0, 12), capabilities });
  };
  endpoint.onOpen(onOpen);
  endpoint.onClose(() => {
    if (!started || closed) return;
    started = false;
    // J.5「中途连不上文档服务」:退回本机自己产,已经排进去的任务作废(在跑的让掉;重连后新的 preload 重新发布)
    published.clear();
    try { localNode.yieldAll("offline"); } catch { /* 连接已断,放回的消息反正发不出去 */ }
    const rerun = (service as any).leaveQueueMode?.() ?? 0;
    log("queue.offline", { rerun });
  });
  // J.6:别的机器的素材服务地址,本机的排除(与 J.13 选推送基址同一个判据)
  const stopWatch = node.watchServiceEndpoints(endpoint, ["asset"], (list: any[]) => {
    const urls = foreignAssetEndpoints(list, origin).flatMap(item => item.urls);
    const bases = setMediaFallbackBases(urls);
    note("queue.media-fallback", { bases: bases.length });
  });

  const timer = setInterval(() => {
    if (closed || !started) return;
    try {
      // 代码变了(改了 src 或管线):节点的代码版本跟着换,重新报到,不然新发布的任务谁都认领不了
      const now = frameCode(root);
      if (now !== codeVersion) {
        codeVersion = now;
        buildNode();
        localNode.start([]);
        log("queue.code-changed", { codeVersion: codeVersion.slice(0, 12) });
      }
      // M6c X5:播放 / 拖动时不认领新的(闲时门槛管认领),手里在做的做完 —— 语义 product/platforms.md「手里在做的那一批做完为止」,
      // 不再像 M5b 那样把在跑的任务 yieldAll 放回去
      localNode.tick();
    } catch (error: any) {
      note("queue.tick-error", { message: String(error?.message ?? error) });
    }
  }, QUEUE_TICK_MS);
  timer.unref?.();

  /** 发布 `plan` 等同一 reqId 的回包(`task.published` 或 `error`);reqId 带自己的前缀,不和 local-node 的撞 */
  let publishSeq = 0;
  const waiting = new Map<string, (message: any) => void>();
  endpoint.onMessage((message: any) => {
    const waiter = message?.reqId != null ? waiting.get(String(message.reqId)) : undefined;
    if (waiter && (message.type === "task.published" || message.type === "error")) waiter(message);
  });
  endpoint.onClose(() => { for (const waiter of [...waiting.values()]) waiter({ type: "error", reason: "disconnected" }); });
  const publishPlan = (task: any) => new Promise<any>((resolve, reject) => {
    const reqId = `${nodeId}#plan-${++publishSeq}`;
    const timeout = setTimeout(() => settle({ type: "error", reason: "timeout" }), PUBLISH_TIMEOUT_MS);
    const settle = (message: any) => {
      if (!waiting.has(reqId)) return;
      waiting.delete(reqId);
      clearTimeout(timeout);
      if (message.type === "task.published") resolve(message.results);
      else reject(Object.assign(new Error(`发布 plan 没成:${message.reason}`), { code: message.reason }));
    };
    waiting.set(reqId, settle);
    if (!endpoint.send({ type: "task.publish", tasks: [task], reqId })) settle({ type: "error", reason: "disconnected" });
  });

  const handle: QueueNode = {
    active: () => started && !closed && endpoint.connected === true,
    async publish(session, project, entryKey, raw) {
      if (!handle.active()) return false;
      const projectId = typeof project?.id === "string" && PROJECT_ID_RE.test(project.id) ? project.id
        : typeof session === "string" && PROJECT_ID_RE.test(session) ? session : null;
      if (!projectId) { log("queue.publish-skip", { reason: "no-project-id" }); return false; }
      /*
       * 只替绑定项目发布(`push-scope.mjs`):别的本机项目的 plan 发进共享项目的队列,就会被本机或别的节点渲出来、
       * 推进共享项目的素材服务。不属于的(或页面还没交项目文档 id)本机自己产。
       */
      const allowed = publishScope ? publishScope() : SCOPE_ALL;
      if (allowed !== SCOPE_ALL && !(Array.isArray(allowed) && typeof project?.id === "string" && allowed.includes(project.id))) {
        if (!outOfScopePublishLogged.has(String(project?.id))) {
          outOfScopePublishLogged.add(String(project?.id));
          log("queue.publish-skip", { reason: allowed === null ? "scope-pending" : "out-of-scope", projectId });
        }
        return false;
      }
      const text = JSON.stringify(project);
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      const key = `${projectId}\u0000${digest}`;
      if (published.has(key)) return true;
      try {
        /*
         * 定版本(server/queue-publish.mjs):项目没有真身时照老流程 announce 发号、上传快照;
         * 有真身(C6.5)时不再发号、不再上传,以真身的 rev 发布,节点取项目时由文档服务从真身发回。
         * 页面推来的这一份与真身不同(还有没确认的修改)就不交给队列,本机自己产。
         */
        const version = await resolvePublishVersion({
          projects, projectId, session: session && session.length <= 128 ? session : undefined,
          text, rawText: raw === undefined ? text : JSON.stringify(raw),
        });
        if ("skip" in version) {
          log("queue.publish-skip", { projectId, reason: version.skip, bodyRev: version.projectRev });
          return false;
        }
        const { projectRev } = version;
        // M6c X4:`preferNode` = 本机节点,发布后 PLAN_PREFER_MS 之内只有它能认领;之后任何指纹符合的 pc 都能
        const task = node.planTaskOf({ projectId, projectRev, codeVersion: frameCode(root), envFingerprint, preferNode: nodeId });
        // J.3 的 `planTaskOf` 会自己写进 `requires`;合并之前的版本不认这几个参数,这里补上(两种都对)
        task.requires = { ...(task.requires ?? {}), codeVersion: frameCode(root), envFingerprint, preferNode: nodeId };
        const results = await publishPlan(task);
        const result = Array.isArray(results) ? results.find((r: any) => r?.id === task.id) : null;
        if (!result || result.error) throw Object.assign(new Error(`plan 没发布成:${result?.error ?? "no-result"}`), { code: result?.error ?? "no-result" });
        published.set(key, { projectId, projectRev, planId: task.id, digest, at: Date.now(), ...(entryKey ? { entryKey } : {}) });
        // plan 在发布回包之前就已经完成过(同一版别人发布过):按已知的切分结果补判一次流的空档
        if (planDerived.has(task.id)) streamsFallback(task.id, planDerived.get(task.id));
        if (!taskState.has(task.id)) taskState.set(task.id, { state: result.state ?? "open", at: Date.now() });
        log("queue.published", { planId: task.id, bytes: text.length, via: version.via, state: result.state ?? null, created: result.created ?? null });
        return true;
      } catch (error: any) {
        log("queue.publish-failed", { projectId, code: error?.code ?? error?.reason ?? null, message: String(error?.message ?? error) });
        return false;
      }
    },
    describe() {
      return {
        mode: resolved.mode, url: resolved.url, connected: endpoint.connected === true, ...sessionDiag(endpoint), active: handle.active(), nodeId, envFingerprint, assetBase: assets.base(),
        codeVersion, running: localNode?.running?.() ?? [], held: localNode?.session?.held?.().map(({ id }: any) => id) ?? [],
        stats: { ...stats },
        // M6c X5:闲时门槛此刻的判定(null = 能认领)与第一次认领时 preload 的状态
        idle: { reason: idleGate.reason(), lastInteractionAt: Number.isFinite(idleGate.lastInteractionAt) ? idleGate.lastInteractionAt : null },
        // 认领闸:此刻多出的那一格开不开、执行器手里几项快照
        spare: spareGate.describe(),
        firstClaims: { ...firstClaims },
        local: { nodeId, claimed: [...mine.claimed], completed: [...mine.completed], dedup: [...mine.dedup], failed: [...mine.failed] },
        claims: claimLog.slice(),
        published: [...published.values()],
        plans: Object.fromEntries(planDerived),
        tasks: Object.fromEntries(taskState),
        doneCounts: Object.fromEntries(doneCounts),
        events: events.slice(-QUEUE_LOG),
      };
    },
    summary() {
      return {
        profile: "pc",
        nodes: [{ projectId: link.projectId ?? "local", nodeId, connected: endpoint.connected === true, ...sessionDiag(endpoint), claimed: stats.claimed, completed: stats.completed,
          dedup: stats.dedup, failed: stats.failed, lost: stats.lost }],
        codeVersion, envFingerprint, maxConcurrent: 1,
      };
    },
    async release() {
      const released = closed ? 0 : (() => { try { return localNode?.yieldAll("shutdown") ?? 0; } catch { return 0; } })();
      await new Promise(resolve => setTimeout(resolve, 300));
      await handle.close();
      return released;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { stopWatch?.(); } catch {}
      assets.stop();
      try { localNode?.stop(); } catch {}
      try { await localNode?.settled(); } catch {}
      try { endpoint.close(); } catch {}
    },
  };
  queueNodes.set(root, handle);
  // 自动渲染节点起步期间被撤了(页面离开了项目):当场收掉
  if (auto && !auto.alive()) {
    if (queueNodes.get(root) === handle) queueNodes.delete(root);
    await handle.close();
    return;
  }
  // 端点在挂上 onOpen 之前就连上了(一般不会):补一次报到
  if (endpoint.connected === true && !started) onOpen();
}

function requestSignal(req: any, res: any) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.("aborted", abort);
  res.once?.("close", () => { if (!res.writableEnded) abort(); });
  return controller.signal;
}
/** 导出目录与帧库目录(`PROMPTCUT_EXPORT_DIR`,开发期缺省 `<root>/out`) */
const exportRoot = (root: string) => process.env.PROMPTCUT_EXPORT_DIR || path.join(root, "out");
const libraryRoot = (root: string) => path.join(exportRoot(root), "frame-library");
const storageLog = (event: string, fields: object = {}) => {
  try { console.info("[storage]", event, JSON.stringify(fields)); } catch { console.info("[storage]", event); }
};
/**
 * 帧库的使用索引、上限与淘汰(存储占用计划 B 部分,`frame-library-storage.mjs`)。**只在预渲染进程里建**:
 * 编辑器进程的管线几乎不写帧库,`/api/storage*` 它原样转过来。
 * `PROMPTCUT_STORAGE_EVICT=0` 只记只量、不删;`PROMPTCUT_TEST_STORAGE_MIN_CAP`(字节)仅供测试与探针,把用户可设的下限调小。
 */
function storageOf(root: string) {
  const testMin = Number(process.env.PROMPTCUT_TEST_STORAGE_MIN_CAP);
  return storageFor({ root: libraryRoot(root), dataDir: storageDataDir(root),
    ...(Number.isSafeInteger(testMin) && testMin > 0 ? { minCapBytes: testMin } : {}),
    evict: process.env.PROMPTCUT_STORAGE_EVICT !== "0", log: storageLog });
}
const exportSummaries = new Map<string, ReturnType<typeof createExportSummary>>();
function exportSummaryOf(root: string) {
  const dir = exportRoot(root);
  let summary = exportSummaries.get(dir);
  if (!summary) { summary = createExportSummary(dir); exportSummaries.set(dir, summary); }
  return summary;
}
export function frameService(root: string, origin: string) {
  root = path.resolve(root);
  let service = services.get(root);
  if (!service) {
    service = new FramePipeline({ root: libraryRoot(root), origin: () => origin,
      code: () => frameCode(root), captureCode: () => captureCode(root),
      // c66-host-cards:全局代码版本不含用户卡与改动层,这一版用到的定制卡的身份另算(整场景键、requires.cardSources)
      cardSources: (project: any) => cardCode(root).projectVersions(project),
      // 成本记录和可调系数跟 vite-plugin-costs 同一个根(帧库目录不是它们的家)
      dataRoot: root,
      /*
       * D5 的 `interactive`(R7 的原子切换把编辑器进程这一侧翻了过来)。
       *
       * **预渲染进程 `true`**:热池在它这里,改叫 `streamPool`,给 G 的分段和 C2 锚帧用;
       * `?preview=legacy` 的服务端旧调度器(`acquireUser` / `updatePlayback`)也留在它这里 ——
       * legacy 页面照今天的方式发 `user` / `playback` lane,只是打到预渲染的源上
       * (`frameClient` 的缺省 `target` 已经是 `"prerender"`),服务端不另读开关。
       *
       * **编辑器进程 `false`**:不再养那对无头 Chrome。`user` / `playback` 两条 lane
       * 立即回 `USE_PRERENDER`、不进 `acquireUser`,两处 `prewarmUser` 都不调。
       * 页面侧的热渲染是可见舞台 iframe,和 Node 侧的热池不是一回事(总规则倒数第二条)。
       */
      interactive: isPrerender,
      /** 预渲染进程的模式(`user` / `agent` / `full`,见 `prerender-mode.mjs`) */
      mode: prerenderMode,
      /** C4:`wanted` 从镜像插件读(frame-pipeline 是 .mjs,镜像插件是 .ts) */
      playhead: () => latestPlayhead(),
      /** 没有内容哈希的素材打戳时向素材服务发 HEAD 的地址(基址按 asset-client.ts 定,不读素材目录) */
      mediaUrl: (m: any) => mediaSourceOf(m),
    });
    services.set(root, service);
    /* 存储占用:预渲染进程的管线接上帧库的使用索引(预加载时记使用、按它的会话判「开着」的项目) */
    if (isPrerender) storageOf(root).attachPipeline(service);
    /*
     * R8:轨道流分段的读口挂在下面的 `/api/frames/*` 上 —— 生产者要读口接上了才开工、才发 `stream` 层
     * (`StreamProducer.routeAttached`)。编辑器进程(`interactive: false`)没有生产者,这里是空操作。
     */
    service.streamProducer()?.attachRoute();
    /*
     * F5:预渲染进程起来先扫盘重建「键 → 区间」。只挂在键上,不发 `layer` ——
     * `clipId` 要等项目到位、重算 card plan 之后才反查得出来(`adoptCardPlan`)。
     */
    void service.rescanSnapshots().catch(() => {});
    /* C6.4:连得上素材服务和文档服务时建推送队列(只在预渲染进程里;连不上就什么都不建) */
    /* `agent` 模式不预渲染:不建推送队列、不起渲染节点(下面两处) */
    if (servesPrerender) void startArtifactPush(root, service).catch(error => pushLog("push.skip", { reason: "error", message: String(error?.message ?? error) }));
    else console.info(`[frames] 预渲染进程是 ${prerenderMode} 模式:只接 Agent 的查询,不预渲染、不起渲染节点`);
    /* J.5:`PROMPTCUT_QUEUE_NODE=1` 又连得上文档服务时起本机渲染节点(开关关着时这里立即返回,什么都不建) */
    if (servesPrerender && queueNodeSwitch()) void startQueueNode(root, service).catch(error => queueLog("queue.skip", { reason: "error", message: String(error?.message ?? error) }));
  }
  return service;
}
/** 原样搬到 `render-project.mjs`(契约 J.5),这里转出,调用方(`vision/render.ts`、脚本)不用改 */
export { renderProject };
export function framesPlugin(): Plugin {
  return { name: "promptcut-frames", configureServer(server) {
    const root = path.resolve(server.config.root);
    let remoteLease: { owner: string; url: string; at: number; ready: boolean } | null = null;
    const borrow = async (owner: string) => {
      const remote = prerenderState();
      if (isPrerender || !remote.ready || !remote.url) return false;
      if (remoteLease?.owner === owner && remoteLease.url === remote.url && Date.now() - remoteLease.at < 1000) return remoteLease.ready;
      try {
        const response = await fetch(remote.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, ttl: 5000 }), signal: AbortSignal.timeout(2000) });
        const result = await response.json();
        remoteLease = { owner, url: remote.url, at: Date.now(), ready: response.ok && result.yielded === true };
      } catch { remoteLease = { owner, url: remote.url, at: Date.now(), ready: false }; }
      return remoteLease.ready;
    };
    const release = async (owner: string) => {
      if (remoteLease?.owner !== owner) return;
      const lease = remoteLease; remoteLease = null;
      await fetch(lease.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, ttl: 0 }), signal: AbortSignal.timeout(1500) }).catch(() => {});
    };
    server.watcher.on("change", file => { if (/^(src|scripts)\//.test(path.relative(root, file).replaceAll("\\", "/"))) invalidateFrameCode(root); });
    server.httpServer?.once("close", () => {
      const s = services.get(root); services.delete(root);
      const teardown = pushTeardowns.get(root); pushTeardowns.delete(root);
      const queueNode = queueNodes.get(root); queueNodes.delete(root);
      void (async () => { await queueNode?.close(); await teardown?.(); await s?.close(); })();
      if (isPrerender) void closeStorage(libraryRoot(root)).catch(() => {});
    });
    /*
     * 存储占用(计划第 4 节):`GET /api/storage`、`POST /api/storage/cap`、`POST /api/storage/clear-cache`。
     * 扫描与淘汰在预渲染进程里做,编辑器进程原样转过去。路由与回包见 `storage-routes.mjs`。
     */
    const storageHandler = isPrerender ? createStorageHandler({ storage: () => storageOf(root), exports: exportSummaryOf(root) }) : null;
    server.middlewares.use("/api/storage", (req, res, next) => {
      if (!storageRouteOf(req)) return next();
      if (!isPrerender) return proxyToPrerender(req, res);
      return storageHandler!(req, res, next);
    });
    /*
     * D4(b) `/api/cards/layout`:Agent 的 `get_layout` —— 按 t 在**整场景**上实测实体框
     * (pinned 架构 4:Agent 的 query 跑预渲染进程;用户交互的 query 走自己的离屏舞台,不走这里)。
     * body `{ session, localRev, t, clipIds? }`,项目来路和 `/preload` / `/playback` / `/see`
     * 同一套(A7 的镜像前奏,迁移期仍收 `project`)。
     *
     * **只在预渲染进程里答**(T1a 审查 #14;cloud-task.md I4(c):`/api/cards/layout` 只服务 Agent 的
     * `get_layout`,走 `'agent'` 角色)。编辑器进程收到就原样转给预渲染进程,转不过去回
     * `503 NO_AGENT_LANE` —— 以前这里直接调本进程的 `FramePipeline.layout`,会在编辑器这一侧开查询 Chrome。
     * 预渲染进程里经 `runAgentTask` 借 agent lane 的 bakery,和 `see_frames` 的 agent 批排同一条队。
     */
    server.middlewares.use("/api/cards/layout", (req, res, next) => {
      if (req.method !== "POST") return next();
      if (!isPrerender) return proxyToPrerender(req, res, { unavailable: { status: 503, code: "NO_AGENT_LANE",
        error: "编辑器进程没有 Agent lane,/api/cards/layout 只在预渲染进程里答,而预渲染进程现在够不着" } });
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Layout request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body || "{}");
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          if (input.t !== undefined && !Number.isFinite(input.t)) throw new Error("t 要是秒数");
          if (input.clipIds !== undefined && input.clipIds !== null && (!Array.isArray(input.clipIds) || input.clipIds.some((id: unknown) => typeof id !== "string")))
            throw new Error("clipIds 要是字符串数组");
          const service = frameService(root, origin);
          return json(200, await service.layout(project, { t: Number(input.t) || 0, clipIds: input.clipIds ?? null, signal: requestSignal(req, res) }));
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          json(status, { ok: false, code: timedOut ? "FRAME_TIMEOUT" : cancelled ? "FRAME_CANCELLED" : (error?.code || "LAYOUT_ERROR"),
            retryable: timedOut || status >= 500, error: error?.message || "实体框测量失败" });
        }
      });
    });
    server.middlewares.use("/api/frames", (req, res, next) => {
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      /*
       * M6b 队列节点的诊断与退出(`docs/plan/render-host-contract.md` 第 2、3 节):
       *   GET  /api/frames/queue          `{ nodes: [{ projectId, connected, claimed, completed, dedup, failed, lost, … }],
       *                                     codeVersion, envFingerprint, maxConcurrent }`;节点还没起来时 `nodes: []`、`starting: true`
       *   POST /api/frames/queue/release  让掉全部认领、停节点、关连接(`cloud/scripts/render-host.mjs` 退出前调)
       * 节点在预渲染进程里:编辑器进程原样转过去(不在编辑器这一侧建管线)。预渲染进程里第一次打 `/api/frames/*`
       * 才建管线、起节点,所以 GET 这一下同时就是「开工」。
       */
      const queuePath = (req.url || "/").split("?")[0];
      /*
       * 自动渲染节点(`auto-render-node.mjs`;编辑器进程的中转在 `vite-plugin-prerender.ts` 的 `/api/render-node/*`):
       *   POST /api/frames/render-node          { url, projectId, assetBase?, contentId?, ticket? }  交接 / 换票据
       *   POST /api/frames/render-node/unbind   { projectId?, reason? }  撤掉(撤完才回)
       *   GET  /api/frames/render-node          状态(不含票据)
       */
      if ((req.method === "GET" && queuePath === "/queue") || (req.method === "POST" && queuePath === "/queue/release")) {
        if (!isPrerender) return proxyToPrerender(req, res);
        frameService(root, origin);
        const queueNode = queueNodes.get(root);
        if (req.method === "GET") {
          return json(200, queueNode ? queueNode.summary()
            : { nodes: [], codeVersion: null, envFingerprint: null, maxConcurrent: null, starting: queueNodeSwitch(), profile: "pc" });
        }
        req.resume();
        if (!queueNode) return json(200, { ok: true, released: 0 });
        void queueNode.release().then(released => json(200, { ok: true, released }), (error: any) => json(500, { ok: false, error: String(error?.message ?? error) }));
        return;
      }
      const service = frameService(root, origin);
      const url = new URL(req.url || "/", origin);
      /*
       * C3 就绪索引的 SSE。**页面直连预渲染进程**(和 J3 的快照字节同源,同走
       * `PROMPTCUT_CORS_ORIGINS`);编辑器进程不代理 —— D5 的 `/api/frames/*`
       * 保留清单里没有它,这里的中间件对不认识的路径一律 `next()`。
       *
       * 连上先灌 `reset` + 每层一条全量 `layer`(已经 done 的再补一条 `done`),
       * 之后增量。断线由页面按 1s / 2s / 4s / 8s 退避重连同一条 SSE(J3),
       * 重连就是再走一次这里 —— 和 F5 共用一条恢复路径,没有轮询端点。
       */
      if (req.method === "GET" && url.pathname === "/ready") {
        // Item 4:按 `session` 分片订阅,只收自己这个页面会话的层(不带 session 的是缺省会话)
        const session = readySessionOf(url.searchParams.get("session") ?? undefined);
        if (session === null) return json(400, { error: "session 参数不合法" });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        // 反向代理和 vite 的 compression 都可能攒着不发,SSE 攒一下就等于断线
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        const send = (message: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`); };
        const off = service.ready.subscribe(session, send);
        // 空闲连接被中间的代理掐掉之前先说句话(注释行不是事件,页面收不到)
        const beat = setInterval(() => { if (!res.writableEnded) res.write(": beat\n\n"); }, 15000);
        beat.unref?.();
        const stop = () => { clearInterval(beat); off(); };
        req.on("close", stop);
        res.on("close", stop);
        return;
      }
      /*
       * 诊断读口:A3c 的超限帧(卡 id、字节数)和 C4 的批次插队。预渲染进程的
       * stdout 被编辑器进程收走了,端到端探针只能从这里看这两件事。
       */
      if (req.method === "GET" && url.pathname === "/diagnostics") {
        // J.5:队列模式才多一个 `queue` 键(queue-mode-probe 读它);开关关着时形状不变
        const queueNode = queueNodes.get(root);
        return json(200, { ok: true, ...service.diagnostics(), ...(queueNode ? { queue: queueNode.describe() } : {}) });
      }
      if (req.method === "GET") {
        /*
         * R8 轨道流的字节(清单 / init / 分段),和快照字节同源、同走 `PROMPTCUT_CORS_ORIGINS`。
         * 只有预渲染进程(`interactive: true`)有生产者;编辑器进程这里是 null,不答。
         */
        const producer = service.streamProducer();
        if (producer && producer.handle(req, res, url.pathname)) return;
        /*
         * J3 / C3 的快照字节:`GET /api/frames/snapshot/<kind>/<key>/<localFrame>`。
         * `kind` 为 `local` 时 `key` = `<entry.key>/<共享键>`,所以有两个键段。
         * 键是内容寻址的,所以可以 immutable 缓存一年。
         */
        const snapshot = /^\/snapshot\/(html|local)\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?\/(\d{1,8})$/.exec(url.pathname);
        if (snapshot) {
          const local = snapshot[1] === "local";
          if (local && !snapshot[3]) return json(404, { error: "本地档的键是 <entry.key>/<共享键>" });
          void service.snapshots().readSnapshot({
            tier: local ? "local" : "shared",
            entryKey: local ? snapshot[2] : undefined,
            key: local ? snapshot[3] : snapshot[2],
            localFrame: Number(snapshot[4]),
          }).then((html: string | null) => {
            if (html === null) return json(404, { error: "Snapshot is not ready" });
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.end(html);
          }, () => json(404, { error: "Snapshot is not ready" }));
          return;
        }
        const control = /^\/control\/([a-f0-9]{64})\/(\d{1,8})$/.exec(url.pathname);
        if (control) {
          void fsp.readFile(path.join(service.root, 'controls', control[1], 'mov', 'frames', control[2].padStart(6, '0') + '.png')).then(buf => {
            res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'private,max-age=31536000,immutable'); res.end(buf);
          }, () => json(404, { error: 'Control frame is not ready' })); return;
        }
        // The final cumulative render is used by the editor, while the
        // cumulative track renders are useful to callers that want to rebuild
        // only the edited upper part.  Keep both forms behind fixed-length
        // hexadecimal keys; no user supplied path segment reaches the disk.
        const final = /^\/([a-f0-9]{64})\/(preview\.mp4|mov\/full\.mov|mov\/playback-[a-f0-9-]{36}\.mov|mov\/frames\/\d{6}\.png|frames\/\d{6}\.png|preview-frames\/\d{6}\.png)$/.exec(url.pathname);
        const track = /^\/([a-f0-9]{64})\/tracks\/([a-f0-9]{64})\/(preview\.mp4|frames\/\d{6}\.png)$/.exec(url.pathname);
        if (!final && !track) return next();
        const file = final
          ? path.join(service.root, final[1], final[2])
          : path.join(service.root, track![1], "tracks", track![2], track![3]);
        void fsp.stat(file).then(stat => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1;
          if (start > end || start >= stat.size) { res.statusCode = 416; return res.end(); }
          res.statusCode = range ? 206 : 200;
          res.setHeader("Content-Type", file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".mov") ? "video/quicktime" : "image/png");
          if (file.includes("playback-")) res.setHeader("Cache-Control", "no-store");
          res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Length", end - start + 1);
          if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
        }, () => json(404, { error: "Frame is not ready" }));
        return;
      }
      /*
       * K1:**探针推过的帧直接存成死素材**。后台舞台第一趟(全局时钟逐帧推)每生成
       * 一帧快照就把 `{ session, localRev, clipId, localFrame, html, environment }` 报上来,经编辑器
       * 进程转到这里。`kind` / `key` 由**预渲染进程**按镜像里的项目用 A3a 的规则算
       * (共享键要 `card-identity.mjs` 的 `digest`,本地模式里页面不算它)。
       *
       * **只存审阅表 `independent` 的卡**(pinned 渲染 5 末句):`sourceDependent`
       * (链上的源在缩水项目里没有)和 `belowDependent` / `unknown`(没有下层背景)
       * 在缩水项目里都拿不到输入,存下去等于把错画面当死素材发出去;它们的本地档
       * 仍由 C2 的整场景路产。
       *
       * 写进同一棵目录、进 C3 的索引,预渲染不再重新预渲染这些帧。键乘的是页面的环境指纹,
       * 这张卡随之锁定到页面的环境(卡片级指纹锁,契约 F.3),见下面 `acceptMeasuredSnapshot` 那一段。
       */
      if (req.method === "PUT" && url.pathname === "/snapshot") {
        return json(200, { ok: true, stored: false, reason: "RETIRED" });
      }
      if (req.method !== "POST") return next();
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Frame request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body);
          // Item 4:preload 一进门就替它的会话领号(在等镜像之前),乱序完成时按到达顺序定谁赢
          let preloadSession: string | null = null, preloadTicket: number | undefined;
          if (url.pathname === "/preload") {
            preloadSession = readySessionOf(input.session);
            if (preloadSession === null) throw new Error("session 参数不合法");
            preloadTicket = service.ready.request(preloadSession);
          }
          if (url.pathname === "/yield") {
            if (typeof input.owner !== "string" || input.owner.length > 100) throw new Error("Invalid playback owner");
            if (input.ttl === 0) await service.resumeBackground(input.owner);
            else await service.yieldBackground(input.owner, 5000);
            return json(200, { yielded: input.ttl !== 0 });
          }
          /*
           * 项目从哪儿来(A7)。body 里带 `project` 的是迁移期的调用方(脚本、只读观看页、
           * 舞台页、导出页)—— 照旧用它。编辑页只带 `{session, localRev}`:按这个键从
           * **本进程**的镜像插件取,本进程没有就按 PROMPTCUT_EDITOR_URL 回拉一次。
           * 还是取不到就回 409 MIRROR_MISSING,页面整份重推之后重试。
           */
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          const entry = await service.entry(project);
          if (url.pathname === "/playback") {
            if (typeof input.owner !== "string" || input.owner.length > 100 || !Number.isSafeInteger(input.sequence)
              || !Number.isFinite(input.t) || typeof input.playing !== "boolean" || (input.rate !== undefined && (!Number.isFinite(input.rate) || input.rate <= 0 || input.rate > 8))
              || (input.deliveryMs !== undefined && (!Number.isFinite(input.deliveryMs) || input.deliveryMs < 0 || input.deliveryMs > 5000))) throw new Error("Invalid playback clock");
            noteInteraction(root);   // M6c X5:播放时钟是交互帧请求,本机队列节点 500 ms 内不认领新任务
            return json(200, await service.updatePlayback(project, input, { borrow, release }));
          }
          if (url.pathname === "/see") {
            const lane = input.lane === "agent" ? "agent" : input.lane === "background" ? "background" : "user";
            if (lane === "user") noteInteraction(root);   // M6c X5:拖动取帧是交互帧请求
            const frames = await service.see_frames(project, input.times || [0], { lane, signal: requestSignal(req, res) });
            // `mov` 恒为 null:整场景的 full.mov 已不再产(legacy 整帧通道方案 B〔裁〕),字段留着给旧页面与探针认形状
            return json(200, { key: entry.key, incomplete: [...frames.values()].some((value: any) => value.incomplete),
              frames: [...frames].map(([frame, value]: any) => ({ frame, source: value.source, incomplete: !!value.incomplete, missing: value.missing || [],
                url: `/api/frames/${entry.key}/${value.incomplete ? 'preview-frames' : value.source === "mov" ? "mov/frames" : "frames"}/${String(frame).padStart(6, "0")}.png` })), mov: null });
          }
          // 会话「当前版本」的唯一来源(Item 4):页面的 preload 带着它的 `{ session, localRev }`
          if (url.pathname === "/preload" && !servesPrerender) {
            // `agent` 模式不预渲染(cloud-task.md I1):明说跳过了,不排活、不登记会话版本
            return json(200, { ok: true, skipped: prerenderMode, key: entry.key });
          }
          if (url.pathname === "/preload") {
            /*
             * J.5 队列模式:节点连着文档服务时,先替页面报摘要、传快照、发布 `plan`,成了就让这一版的快照交给队列产
             * (`queue: true`),没成(发布失败、没有能用的 projectId)就本机自己产(`queue: false`)。
             * 开关关着时 `queueNodes` 是空的,这里的调用和原来一字不差。
             */
            const queueNode = queueNodes.get(root);
            const viaQueue = queueNode?.active() ? await queueNode.publish(preloadSession!, project, entry.key, source) : undefined;
            await service.preload(project, { session: preloadSession!, localRev: input.localRev, ticket: preloadTicket, ...(viaQueue === undefined ? {} : { queue: viaQueue }) });
            // 报给编辑器进程登记(方案 A):这个进程崩溃重启后,由编辑器照表重放 preload。
            // 只报这个会话此刻真正认下的版本 —— 被更新的 preload 取代了的请求不报
            if (preloadSession && service.ready.current(preloadSession) === entry.key) reportReadySession(preloadSession, input.localRev);
          }
          else if (url.pathname === "/import" && typeof input.snapshots === "string") {
            try {
              // Restore the control index together with the HTML.  It is built from
              // the same snapshots and lets callers address a component at its
              // local frame without sampling the whole project again.
              const archive = unpackFrameArchive(input.snapshots, entry.key, { spillDir: path.join(entry.dir, "html-cache") });
              entry.html = archive.frames;
              entry.controls = archive.controls;
              entry.createControl = archive.createControl;
              entry.disposeArchive?.(); entry.disposeArchive = archive.dispose;
              entry.recordVersion = (entry.recordVersion || 0) + 1;
              await service.save(entry);
            }
            catch { return json(200, { discarded: true }); }
          } else if (url.pathname === "/archive") {
            const snapshots = await service.portableArchive(entry);
            return json(200, { key: entry.key, snapshots, localOnly: snapshots === null });
          } else if (url.pathname !== "/status") return json(404, { error: "Unknown frame operation" });
          await entry.mov?.ready;
          // `video`、`mov` 恒为 null:preview.mp4 与整场景的 full.mov 已不再产、也从来没有消费方
          // (legacy 整帧通道方案 B〔裁〕,AGENT-maint-3)。字段不删,旧页面与探针见到的回包形状不变
          return json(200, { key: entry.key, status: entry.status, sampled: entry.html.size, movSampled: entry.mov ? [...(entry.mov.frames || [])].length : 0, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))), error: entry.error,
            video: null, mov: null });
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          const code = timedOut ? "FRAME_TIMEOUT" : error?.superseded ? "FRAME_SUPERSEDED" : cancelled ? "FRAME_CANCELLED" : (error?.code || "FRAME_ERROR");
          if (status >= 500) console.error(`[frames] ${code}:`, error?.stack || error?.message || error);
          json(status, {
            ok: false,
            code,
            retryable: timedOut || status >= 500,
            error: error?.message || "帧渲染失败",
          });
        }
      });
    });
  } };
}
