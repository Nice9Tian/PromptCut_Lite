/**
 * Page-side sync management (c65-design.md sections 4, 6, 8, 9): connects the page to the local document
 * service over WebSocket and attaches DocSync to the store.
 *
 * - **Local project**: connects to the local editor's `/docservice` (loopback with no credentials = `local`
 *   space), where the project ID is `project.id`. Loading another project (start page, opening a `.proc`,
 *   creating a new project) switches to a new connection and a new DocSync, writing the loaded content in
 *   as a root replacement (the opened file is the authoritative copy); loading the same project again is a
 *   root replacement on that connection.
 * - `?join=<projectId>`: a second page joining the same local project; content follows the document service
 *   without a root replacement (used by the real-page V2 tests).
 * - Headless instances (`?headless=1`), read-only viewing, or when the local document service cannot be
 *   reached: does not attach, and the store uses its snapshot undo stack as usual.
 *
 * UI state (sync status, offline dialog, undo notice bar, bubbles, conflict merge table) lives in a small
 * store here, read by components via `useSync(selector)`.
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
import { tr } from "../../i18n/index.ts";

/* ---------------- UI state ---------------- */

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
  /** The project when the prompt is shown (the entity name is taken from it) */
  project: Project;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn";
  action?: { label: string; run: () => void; pc?: string };
  /**
   * Key for a class of bubbles: pushing another one with the same key makes the old one give way (issue #15:
   * every time you entered a cloud project a new persistent bubble was stacked, and clicking between a few
   * projects in Vibe mode piled them into a stack). Bubbles without a key stay independent as before
   */
  key?: string;
}

export interface AgentOp {
  /** Event id (the eventId of `events.event`) */
  eventId: string;
  /** callId of this tool call (only present if the event carries it; the AI panel uses it to match SSE tool calls) */
  callId?: string;
  opId: string;
  inverse?: PathOp[];
  rev?: number;
  by?: Writer;
  state: "ready" | "done" | "none";
}

/**
 * One tool call record in the AI panel (D2, c65-design.md section 7): the Agent server emits two events,
 * "create" and "finish", for each tool call, merged into this record by `eventId`; a text reply is one
 * `kind: "text"`. Only the summary is kept here; full parameters live in the content store `event-detail`
 * and are fetched on expand.
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
  /** null = still running (only "create" received so far) */
  status: "ok" | "error" | "cancelled" | null;
  summary?: string | null;
  durationMs?: number | null;
  at?: number;
  text?: string;
  /** The commit written into the project by this call (present only for successful writes) */
  opId?: string;
  detailKey?: string | null;
}

export interface SyncView {
  /** Whether the page is attached to the document service (otherwise the store uses its snapshot stack) */
  active: boolean;
  kind: "local" | "off";
  status: SyncStatus;
  paused: PausedInfo | null;
  offlineOpen: boolean;
  notice: UndoNoticeView | null;
  toasts: Toast[];
  device: DeviceInfo | null;
  /** Version counter for AI panel records: incremented whenever agentOps changes */
  agentOpsVersion: number;
  /** Version counter for tool call records (eventRecords): incremented whenever it changes */
  eventsVersion: number;
  unconfirmed: number;
  /** Current project's history sequence number (rev confirmed by the document service) */
  rev: number | null;
  /**
   * Pending merge table ("Conflict merge" window, `mergeItems.ts`): items in the current project that this
   * user has not finished handling yet. Stored per "project x user" on the document service (using the
   * local stash copy when unreachable), used for 0.7.20 undo conflicts.
   */
  merge: { things: MergeThing[]; version: number; blocked: string | null };
  /** Whether the "Conflict merge" window is open (opened by the "Conflict merge" button in the nav bar) */
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

// Read-only hook for probes and troubleshooting (same family as __pcStore, etc.): whether connected right now,
// count of unconfirmed ops, where offline edits live. UI components use useSync instead of this.
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
 * Pass `Infinity` for `ms` so it does not auto-dismiss (closed by clicking x). Returns the toast ID (for `dismissToast`).
 * When `key` is given: any existing toast with the same key is dismissed first so at most one of that class is shown.
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

/* ---------------- Connection ---------------- */

interface Current {
  link: SyncLink;
  kind: "local";
  docProjectId: string;
  /** Document service URL this connection uses (reported to the Agent server, see bindAgentSide) */
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

/** Currently connected project ID (`project.id` for local projects, or `project.id` when detached) */
export function currentDocProjectId(): string {
  return cur?.docProjectId ?? getState().project.id ?? "";
}

/** Who this page is (used in the undo notice bar to recognize "You on another page") */
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

/* ---------------- Local backups ---------------- */

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
    pushToast(tr("The local backup was not saved ({0}); the overwritten version cannot be recovered.", (e as Error).message), "warn", 10_000);
  }
}

