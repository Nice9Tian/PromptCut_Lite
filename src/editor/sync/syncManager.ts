/**
 * 页面的同步管理(c65-design.md 第 4、6、8、9 节):页面用 WebSocket 接本机文档服务、把 DocSync 挂上 store。
 *
 * - **本机项目**:连本机编辑器的 `/docservice`(回环什么都不带 = `local` 空间),项目号就是 `project.id`。
 *   载入另一个项目(开始页、打开 .proc、新建)时换一条连接、一个新的 DocSync,并把载入的内容以根替换写进去
 *   (打开的文件就是用户要的那一份);载入的还是同一个项目时是对它的一次根替换。
 * - `?join=<项目号>`:第二个页面加入同一个本机项目,内容以文档服务为准,不做根替换(V2 的真实页面版用)。
 * - 无头实例(`?headless=1`)、只读查看、连不上本机文档服务时不接:store 照旧用快照栈。
 *
 * 界面状态(同步状态、离线对话框、撤销提示条、气泡、冲突合并表)放在这里的一个小仓库里,
 * 组件用 `useSync(selector)` 读。
 */
import { useSyncExternalStore } from "react";
import { bindStore, type LocalBackup, type PausedInfo, type SyncNotice, type SyncStatus, type UndoResult, type Writer } from "../../store/docsync";
import { actions, getState, subscribe } from "../../store/project";
import { entitiesOf, entityOfPath, type PathOp } from "../../kernel/diffProject";
import type { Project } from "../../kernel/project";
import { isViewOnly } from "../io/viewOnly";
import { SyncLink, type AnyMsg } from "./link";
import { clipOfEntity, entityLabel, writerLabel, type DisplayNames, type Me } from "./labels";
import { undoConflictPlan } from "./undoConflict";
import { disconnectSharedAssets } from "../media/assetTiers";
import { bindCardSync, noteProjectForCardSync, detachCardSync, takeMineCard, receiveCardSyncNotice } from "./cardSync";
import { bindAgentSide, releaseAgentSide } from "./agentSideBinding";
import { receivePresence, setPresenceLink } from "./presence";
import { applyMerge, cardConflictThing, selectionList, staleSelections, type Box, type MergeThing, type Selection } from "./mergeItems";
import { MergeTable, defaultStore } from "./mergeTable";

/* ---------------- 界面状态 ---------------- */

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  lanHost: boolean;
  localEditor: boolean;
}

export interface UndoNoticeView {
  id: number;
  kind: "undo" | "redo" | "agent";
  result: UndoResult;
  /** 出提示时的项目(实体名按它取) */
  project: Project;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn";
  action?: { label: string; run: () => void; pc?: string };
  /**
   * 同一类气泡的键:再推一条同键的,旧的那条让位(issue #15 —— 原来每进一次云端项目就叠一条常驻气泡,
   * 在氛围式里来回点几个项目就叠成一摞)。不给键的照旧各自独立
   */
  key?: string;
}

export interface AgentOp {
  /** 事件 id(`events.event` 的 eventId) */
  eventId: string;
  /** 这次工具调用的 callId(事件里带了才有;AI 栏按它对上 SSE 的工具调用) */
  callId?: string;
  opId: string;
  inverse?: PathOp[];
  rev?: number;
  by?: Writer;
  state: "ready" | "done" | "none";
}

/**
 * AI 栏的一条工具调用记录(D2,c65-design.md 第 7 节):Agent 服务端每个工具调用发「创建」「完成」两条事件,
 * 按 `eventId` 合成这一条;文字回复是一条 `kind: "text"`。只存摘要,完整参数在内容库 `event-detail`,展开时再拉。
 */
export interface EventRecord {
  eventId: string;
  kind: "tool" | "text";
  tool?: string;
  icon?: string | null;
  target?: string | null;
  args?: string | null;
  callId?: string;
  actor?: Record<string, unknown>;
  /** null = 还在跑(只收到了创建) */
  status: "ok" | "error" | "cancelled" | null;
  summary?: string | null;
  durationMs?: number | null;
  at?: number;
  text?: string;
  /** 这次调用写进项目的那次提交(成功的写才有) */
  opId?: string;
  detailKey?: string | null;
}