/* ---------------- Outline for remote changes ---------------- */

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

/* ---------------- Binding ---------------- */

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
      pushToast(tr("Your recent edits were overwritten by {0}. Your edited version has been saved to the draft backups (find it under the \"Project\" menu → \"Local backups…\").", who), "warn", 10_000);
      return;
    }
    case "remote":
      flashEntities(n.entities);
      return;
    case "rejected":
      pushToast(tr("An edit was not accepted by the document service ({0}) and has been rolled back.", n.reason), "warn");
      return;
    case "replay-dropped":
      pushToast(tr("An offline edit could not be applied on top of the latest history sequence number and was discarded."), "warn");
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
    throw new Error(tr("This page is not connected to this shared project"));
  },
  toast: (text: string, tone: Toast["tone"], ms?: number) => pushToast(text, tone, ms),
  who: (actor: Record<string, unknown> | null | undefined) =>
    actor ? writerLabel({ actor, session: typeof actor.session === "string" ? actor.session : undefined }, me(), displayNames()) : tr("Someone else"),
  conflict: (c: { key: string; mine: string; cloud: string; rev: number }) => {
    const table = mergeTable;
    if (!table) return false;
    void table.add([cardConflictThing({ key: c.key, mine: c.mine, cloud: c.cloud, rev: c.rev, at: Date.now(), batch: newBatchId() })]);
    patch({ mergeOpen: true });
    return true;
  },
};

/** Mark a position before an Agent tool executes on the page, and afterwards collect commits emitted by this page in the meantime (returned in opIds for server/agent/agent-side.mjs) */
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

/** Replaced connection: wait for any unconfirmed commits it holds to settle (up to 5 s) before closing */
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

/** Switch to this project in the local space; when `load` is true, write this content in as a root replacement (the file content wins) */
function switchToLocal(project: Project, { load }: { load: boolean }): Project {
  const id = project.id || "untitled";
  const link = newLocalLink(id, project);
  if (load) link.ds.load(project);
  bind(link, id, localWsUrl());
  disconnectSharedAssets();
  link.start();
  return link.ds.project;
}

/** Store loads (loadProject) are routed here: loading the same local project is a root replacement, another project switches connections */
function onLoad(project: Project): Project {
  patch({ rev: cur?.link.ds.rev ?? null });
  if (!started && !cur) return project;
  if (cur && cur.kind === "local" && project.id === cur.docProjectId) return cur.link.ds.load(project);
  return switchToLocal(project, { load: true });
}

/* ---------------- Side messages: events, notifications ---------------- */

const agentOps = new Map<string, AgentOp>();

function asOps(v: unknown): PathOp[] | undefined {
  return Array.isArray(v) && v.length ? (v as PathOp[]) : undefined;
}

/** Tool call records: eventId -> record (insertion order, dropping the oldest once over the cap) */
const eventRecords = new Map<string, EventRecord>();
const EVENT_RECORDS_KEEP = 1000;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Upsert one record by eventId (create, finish, text, and items from events.list all pass through here); returns the merged record */
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

/** Action records for the AI panel (newest first) */
export function eventRecordList(): EventRecord[] {
  return [...eventRecords.values()].reverse();
}

/** Look up the write record needed by "Undo this step" in the AI panel by eventId */
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
    for (const l of [...queueEventListeners]) { try { l(msg); } catch { /* A broken subscriber must not affect others */ } }
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

/* ---------------- Acceptance test hooks (dev mode only) ---------------- */

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

/* ---------------- Startup ---------------- */

/** Called once when the editor mounts (idempotent). Does nothing if the local document service cannot be reached */
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

/** Page opened with `?join=`: content follows the document service, so skip demo-card starter population */
export function isJoinPage(): boolean {
  try {
    return new URLSearchParams(location.search).has("join");
  } catch {
    return false;
  }
}

/* ---------------- Saving ---------------- */

/** `.proc` is written only after all local edits have been confirmed (semantics "Project file"); passes straight through when not attached to the document service */
export async function whenSaved(timeoutMs = 10_000): Promise<void> {
  if (!cur) return;
  await cur.link.ds.whenSettled({ timeoutMs });
}

/* ---------------- Offline ---------------- */

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

/* ---------------- Conflict merge: pending merge table ---------------- */

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
 * When undo (including "Undo this step" in the AI panel) hits a conflict: the blocked items are split into
 * individual property changes (`undoConflict.ts`). Items untouched by others are undone directly (without
 * entering the undo stack); items changed by others go into this user's pending merge table (`undo` source)
 * and open the "Conflict merge" window.
 * Returns false when no pending merge table is attached (the document service was never connected), falling
 * back to the original notice bar.
 */