export interface SyncView {
  /** 页面接上了文档服务(不然 store 用快照栈) */
  active: boolean;
  kind: "local" | "off";
  status: SyncStatus;
  paused: PausedInfo | null;
  offlineOpen: boolean;
  notice: UndoNoticeView | null;
  toasts: Toast[];
  device: DeviceInfo | null;
  /** AI 栏记录的版本号:agentOps 变了就加一 */
  agentOpsVersion: number;
  /** 工具调用记录(eventRecords)的版本号:变了就加一 */
  eventsVersion: number;
  unconfirmed: number;
  /** 当前项目的历史序号（文档服务确认的 rev） */
  rev: number | null;
  /**
   * 待合并表(「冲突合并」窗口,`mergeItems.ts`):当前项目里这位用户还没处理完的东西。
   * 按「项目 × 用户」存在文档服务(连不上时先用本机暂存的副本),供 0.7.20 的撤销冲突使用。
   */
  merge: { things: MergeThing[]; version: number; blocked: string | null };
  /** 「冲突合并」窗口开着(导航栏的「冲突合并」按钮打开它) */
  mergeOpen: boolean;
}

let view: SyncView = {
  active: false,
  kind: "off",
  status: "idle",
  paused: null,
  offlineOpen: false,
  notice: null,
  toasts: [],
  device: null,
  agentOpsVersion: 0,
  eventsVersion: 0,
  unconfirmed: 0,
  rev: null,
  merge: { things: [], version: 0, blocked: null },
  mergeOpen: false,
};
const viewListeners = new Set<() => void>();

function patch(p: Partial<SyncView>) {
  view = { ...view, ...p };
  for (const l of viewListeners) l();
}

export function getSyncView(): SyncView {
  return view;
}

// 探针与排障的只读口子(同 __pcStore、__pcCloud 一类的 __pc* 钩子):这一刻连没连上、没确认的条数、离线改动存在哪。
// 界面自己用 useSync,不走这里;探针拿它核对真状态,免得只能从界面上的提示倒推
if (typeof window !== "undefined") {
  (window as unknown as { __pcSync?: { view: () => SyncView } }).__pcSync = { view: () => view };
}

export function subscribeSync(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

export function useSync<T>(selector: (v: SyncView) => T): T {
  return useSyncExternalStore(subscribeSync, () => selector(view), () => selector(view));
}

let toastSeq = 0;
/**
 * `ms` 给 `Infinity` 就不自己消失(用户点 × 关)。回这条气泡的号(`dismissToast` 用)。
 * 给了 `key`:同键的旧气泡先撤掉,屏幕上同一类永远只有一条
 */
export function pushToast(text: string, tone: Toast["tone"] = "info", ms = 6000, action?: Toast["action"], key?: string): number {
  const t: Toast = { id: ++toastSeq, text, tone, ...(action ? { action } : {}), ...(key ? { key } : {}) };
  patch({ toasts: [...(key ? view.toasts.filter((old) => old.key !== key) : view.toasts), t] });
  if (Number.isFinite(ms)) setTimeout(() => dismissToast(t.id), ms);
  return t.id;
}

export function dismissToast(id: number) {
  if (!view.toasts.some((t) => t.id === id)) return;
  patch({ toasts: view.toasts.filter((t) => t.id !== id) });
}

let noticeSeq = 0;
export function dismissNotice() {
  patch({ notice: null });
}

/* ---------------- 连接 ---------------- */

interface Current {
  link: SyncLink;
  kind: "local";
  docProjectId: string;
  /** 这条连接连的文档服务地址(告诉 Agent 服务端,见 bindAgentSide) */
  url: string;
  unbind: () => void;
  offs: (() => void)[];
}

let cur: Current | null = null;
let started = false;
const session = `page-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12)}`;
const emptyDisplayNames: DisplayNames = new Map();

export function pageSession(): string {
  return session;
}

/** 当前连着的项目号(本机项目是 project.id);没接文档服务时是 project.id */
export function currentDocProjectId(): string {
  return cur?.docProjectId ?? getState().project.id ?? "";
}

/** 本页面是谁(撤销提示条里认「你在另一个页面」用) */
export function me(): Me {
  return { session, userId: "local" };
}

export function displayNames(): DisplayNames {
  return emptyDisplayNames;
}

function localWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/docservice`;
}

async function loadDevice(): Promise<DeviceInfo | null> {
  try {
    const r = await fetch("/api/docservice/device", { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.ok) return null;
    return { deviceId: j.deviceId, deviceName: j.deviceName, lanHost: false, localEditor: true };
  } catch {
    return null;
  }
}

/* ---------------- 本地备份 ---------------- */

async function saveBackup(b: LocalBackup) {
  const project = getState().project;
  const body =
    b.kind === "offline-discard"
      ? { ...b, projectName: project.name, pageSession: session, batch: b.batch.map((x) => ({ ...x, entities: entitiesOf(x.ops) })) }
      : { ...b, projectName: project.name, pageSession: session };
  try {
    const r = await fetch("/api/project-backups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    pushToast(`本地备份没存下来(${(e as Error).message}),被覆盖的那一版找不回了。`, "warn", 10_000);
  }
}

/* ---------------- 远端改动描边 ---------------- */

const FLASH_MS = 1500;

function flashEntities(entities: string[]) {
  if (typeof document === "undefined") return;
  const ids = new Set<string>();
  const project = getState().project;
  for (const e of entities) {
    const clip = clipOfEntity(e);
    if (clip) ids.add(clip);
    const track = /^\/tracks\/@([^/]+)$/.exec(e);
    if (track) for (const c of project.tracks.find((t) => t.id === track[1])?.clips ?? []) ids.add(c.id);
  }
  if (!ids.size) return;
  setTimeout(() => {
    for (const id of ids) {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`)) {
        el.setAttribute("data-remote-flash", "");
        const prev = Number(el.dataset.remoteFlashTimer || 0);
        if (prev) clearTimeout(prev);
        el.dataset.remoteFlashTimer = String(
          setTimeout(() => {
            el.removeAttribute("data-remote-flash");
            delete el.dataset.remoteFlashTimer;
          }, FLASH_MS),
        );
      }
    }
  }, 30);
}

/* ---------------- 绑定 ---------------- */

function onNotice(n: SyncNotice) {
  switch (n.kind) {
    case "undo":
    case "revert-remote": {
      const r = n.result;
      if (!r.skipped.length && !r.failed.length) return;
      const routed = r.skipped.length > 0 && r.conflict !== undefined && routeUndoConflict(r.conflict);
      const shown = routed ? { ...r, skipped: [] } : r;
      if (!shown.skipped.length && !shown.failed.length) return;
      patch({ notice: { id: ++noticeSeq, kind: n.kind === "undo" ? (n.redo ? "redo" : "undo") : "agent", result: shown, project: getState().project } });
      return;
    }
    case "overwritten": {
      const who = writerLabel(n.by, me(), displayNames());
      pushToast(`你的近期修改已被 ${who} 覆盖。已将你修改的版本存入草稿备份（「项目」菜单 →「本地备份…」可找回）。`, "warn", 10_000);
      return;
    }
    case "remote":
      flashEntities(n.entities);
      return;
    case "rejected":
      pushToast(`有一步修改没被文档服务接受(${n.reason}),已撤回。`, "warn");
      return;
    case "replay-dropped":
      pushToast("有一步离线时的修改在最新历史序号上落不下去,已丢弃。", "warn");
      return;
    default:
      return;
  }
}