function routeUndoConflict(conflict: NonNullable<UndoResult["conflict"]>): boolean {
  const table = mergeTable, ds = cur?.link.ds;
  if (!table || !ds) return false;
  const plan = undoConflictPlan(ds.project, conflict, { batch: newBatchId(), baseRev: ds.rev, at: Date.now() },
    { manualDuration: getState().durationManual });
  if (plan.direct) {
    try { ds.commitAside(plan.direct); } catch (e) { pushToast(tr("Could not undo: {0}", (e as Error).message), "warn"); }
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

/** Result of merging or deleting selected items: one sentence shown in the window */
export interface MergeOutcome { ok: boolean; message: string; stale?: string[] }

/**
 * "Merge": write the selected secondary items into the project as on my side (a normal edit on the undo stack),
 * and remove the ones that succeeded from the pending merge table.
 * Re-checked every time: `seen` is each secondary item's cloud value when the window was shown; an item that
 * differs from the current one (changed again by others after the window opened) is not merged this time and
 * is handed back to the UI to refresh and review.
 */
export function mergeSelected(sel: Selection, seen: Map<string, Box>): MergeOutcome {
  const table = mergeTable;
  if (!table || !cur || view.status !== "online") return { ok: false, message: tr("Currently offline. Merge after reconnecting.") };
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
      return { ok: false, message: tr("Could not merge: {0}", (e as Error).message) };
    }
    void table.remove(r.done);
  }
  const n = r.done.reduce((k, d) => k + (chosen.get(d.key)?.size ? d.props.filter((p) => chosen.get(d.key)!.has(p)).length : 0), 0);
  const parts = [n ? tr("Merged {0} items.", n) : r.external.length ? "" : tr("No items were merged.")];
  if (r.external.length) parts.push(tr("The source of {0} cards is being written back to match your side.", r.external.length));
  if (stale.length) parts.push(tr("{0} items were changed by someone else after the window was opened and were not merged this time. Please review the current values and decide.", stale.length));
  if (r.failed.length) parts.push(tr("{0} items could not be merged: {1}.", r.failed.length, [...new Set(r.failed.map((f) => f.reason))].join(tr(";"))));
  return { ok: r.failed.length === 0 && stale.length === 0, message: parts.join(""), stale };
}

async function mergeCards(list: { key: string; props: string[]; thing: MergeThing }[]) {
  for (const x of list) {
    const r = await takeMineCard(x.thing.ref.id, String(x.thing.mine?.v ?? ""));
    if (r.ok) void mergeTable?.remove([{ key: x.key, props: x.props }]);
    else pushToast(tr("Card {0} was not written back: {1}", x.thing.ref.id.replace(/^src\//, ""), r.error ?? ""), "warn", 10_000);
  }
}

/** "Delete selected": remove from the pending merge table, the cloud stays as is; works while offline too (handed to the document service after reconnecting) */
export function deleteSelected(sel: Selection): MergeOutcome {
  const table = mergeTable;
  if (!table) return { ok: false, message: tr("No pending items to merge.") };
  const list = selectionList(sel);
  const n = list.reduce((k, x) => k + x.props.length, 0);
  void table.remove(list);
  return { ok: true, message: tr("Deleted {0} items, the cloud stays as it is.", n) };
}

/** "The project changed in the meantime in the following ways" in the offline dialog: who changed which entities */
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

/* ---------------- Undo: jump to entity ---------------- */

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

/* ---------------- AI panel "Undo this step" ---------------- */

export function agentOpFor(callId: string | undefined): AgentOp | null {
  if (!callId) return null;
  return agentOps.get(`call:${callId}`) ?? agentOps.get(callId) ?? null;
}

/** Undo an Agent step: submit the inverse operation + undoOf under this page's identity, onto this page's undo stack */
export function revertAgentOp(rec: AgentOp): UndoResult | null {
  if (!cur) return null;
  const ds = cur.link.ds;
  if (!ds.canRevertRemote(rec.opId, rec.inverse)) {
    pushToast(tr("The change record for this step is not on this page, so it cannot be undone."), "warn");
    return null;
  }
  const result = ds.revertRemote({ opId: rec.opId, inverse: rec.inverse, rev: rec.rev, by: rec.by });
  if (result.done) {
    rec.state = "done";
    patch({ agentOpsVersion: view.agentOpsVersion + 1 });
  } else if (!result.skipped.length && !result.failed.length) {
    pushToast(tr("This step could not be undone: what it changed already looks the way it did before the step (it may have been undone already), so there is nothing to roll back."), "warn");
  }
  return result;
}