function refreshStatus() {
  if (!cur) return;
  const ds = cur.link.ds;
  const status = ds.status;
  const paused = ds.pausedInfo;
  patch({ status, paused, offlineOpen: status === "paused" ? view.offlineOpen || view.status !== "paused" : false });
  attachMergeChannel(status === "online" ? cur.link : null);
}

const cardSyncHooks = {
  ticket: async (): Promise<string> => {
    throw new Error("本机项目不需要连接票据");
  },
  toast: (text: string, tone: Toast["tone"], ms?: number) => pushToast(text, tone, ms),
  who: (actor: Record<string, unknown> | null | undefined) =>
    actor ? writerLabel({ actor, session: typeof actor.session === "string" ? actor.session : undefined }, me(), displayNames()) : "别人",
  conflict: (c: { key: string; mine: string; cloud: string; rev: number }) => {
    const table = mergeTable;
    if (!table) return false;
    void table.add([cardConflictThing({ key: c.key, mine: c.mine, cloud: c.cloud, rev: c.rev, at: Date.now(), batch: newBatchId() })]);
    patch({ mergeOpen: true });
    return true;
  },
};

/** 留在页面的 Agent 工具执行前记个位置,执行后取这期间本页面发出的提交(回包里带 opIds,server/agent/agent-side.mjs 用) */
export function pageOpMark(): number | null {
  return cur ? cur.link.ds.opMark() : null;
}

export function pageOpIdsSince(mark: number | null): string[] {
  if (!cur || mark === null) return [];
  return cur.link.ds.opIdsSince(mark);
}

function bind(link: SyncLink, docProjectId: string, url: string) {
  const prev = cur;
  if (prev) {
    for (const off of prev.offs) off();
    prev.unbind();
  }
  const unbind = bindStore(link.ds, { load: onLoad });
  let seenProject: Project | null = null;
  const offs = [
    link.ds.on("status", () => refreshStatus()),
    link.ds.on("notice", onNotice),
    subscribe(() => {
      const p = getState().project;
      if (p === seenProject) return;
      seenProject = p;
      noteProjectForCardSync(p);
    }),
    link.ds.on("project", () => { patch({ rev: link.ds.rev }); }),
    link.ds.on("status", () => { patch({ rev: link.ds.rev }); }),
  ];
  cur = { link, kind: "local", docProjectId, url, unbind, offs };
  bindMergeTable(docProjectId, "local");
  setPresenceLink(link, docProjectId, me().userId ?? "", false);
  patch({ active: true, kind: "local", rev: link.ds.rev, notice: null });
  refreshStatus();
  bindAgentSide("local", docProjectId, url);
  bindCardSync({ kind: "local", projectId: docProjectId, url }, getState().project, cardSyncHooks);
  if (prev && prev.link !== link) retire(prev.link);
}

export function detach() {
  const prev = cur;
  cur = null;
  bindMergeTable(null, null);
  setPresenceLink(null, null, "");
  if (prev) {
    for (const off of prev.offs) off();
    prev.unbind();
    retire(prev.link);
    releaseAgentSide();
    detachCardSync();
  }
  patch({ active: false, kind: "off", status: "idle", paused: null, offlineOpen: false, notice: null, unconfirmed: 0 });
}

/** 换下来的连接:等它手里没确认的提交落地(最多 5 s)再关 */
function retire(link: SyncLink) {
  link.ds
    .whenSettled({ timeoutMs: 5000 })
    .catch(() => undefined)
    .finally(() => link.stop());
}

function newLocalLink(docProjectId: string, initial: Project): SyncLink {
  const link: SyncLink = new SyncLink({
    url: localWsUrl(),
    protocols: () => ["promptcut.v1"],
    projectId: docProjectId,
    session,
    initial,
    saveBackup: (b) => void saveBackup(b),
    onMessage: onSideMessage,
    onOpen: () => void link.send({ type: "events.list", projectId: docProjectId }),
  });
  return link;
}

/** 切到本机空间里的这个项目;`load` 为真时把这份内容以根替换写进去(文件内容为准) */
function switchToLocal(project: Project, { load }: { load: boolean }): Project {
  const id = project.id || "untitled";
  const link = newLocalLink(id, project);
  if (load) link.ds.load(project);
  bind(link, id, localWsUrl());
  disconnectSharedAssets();
  link.start();
  return link.ds.project;
}

/** store 的载入(loadProject)交到这里:同一个本机项目是根替换,别的项目换连接 */
function onLoad(project: Project): Project {
  patch({ rev: cur?.link.ds.rev ?? null });
  if (!started && !cur) return project;
  if (cur && cur.kind === "local" && project.id === cur.docProjectId) return cur.link.ds.load(project);
  return switchToLocal(project, { load: true });
}

/* ---------------- 其余消息:事件、通知 ---------------- */

const agentOps = new Map<string, AgentOp>();

function asOps(v: unknown): PathOp[] | undefined {
  return Array.isArray(v) && v.length ? (v as PathOp[]) : undefined;
}

/** 工具调用记录:eventId → 记录(插入序,超过上限丢最早的) */
const eventRecords = new Map<string, EventRecord>();
const EVENT_RECORDS_KEEP = 1000;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** 按 eventId 更新一条记录(创建、完成、文字、events.list 的条目都走这里);回合成后的记录 */
function upsertRecord(e: Record<string, unknown>): EventRecord | null {
  const eventId = str(e.eventId);
  if (!eventId) return null;
  const prev = eventRecords.get(eventId);
  const isText = e.phase === "text" || (typeof e.text === "string" && e.tool == null);
  const status = e.status === "ok" || e.status === "error" || e.status === "cancelled" ? e.status : e.phase === "create" ? null : prev?.status ?? null;
  const rec: EventRecord = {
    ...(prev ?? { eventId, kind: isText ? "text" : "tool", status: null }),
    ...(str(e.tool) !== undefined ? { tool: str(e.tool) } : {}),
    ...(e.icon !== undefined ? { icon: (e.icon as string | null) ?? null } : {}),
    ...(e.target !== undefined ? { target: (e.target as string | null) ?? null } : {}),
    ...(e.args !== undefined ? { args: (e.args as string | null) ?? null } : {}),
    ...(str(e.callId) ? { callId: str(e.callId) } : {}),
    ...(e.actor && typeof e.actor === "object" && !prev?.actor ? { actor: e.actor as Record<string, unknown> } : {}),
    ...(e.summary !== undefined ? { summary: (e.summary as string | null) ?? null } : {}),
    ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
    ...(typeof e.at === "number" && prev?.at === undefined ? { at: e.at } : typeof e.createdAt === "number" && prev?.at === undefined ? { at: e.createdAt } : {}),
    ...(typeof e.text === "string" ? { text: e.text } : {}),
    ...(str(e.opId) ? { opId: str(e.opId) } : {}),
    ...(e.detailKey !== undefined ? { detailKey: (e.detailKey as string | null) ?? null } : {}),
    status: isText ? "ok" : status,
  };
  eventRecords.delete(eventId);
  eventRecords.set(eventId, rec);
  while (eventRecords.size > EVENT_RECORDS_KEEP) eventRecords.delete(eventRecords.keys().next().value!);
  return rec;
}

/** AI 栏的操作记录(最新的在前) */
export function eventRecordList(): EventRecord[] {
  return [...eventRecords.values()].reverse();
}

/** 按 eventId 取 AI 栏「撤销这步」要的那条写入记录 */
export function agentOpOfEvent(eventId: string): AgentOp | null {
  return agentOps.get(eventId) ?? null;
}

function rememberEvent(e: Record<string, unknown>) {
  const record = upsertRecord(e);
  if (record) patch({ eventsVersion: view.eventsVersion + 1 });
  const opId = typeof e.opId === "string" ? e.opId : null;
  const eventId = typeof e.eventId === "string" ? e.eventId : null;
  if (!opId || !eventId) return;
  const callId = typeof e.callId === "string" ? e.callId : typeof e.toolCallId === "string" ? e.toolCallId : record?.callId;
  const actor = e.actor as { session?: string } | undefined;
  const prev = agentOps.get(eventId);
  const rec: AgentOp = {
    eventId,
    callId,
    opId,
    inverse: asOps(e.inverse) ?? prev?.inverse,
    rev: typeof e.rev === "number" ? e.rev : prev?.rev,
    by: actor ? { actor, session: actor.session } : prev?.by,
    state: prev?.state === "done" ? "done" : "ready",
  };
  agentOps.set(eventId, rec);
  if (callId) agentOps.set(`call:${callId}`, rec);
  patch({ agentOpsVersion: view.agentOpsVersion + 1 });
}

const queueEventListeners = new Set<(msg: AnyMsg) => void>();
export function subscribeQueueEvents(cb: (msg: AnyMsg) => void): () => void {
  queueEventListeners.add(cb);
  return () => { queueEventListeners.delete(cb); };
}

function onSideMessage(msg: AnyMsg) {
  if (msg.type === "task.done" || msg.type === "task.failed") {
    for (const l of [...queueEventListeners]) { try { l(msg); } catch { /* 订阅方坏了不影响别人 */ } }
    return;
  }
  switch (msg.type) {
    case "events.event":
      rememberEvent(msg as Record<string, unknown>);
      return;
    case "events.listing":
      for (const it of Array.isArray(msg.items) ? msg.items : []) rememberEvent(it as Record<string, unknown>);
      return;
    case "presence.update":
    case "presence.state":
    case "presence.message":
      receivePresence(msg as Record<string, unknown>);
      return;
    case "merge.state":
      mergeTable?.receive(msg as { projectId?: unknown; things?: unknown; version?: unknown });
      return;
    default:
      return;
  }
}

/* ---------------- 验收用的钩子(只在开发模式) ---------------- */

if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as unknown as { __pcSyncTest?: unknown }).__pcSyncTest = {
    drop: (ms: number) => cur?.link.dropFor(ms),
    cut: () => cur?.link.cutTransport() ?? false,
    link: () => cur?.link.stats() ?? null,
    inject: (msg: AnyMsg) => onSideMessage(msg),
    view: () => view,
    docProjectId: () => currentDocProjectId(),
    rev: () => cur?.link.ds.rev ?? null,
    agentOp: (callId: string) => agentOpFor(callId),
    events: () => eventRecordList(),
    cardNotice: (n: Record<string, unknown>) => receiveCardSyncNotice(n),
    mergeThings: () => view.merge.things,
  };
}

/* ---------------- 启动 ---------------- */

/** 编辑器挂上时调一次(幂等)。连不上本机文档服务就什么都不接 */
export async function startSync(): Promise<void> {
  if (started) return;
  started = true;
  const q = new URLSearchParams(location.search);
  if (q.has("headless") || isViewOnly()) return;
  const device = view.device ?? (await loadDevice());
  if (!device) return;
  patch({ device });
  if (cur) return;
  const join = q.get("join");
  if (join) {
    const link = newLocalLink(join, getState().project);
    bind(link, join, localWsUrl());
    link.start();
    return;
  }
  switchToLocal(getState().project, { load: true });
}

/** `?join=` 打开的页面:内容以文档服务为准,演示卡之类的开场填充不要做 */
export function isJoinPage(): boolean {
  try {
    return new URLSearchParams(location.search).has("join");
  } catch {
    return false;
  }
}

/* ---------------- 保存 ---------------- */

/** `.proc` 只在所有本地修改都拿到确认之后写(语义「项目文件」);没接文档服务时直接放行 */
export async function whenSaved(timeoutMs = 10_000): Promise<void> {
  if (!cur) return;
  await cur.link.ds.whenSettled({ timeoutMs });
}

/* ---------------- 离线 ---------------- */

export function setOfflineOpen(open: boolean) {
  patch({ offlineOpen: open });
}

export function replayOffline() {
  cur?.link.ds.replayOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}

export function discardOffline() {
  cur?.link.ds.discardOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}

/* ---------------- 冲突合并:待合并表 ---------------- */

let mergeTable: MergeTable | null = null;
let mergeAttached: SyncLink | null = null;

function bindMergeTable(docProjectId: string | null, user: string | null) {
  if (mergeTable && mergeTable.projectId === docProjectId && mergeTable.user === user) return;
  mergeTable?.attach(null);
  mergeAttached = null;
  const table: MergeTable | null = docProjectId && user ? new MergeTable({ projectId: docProjectId, user, kv: defaultStore(), onChange: (things) => {
    if (!table || mergeTable !== table) return;
    patch({ merge: { things, version: view.merge.version + 1, blocked: table.blocked } });
  } }) : null;
  mergeTable = table;
  patch({ merge: { things: mergeTable?.things ?? [], version: view.merge.version + 1, blocked: null }, mergeOpen: false });
}

function attachMergeChannel(link: SyncLink | null) {
  if (!mergeTable || mergeAttached === link) return;
  mergeAttached = link;
  void mergeTable.attach(link ? { request: (msg) => link.request(msg as AnyMsg) } : null);
}

const newBatchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * 按撤销(含 AI 栏「撤销这一步」)遇到冲突:被挡住的那几样按修改项细分(`undoConflict.ts`)。
 * 没被别人改过的直接撤(不进撤销栈);别人改过的进这位用户的待合并表(来源 `undo`),打开「冲突合并」窗口。
 * 没接上待合并表(还没连过文档服务)时回 false,退回原来的提示条。
 */
function routeUndoConflict(conflict: NonNullable<UndoResult["conflict"]>): boolean {
  const table = mergeTable, ds = cur?.link.ds;
  if (!table || !ds) return false;
  const plan = undoConflictPlan(ds.project, conflict, { batch: newBatchId(), baseRev: ds.rev, at: Date.now() },
    { manualDuration: getState().durationManual });
  if (plan.direct) {
    try { ds.commitAside(plan.direct); } catch (e) { pushToast(`没撤成：${(e as Error).message}`, "warn"); }
  }
  if (plan.things.length) {
    void table.add(plan.things);
    patch({ mergeOpen: true });
  }
  return true;
}

export function setMergeOpen(open: boolean) {
  patch({ mergeOpen: open });
}

/** 合并、删除选中的结果:给窗口里显示的一句话 */
export interface MergeOutcome { ok: boolean; message: string; stale?: string[] }

/**
 * 「合并」:把选中的二级项照我这边写进项目(一次普通修改,进撤销栈),写成的从待合并表里拿掉。
 * 每次都重新核对:`seen` 是窗口显示时各二级项的云端值,和现在的不一样(窗口打开后又被别人改过)的这次不并,交还给界面刷新再看。
 */
export function mergeSelected(sel: Selection, seen: Map<string, Box>): MergeOutcome {
  const table = mergeTable;
  if (!table || !cur || view.status !== "online") return { ok: false, message: "当前离线，连上后再合并。" };
  const ds = cur.link.ds;
  const things = table.things;
  const stale = staleSelections(ds.project, things, seen, sel);
  const chosen: Selection = new Map();
  for (const [key, props] of sel) {
    const kept = new Set([...props].filter((p) => !stale.includes(`${key}|${p}`)));
    if (kept.size) chosen.set(key, kept);
  }
  const r = applyMerge(ds.project, things, chosen, { manualDuration: getState().durationManual });
  if (r.external.length) void mergeCards(r.external);
  if (r.done.length) {
    try {
      ds.mergeOffline(r.project, ds.rev);
    } catch (e) {
      return { ok: false, message: `没合并成：${(e as Error).message}` };
    }
    void table.remove(r.done);
  }
  const n = r.done.reduce((k, d) => k + (chosen.get(d.key)?.size ? d.props.filter((p) => chosen.get(d.key)!.has(p)).length : 0), 0);
  const parts = [n ? `已合并 ${n} 项。` : r.external.length ? "" : "没有合并任何项。"];
  if (r.external.length) parts.push(`${r.external.length} 张卡片的源码正在照你这边写回去。`);
  if (stale.length) parts.push(`${stale.length} 项在窗口打开后又被别人改过，这次没有合并，请看过现在的值再决定。`);
  if (r.failed.length) parts.push(`${r.failed.length} 项没合并成：${[...new Set(r.failed.map((f) => f.reason))].join("；")}。`);
  return { ok: r.failed.length === 0 && stale.length === 0, message: parts.join(""), stale };
}

async function mergeCards(list: { key: string; props: string[]; thing: MergeThing }[]) {
  for (const x of list) {
    const r = await takeMineCard(x.thing.ref.id, String(x.thing.mine?.v ?? ""));
    if (r.ok) void mergeTable?.remove([{ key: x.key, props: x.props }]);
    else pushToast(`卡片 ${x.thing.ref.id.replace(/^src\//, "")} 没写回去:${r.error ?? ""}`, "warn", 10_000);
  }
}

/** 「删除选中」:从待合并表里拿掉,云端保持现状;断网时也能删(连上后再交给文档服务) */
export function deleteSelected(sel: Selection): MergeOutcome {
  const table = mergeTable;
  if (!table) return { ok: false, message: "没有待合并项。" };
  const list = selectionList(sel);
  const n = list.reduce((k, x) => k + x.props.length, 0);
  void table.remove(list);
  return { ok: true, message: `已删除 ${n} 项，云端保持现状。` };
}

/** 离线对话框里「这段时间项目有以下改动」:谁改了哪些实体 */
export function pausedSummary(): { who: string; what: string[] }[] {
  const since = view.paused?.since ?? [];
  const project = getState().project;
  return since.map((s) => {
    const actor = s.actor as Record<string, unknown> | undefined;
    const entities = (s as { entities?: string[] }).entities ?? (s.paths ?? []).map(entityOfPath);
    return {
      who: writerLabel({ actor, session: s.session ?? (actor?.session as string | undefined) }, me(), displayNames()),
      what: [...new Set(entities.map((e) => entityLabel(e, project)))],
    };
  });
}

/* ---------------- 撤销:跳过去看 ---------------- */

export function jumpToEntity(entity: string) {
  const clip = clipOfEntity(entity);
  const project = getState().project;
  if (clip) {
    const c = project.tracks.flatMap((t) => t.clips).find((x) => x.id === clip);
    if (!c) return;
    actions.select([clip]);
    actions.seek(c.start);
    document.querySelector(`[data-clip-id="${CSS.escape(clip)}"]`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
    return;
  }
  if (entity.startsWith("/meta/")) window.dispatchEvent(new Event("pc-open-project-settings"));
}

/* ---------------- AI 栏「撤销这一步」 ---------------- */

export function agentOpFor(callId: string | undefined): AgentOp | null {
  if (!callId) return null;
  return agentOps.get(`call:${callId}`) ?? agentOps.get(callId) ?? null;
}

/** 撤 Agent 那一步:以本页面身份提交逆操作 + undoOf,进本页面的撤销栈 */
export function revertAgentOp(rec: AgentOp): UndoResult | null {
  if (!cur) return null;
  const ds = cur.link.ds;
  if (!ds.canRevertRemote(rec.opId, rec.inverse)) {
    pushToast("这一步的改动记录不在本页面上,撤不了。", "warn");
    return null;
  }
  const result = ds.revertRemote({ opId: rec.opId, inverse: rec.inverse, rev: rec.rev, by: rec.by });
  if (result.done) {
    rec.state = "done";
    patch({ agentOpsVersion: view.agentOpsVersion + 1 });
  } else if (!result.skipped.length && !result.failed.length) {
    pushToast("这一步没撤成:它改过的地方现在已经是撤之前的样子(可能已被撤回过),没有需要退回的内容。", "warn");
  }
  return result;
}
