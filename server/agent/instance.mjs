/**
 * An instance of Agent service (contract `docs/plan/cloud-agent-contract.md` sections 2.1 and 3).
 *
 * This is the original setup from the `server/vite-plugin-ai.ts` plugin closure: page channel,
 * project replica binding, main entry point for tool calls (SKILL gate, creativity level gate,
 * multi-Agent), chat (`/api/ai/chat`), and interfaces for multi-Agent and desktop sessions.
 * The state in the closure is the state of this instance: desktop tier creates only one instance,
 * with `vite-plugin-ai.ts` mounting `routes` onto the editor process.
 *
 * `env.server` is a small vite server shape provided by the host (`httpServer`, `ssrLoadModule`,
 * `config.root`, `middlewares.use`); frontend code is loaded only via `ssrLoadModule` →
 * `./ssr-host.mjs`; this directory does not directly reference `src/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { overLimit } from '../http-guard.mjs';
import { createCallPairing } from './call-pairing.mjs';
import { createAgentSessions, CREATIVITY_HINT, CREATIVITY_LABEL, normalizeCreativity, projectCreativity } from './agent-sessions.mjs';
import { createDesktopActivity } from './desktop-activity.mjs';
import { createAgentBoards } from './agent-board.mjs';
import { attachLink, createMultiAgent } from './multi-agent.mjs';
import { createPresenceBridge } from './presence-bridge.mjs';
import { loadRole } from './agent-roles.mjs';
import { annotateError, annotateResult, createUserEditingBoard, userEditingFor } from './user-editing.mjs';
import { effectiveIsFile } from '../card-overrides.mjs';
import { parkedCutsIndex, cutLookView } from './ssr-host.mjs';
import { modelToolName, pageToolName } from '../tools/ui-names.mjs';
function sendJson(res, code, data) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * @param {object} env
 * @param {object} env.server `{ httpServer, ssrLoadModule(id), config: { root }, middlewares: { use(path, handler) } }`
 * @param {Function} env.prerenderPost Queries prerender process (`server/prerender-client.mjs`;
 *   must be statically imported and passed in by host, see notes in host)
 * @param {() => object | null} env.latestMirror Data mirror of current editor page (`server/vite-plugin-mirror.ts`)
 * @param {() => { t: number } | null} env.latestPlayhead
 * @param {'desktop' | 'hosted'} [env.profile] Default `desktop`. When `hosted` (cloud node,
 *   contract section 3), also provide:
 *   `projectId` (this instance serves only this project), `docUrl`,
 *   `protocolsFor(chatNumber, chatId)` (subprotocols connecting to document service),
 *   `execSerial` (process-level serial lock shared across all instances), `log(event, fields)`,
 *   and optional:
 *   `initiatorOnline(chatId)` (whether member who initiated this round is currently connected and watching),
 *   `pageCall(chatId, tool, args)` (reverse channel: have the page that initiated this round execute once,
 *   returning `{ ok: true, result: { ok, result?, error? } }` or `{ offline: true }`; contract section 28),
 *   `onWrite(chatId, { opId, rev, clipIds })` (a write has landed),
 *   `onFinalClose({ code, reason })` (document service closed data connection with 4003 / 4004: revoked),
 *   `hostedTools` (process-level portion of `hosted-tools.mjs`: tools implemented on the server),
 *   `ownerKey` (who owns the chat, workspace directory partitioned by it)
 */
export function createAgentInstance(env) {
  const { server, prerenderPost, latestMirror, latestPlayhead } = env;
  /**
   * Hosted tier: no page, no CLI driver or desktop session; tools allowed by open manifest,
   * credentials provided by host (contract sections 3, 4, 9)
   */
  const HOSTED = false;
  /**
   * Call id for this tool call (tool_use id on model side): provider uses it as request id, and host
   * retries of same call will not start a second job
   */
  const toolCallScope = new AsyncLocalStorage();
  let editorRes = null;
  let nextCallId = 1;
  const pendingCalls = new Map                               ();
  const activeRuns = new Map                                                                                                       ();
  /**
   * Pairing callId between codex and agy channels (server/agent/call-pairing.mjs): runner checks in
   * upon seeing tool call in output stream; incoming /api/mcp/call for the same call claims by clues
   * forwarded from mcp-server.mjs, obtaining the same callId as in chat history.
   */
  const callPairing = createCallPairing();
  /**
   * CLI quota circuit breaker (server/runners/quota.mjs): gate before chat starts; after ending,
   * bill by new bytes and recheck in background when reaching threshold; if recheck finds quota
   * exceeded, kill all running chats on the same channel. Module is lazy-loaded like other runners.
   */
  let quotaGuardPromise = null;
  const getQuotaGuard = () => {
    quotaGuardPromise ??= import(new URL('../runners/quota.mjs', import.meta.url).href).then((m) => ({ guard: m.createQuotaGuard(), mod: m }));
    return quotaGuardPromise;
  };
  const failProviderRuns = (provider, message) => {
    for (const [id, st] of activeRuns) {
      if (st.finished || st.provider !== provider) continue;
      try { st.fail?.(message); } catch {}
      try { st.abort(); } catch {}
      st.finished = true;
      activeRuns.delete(id);
    }
  };

  async function getRunner() {
    let runnerUrl;
    if (process.env.PROMPTCUT_AI_FAKE_RUNNER === '1') {
      runnerUrl = new URL('../test/fake-runner.mjs', import.meta.url).href;
    } else {
      const mod = process.env.PROMPTCUT_AI_RUNNER_MODULE || './runners/index.mjs';
      // Relative paths resolve against server/ directory (same as before moving into this directory)
      runnerUrl = new URL(mod, new URL('../', import.meta.url)).href;
    }
    try {
      return await import(runnerUrl);
    } catch (e) {
      throw new Error(`Runner is not ready or failed to load: ${e.message}`);
    }
  }

  /**
   * agent: Agent chat ID that initiated this call (multi-Agent tab). For CLI route, mcp-server brings
   * it from environment variable PROMPTCUT_AGENT; for direct API route, startRun's callTool closure
   * carries it; editor uses it to record "who changed what".
   */
  /*
   * Read-only mirror for data management (docs/archive/topics/decoupling-plan.md section 3.2, stage 4; A7).
   *
   * Editor page pushes project (with version number) to **mirror plugin**
   * (server/vite-plugin-mirror.ts, mounted on both processes); playhead uses its
   * /api/data/playhead. Read-only here: Agent reads and rendering - get_project /
   * see_frames(final video)/ get_gif / bake_card / inspect_card_dom - query prerender process
   * directly with mirror, **completely bypassing editor page**: previously these calls were forwarded
   * via SSE to page, which then sent render requests, hanging for minutes and occupying connections
   * from editor origin, freezing UI while CPU was completely idle.
   * Writes still go through page (undo / redo are both there); page pushes changes before returning
   * results, ensuring read-after-write consistency.
   * When page closes, mirror remains in memory; Agent can still read and view frames as usual.
   *
   * Mirror itself (storage, version window, two-tier diff, forwarding to prerender) moved to mirror
   * plugin: ai plugin is only mounted on editor side, while prerender process also needs to fetch
   * project by key.
   */

  /**
   * These tools execute in place on the server (when mirror exists); others go through editor page
   * as usual.
   * C6.5 D4: when bound to project replica (see bindAgent below), mirror is no longer used: these
   * plus get_layout are executed by server/agent/agent-exec.mjs reading **replica**, response
   * includes rev; this table only handles legacy path when no replica is bound.
   */
  const MIRRORED_TOOLS = new Set(['get_project', 'see_frames', 'get_gif', 'bake_card', 'inspect_card_dom']);

  /**
   * Execute a read / render tool on server. Returns undefined = unhandled here, delegate to editor
   * page.
   * Throw on error (same as page path: bridge passes error to Agent as is).
   */
  async function runMirroredTool(tool, args, toolDef) {
    const mirror = latestMirror();
    if (!MIRRORED_TOOLS.has(tool) || !mirror) return undefined;
    const required = toolDef?.inputSchema?.required ?? [];
    const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
    if (missing.length) throw new Error(`Missing required parameters: ${missing.join(', ')}. Add them and try again.`);
    const project = mirror.project;
    const timeoutMs = toolDef?.timeoutMs || 60000;

    if (tool === 'get_project') {
      // Same shape as editor page getProject: transcript provides only summary, full text uses get_transcript
      // Clip index of parked cuts placed first; model can get clipId in other cuts without user_interface_switch_cut
      const parkedCuts = parkedCutsIndex(project);
      return {
        ...(parkedCuts ? { parkedCuts } : null),
        ...project,
        media: (project.media || []).map((m) => m?.transcript ? {
          ...m,
          transcript: {
            engine: m.transcript.engine, model: m.transcript.model, language: m.transcript.language,
            createdAt: m.transcript.createdAt, segments: m.transcript.segments?.length ?? 0,
            hint: 'Use get_transcript for the full transcript',
          },
        } : m),
      };
    }

    if (tool === 'see_frames') {
      const { source, cutId, ...rest } = args || {};
      // Media shot montage requires running shot detection and writing back to project; left to editor page
      if (source !== undefined && source !== 'timeline') return undefined;
      // cutId: view visuals for that cut without switching (view used only for this export, see seeFrames
      // in agent-exec.mjs)
      if (cutId !== undefined && cutId !== null && typeof cutId !== 'string') throw new Error('cutId must be a string (the cut id from list_cuts); if omitted, the currently active cut is used.');
      const look = cutLookView(project, cutId);
      const times = Array.isArray(rest.times) ? rest.times.filter((x) => typeof x === 'number').slice(0, 10) : [];
      const body = times.length
        ? { project: look.project, times, clipId: rest.clipId }
        : { project: look.project, t: typeof rest.t === 'number' ? rest.t : (rest.clipId ? undefined : (look.active ? (latestPlayhead()?.t ?? 0) : look.parkedT)), clipId: rest.clipId };
      const data = await prerenderPost('/api/vision/snapshot', body, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Failed to render the frame');
      let result = times.length ? { ok: true, frames: data.frames, note: data.note, __images: data.__images } : data;
      result = { ...result, cut: look.cut };
      // "Visible tool results" in chat panel: same record as editor page withVisual
      const images = [];
      if (data.__image?.base64) images.push({ mime: data.__image.mime, base64: data.__image.base64, label: typeof data.t === 'number' ? `t=${data.t}s` : '' });
      for (const im of Array.isArray(data.__images) ? data.__images : []) if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? '' });
      if (images.length) {
        const v = await prerenderPost('/api/ai/visual', { tool: 'see_frames', images }, { timeoutMs: 5000 }).catch(() => null);
        if (v?.ok && v.visualId) result = { visualId: v.visualId, ...result };
      }
      return result;
    }

    if (tool === 'get_gif') {
      // Two steps (cloud-task.md resolution 12): Agent side writes specs only (`'agent'`), pixel
      // rendering left to `user` side `/render`
      const spec = await prerenderPost('/api/ai/visual', { tool: 'get_gif', clipId: args.clipId, after: project }, { timeoutMs });
      if (!spec?.ok) throw new Error(spec?.error || 'Failed to make the animated image');
      if (!spec.gifKey) throw new Error(`No clip with id ${args.clipId} on the timeline.`);
      const data = await prerenderPost('/api/ai/visual/render', { key: spec.gifKey }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Failed to make the animated image');
      return {
        visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
        note: 'Collage 4×2: cell k corresponds to the k-th time in times (row by row, left to right). The user can open this step in the chat panel to see the animated image.',
        ...(data.grid ? { __image: { mime: 'image/png', base64: data.grid } } : {}),
      };
    }

    if (tool === 'bake_card') {
      const data = await prerenderPost('/api/vision/bake', { project, clipId: args.clipId, t: args.t, size: args.size, bg: args.bg }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Render failed');
      return data;
    }

    if (tool === 'inspect_card_dom') {
      const ref = typeof args.ref === 'string' ? Number(String(args.ref).replace(/^ref_/, '')) : args.ref;
      const data = await prerenderPost('/api/cards/dom', { project, clipId: args.clipId, t: args.t, ref, depth: args.depth }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Cannot read the DOM tree');
      return data;
    }
    return undefined;
  }

  /*
   * ------ C6.5: Agent server-side project replica (D1, D2, D4; docs/plan/c65-design.md sections 5, 7) ------
   *
   * After connecting to document service, page calls POST /api/agent/bind to inform "which project
   * I am editing, which document service I am connecting to". Once bound:
   *   - Tools with side: "agent" execute here on project replica (server/agent/agent-exec.mjs); writes
   *     commit to document service under Agent chat identity with expected version, no longer through
   *     page; get_project / get_layout / see_frames etc. read replica;
   *   - Each tool call (regardless of execution side) emits two events (create / complete) to document
   *     service events module; text reply emits one event upon full completion.
   * When not bound (page not connected to document service, headless instance disabled document service),
   * everything remains as before: write tools sent via SSE to page, read tools read data mirror.
   *
   * Credentials provided by chat number (server/agent/doc-link.mjs, one connection per chat):
   *   - mode "local": this machine local space, loopback + promptcut.role.agent.<n>;
   *   - mode "lan-host": creator's shared project on LAN host, this machine declares
   *     promptcut.tenant.<projectId> + promptcut.role.agent.<n>;
   *   - mode "ticket": shared project (hosted side, LAN member), requests connection ticket from page
   *     via SSE (k:'conn', r:'agent', c:<n>), page returns it via POST /api/agent/ticket.
   */
  /*
   * "User is editing" (plan agent-workflow-plan.md A2): editor page throttles clips being edited and
   * pushes to POST /api/agent/editing, recorded here (with expiration timestamp). When Agent reads or
   * writes to these clips, tool result includes userEditing and a notice; notice only, no blocking.
   */
  const userEditingBoard = createUserEditingBoard();
  /**
   * Chat id → human-readable provider name (used in overwrite notice "Agent <identity>(<provider>)
   * just modified"; desktop app sessions use names like "Claude Code"; registry below)
   */
  const agentLabelOf = (key) => {
    try { const e = agentSessions.get(key); return e?.label ?? e?.vendor ?? null; } catch { return null; }
  };


  let agentBinding = null;
  let ticketSeq = 0;
  const ticketWaiters = new Map                                                                                                                   ();
  const AGENT_MODES = new Set(HOSTED ? ["hosted"] : ["local", "lan-host", "ticket"]);
  const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  const editorPortOf = () => (server.httpServer?.address())?.port || 5195;
  const agentLog = (event, fields = {}) => {
    // Hosted tier logs handed to host (one JSON per line, only id, count, reason code)
    if (HOSTED) { try { env.log?.(event, fields); } catch { /* Logging failures do not affect the service */ } return; }
    try { console.info("[agent]", event, JSON.stringify(fields)); } catch { console.info("[agent]", event); }
  };

  /** Request an agent role connection ticket from page (signed by page using its document service identity) */
  function requestTicket(projectId, conversation) {
    return new Promise((resolve, reject) => {
      if (!editorRes) return reject(new Error("The editor is not open, so a connection ticket cannot be obtained"));
      const reqId = `t${++ticketSeq}`;
      const timer = setTimeout(() => {
        ticketWaiters.delete(reqId);
        reject(new Error("The page did not return a connection ticket within 10 seconds"));
      }, 10_000);
      ticketWaiters.set(reqId, { resolve, reject, timer });
      editorRes.write(`data: ${JSON.stringify({ type: "agent.ticket", reqId, projectId, role: "agent", conversation })}\n\n`);
    });
  }

  async function bindAgent(input) {
    const projectId = typeof input?.projectId === "string" && PROJECT_ID_RE.test(input.projectId) ? input.projectId : null;
    if (!projectId) throw new Error("projectId is invalid");
    const mode = typeof input?.mode === "string" ? input.mode : (HOSTED ? "hosted" : "local");
    if (!AGENT_MODES.has(mode)) throw new Error(`mode must be one of ${[...AGENT_MODES].join(" / ")}`);
    let url = `ws://127.0.0.1:${editorPortOf()}/docservice`;
    if (mode === "ticket") {
      if (typeof input?.url !== "string" || !/^wss?:\/\//.test(input.url)) throw new Error("When mode is ticket, provide the document service's ws(s):// address");
      url = input.url;
    }
    if (mode === "hosted") {
      // Hosted tier instances serve only project specified at creation: project and document service URL
      // ignore requests
      if (projectId !== env.projectId) throw new Error("This instance does not serve this project");
      if (env.accountDataRequired === true &&
          (env.accountMode !== true || typeof env.accountDataWebSocketImpl !== 'function'))
        throw new Error('The account data connection lacks a trusted instance proof');
      url = env.docUrl;
    }
    // Only the trusted account runner may cancel its own pending binding.
    // Page/LAN bind requests never supply or inherit this signal.
    const bindSignal = mode === 'hosted' && env.accountMode === true && env.accountDataRequired === true &&
      input?.signal && typeof input.signal.addEventListener === 'function' &&
      typeof input.signal.removeEventListener === 'function' ? input.signal : null;
    if (bindSignal?.aborted) throw new Error('run-fenced');
    if (agentBinding && agentBinding.projectId === projectId && agentBinding.mode === mode && agentBinding.url === url) return agentBinding;
    unbindAgent("rebind");
    const imports = Promise.all([
      import(new URL("./agent-side.mjs", import.meta.url).href),
      import(new URL("./ssr-host.mjs", import.meta.url).href),
      import(new URL("../mcp-tools.mjs", import.meta.url).href),
    ]);
    let imported;
    if (bindSignal) {
      let rejectOnAbort;
      const cancelled = new Promise((_, reject) => { rejectOnAbort = () => reject(new Error('run-fenced'));
        bindSignal.addEventListener('abort', rejectOnAbort, { once: true });
        if (bindSignal.aborted) rejectOnAbort(); });
      try { imported = await Promise.race([imports, cancelled]); }
      finally { bindSignal.removeEventListener('abort', rejectOnAbort); }
      if (bindSignal.aborted) throw new Error('run-fenced');
    } else imported = await imports;
    const [{ createAgentSide }, { loadSsrHost }, { tools, toolGroups }] = imported;
    const protocolsFor = async (n) => {
      // Hosted tier: credentials provided per chat (chat delegation tied to a single chat, contract
      // section 4.2), so handed to host together with chat id corresponding to this chat number
      if (mode === "hosted") {
        const conversationId = side.describe().conversations.find((c) => c.conversation === n)?.key ?? '';
        // The one without chat id ('') is instance's own connection (replica subscription, presence);
        // host decides whose credentials it uses and which round to finalize when rejected
        return env.protocolsFor(n, conversationId);
      }
      if (mode === "local") return ["promptcut.v1", `promptcut.role.agent.${n}`];
      if (mode === "lan-host") return ["promptcut.v1", `promptcut.tenant.${projectId}`, `promptcut.role.agent.${n}`];
      return ["promptcut.v1", `promptcut.ticket.${await requestTicket(projectId, n)}`];
    };
    // Dispatch (side: agent / page / server) and events are in server/agent/agent-side.mjs; tests use same copy
    const side = createAgentSide({
      projectId,
      url,
      protocolsFor,
      ...(env.accountMode === true && env.accountDataWebSocketImpl ? { WebSocketImpl: env.accountDataWebSocketImpl } : {}),
      // Hosted tier: several read-only project and registry page tools now execute on server replica;
      // those with separate server implementations (import media, create/modify card, voiceover) are
      // marked as executed via "page": hosted tier "page" is hostedCallPage below, handed to hosted-tools.mjs;
      // tools with providers created in this process (account mode, `account-tools.mjs`) are all handed to
      // it (take "execute via page" dispatch path, see hostedCallPage);
      // `see_frames` keeps `side: "agent"`, timeline visuals execute on replica as usual, media montage
      // (`source: "media"`) falls back to hostedCallPage after executor returns undefined
      tools,
      toolGroups,
      // Hosted tier has no editor process: leaked /api/* calls in tool implementations point to an
      // unresolvable address, failing immediately without hitting other services on same machine
      loadHost: () => loadSsrHost((id) => server.ssrLoadModule(id), { apiBase: HOSTED ? "http://agent-service.invalid" : `http://127.0.0.1:${editorPortOf()}` }),
      prerenderPost,
      // Hosted tier has no "server-remembered page playhead": playhead comes only from snapshot when
      // sending message, looked up by chat (hostedCallPage below)
      playhead: () => (HOSTED ? 0 : (latestPlayhead()?.t ?? 0)),
      ...(HOSTED ? {
        onWrite: (agent, write) => { try { env.onWrite?.(agent, write); } catch { /* Host responsibility */ } },
        // If the document service closes the data connection with 4003 / 4004, it means revocation
        // (contract section 4.5): do not reconnect; report to the host to stop this round immediately
        // and record the reason
        linkOptions: { onFinalClose: (_n, info) => { try { env.onFinalClose?.(info); } catch { /* Host responsibility */ } } },
      } : {}),
      // Hosted tier: the server-side store is a singleton in the process; all instances share a
      // single lock and clear the field upon entering the lock (contract section 3.3)

      log: agentLog,
      pageResult: "wrapped",
      callPage: async (tool, args, ctx) => {
        const def = tools.find((t) => t.name === tool);
        const out = await callEditorPage(tool, args, ctx?.agent || undefined, def?.timeoutMs || (tool === "__page_state" ? 10_000 : 60_000));
        if (!out.ok) throw new Error(out.error);
        return { result: out.result || out, opIds: out.opIds };
      },
      callServer: (tool, args, ctx) => runServerTool(tool, args, ctx?.agent || ''),
      userEditing: () => userEditingBoard.current(),
      agentLabel: agentLabelOf,
      onPageWrites: (agent, opIds) => boards.boardFor(projectId).attributeOps(agent, opIds),
    });
    // The bulletin board's change records are fed by this connection's commit stream;
    // project.overwritten sent to each chat connection is recorded for the overwritten Agent (A3)
    const detachLink = attachLink(side.link, () => boards.boardFor(projectId));
    /*
     * Cross-device (A3 phase 2): receive clips currently being edited by other members via the
     * document service's presence (into the A2 board), as well as scopes and messages from Agents on
     * other members' sides (into the bulletin board); send local Agent scopes and messages to them.
     * If legacy document services do not recognize these messages, stop sending, without errors.
     */
    const bridge = createPresenceBridge({
      link: side.link,
      board: () => boards.boardFor(projectId),
      editing: userEditingBoard,
      conversationNumberOf: (key) => side.conversationNumber(key),
      labelOf: agentLabelOf,
      infoOf: (key) => ({ role: agentSessions.get(key).role }),
      log: agentLog,
    });
    presenceBridge = bridge;
    boards.boardFor(projectId).onDeclare = (key) => { void bridge.publishAgent(key); };
    void bridge.start();
    const detachBoard = () => {
      detachLink();
      bridge.close();
      if (presenceBridge === bridge) presenceBridge = null;
      const b = boards.boardFor(projectId);
      b.onDeclare = null;
    };
    agentBinding = { projectId, mode, url, side, detachBoard };
    agentLog("agent.bind", { projectId, mode, url });
    return agentBinding;
  }

  function unbindAgent(reason) {
    const b = agentBinding;
    if (!b) return;
    agentBinding = null;
    try { b.detachBoard?.(); } catch { /* Already released */ }
    try { b.side.close(); } catch { /* Already closed */ }
    agentLog("agent.unbind", { projectId: b.projectId, reason });
  }
  server.httpServer?.once("close", () => unbindAgent("server-close"));

  /**
   * Read-only lock when review loop runs via CLI: null = no lock; Set = only allow these tools
   * (empty Set = block all). See callToolInternal below
   */
  let loopToolLock = null;

  /*
   * Agent session registry (server/agent/agent-sessions.mjs): chat ID -> override values for type,
   * vendor, role, and creativity level.
   * Register once each time a message is sent via /api/ai/chat; register desktop app sessions on each
   * call at /api/mcp/call (type desktop, follows project).
   */
  const agentSessions = createAgentSessions();
  /*
   * Desktop app session grouping in the AI panel (A4, server/agent/desktop-activity.mjs): vendor,
   * ongoing operation, and submitted progress reports.
   * When changed, push the entire snapshot to the page via SSE (agent.desktop), throttled to 100 ms.
   */
  let desktopPushTimer = null;
  const pushDesktop = () => {
    if (desktopPushTimer) return;
    desktopPushTimer = setTimeout(() => {
      desktopPushTimer = null;
      if (!editorRes) return;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.desktop', sessions: desktopActivity.snapshot() })}\n\n`); } catch { /* Page is gone */ }
    }, 100);
  };
  const desktopActivity = createDesktopActivity({ onChange: pushDesktop });
  /**
   * The caller field of /api/mcp/call: only recognizes desktop session identities reported by
   * mcp-server.mjs; if the shape is incorrect, treat as not provided
   */
  const desktopCallerOf = (c) => {
    if (!c || typeof c !== 'object' || c.type !== 'desktop') return null;
    if (typeof c.key !== 'string' || !/^desk-[A-Za-z0-9_-]{1,59}$/.test(c.key)) return null;
    const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    const client = c.client && typeof c.client === 'object' && typeof c.client.name === 'string'
      ? { name: c.client.name.slice(0, 64), version: typeof c.client.version === 'string' ? c.client.version.slice(0, 32) : '' }
      : null;
    return { key: c.key, vendor: str(c.vendor, 64), label: str(c.label, 64), client };
  };
  /**
   * Preview of "last completed action" under the SKILL floating window (desktop/src-tauri/src/skill_shell.rs
   * watches skillRoot/last-action.*):
   * When a desktop session completes an operation and SKILL mode is open, have the page render a
   * frame of that moment and return it (the page only acts on timeline operations; fails silently).
   * Originally this was done by the headless instance's page; after the headless instance was
   * archived, it is done by the user's page.
   */
  const requestSkillPreview = (tool, args, result) => {
    if (!editorRes || (result && typeof result === 'object' && result.ok === false)) return;
    void import(new URL('../skill-gate.mjs', import.meta.url).href).then((gate) => {
      if (!gate.readState().active || !editorRes) return;
      const clipId = typeof args?.clipId === 'string' ? args.clipId : typeof result?.clip?.id === 'string' ? result.clip.id : null;
      const start = typeof args?.start === 'number' ? args.start : null;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'skill.preview', tool, clipId, start })}\n\n`); } catch { /* Page is gone */ }
    }).catch(() => {});
  };
  /**
   * Project default level reported in passing when the page sends a message: used when the server
   * cannot read the project (no replica bound, no mirror)
   */
  let projectCreativityHint = null;
  /**
   * Current default level of the project. In order of freshness: if a project replica is bound,
   * read the replica (the latest version from the document service); otherwise, read the mirror
   * pushed by the page; if still none, use the one reported when the page sent the message; if none
   * at all, default to factory "high".
   */
  function currentProjectCreativity() {
    const replica = (agentBinding)?.side?.link?.replica?.project;
    if (replica && typeof replica === 'object') return projectCreativity(replica);
    const mirrored = latestMirror()?.project;
    if (mirrored && typeof mirrored === 'object') return projectCreativity(mirrored);
    return normalizeCreativity(projectCreativityHint) ?? projectCreativity(null);
  }
  /**
   * The level of create_card is determined by "whether this user card exists" (rewriting an existing
   * one entirely = medium, creating new = high); evaluated against the active copy, overlay layer
   * takes precedence
   */
  function userCardExists(id) {
    // Hosted tier: user cards are in this project's content store (the main entry point has
    // already listed them before determining the level)
    return effectiveIsFile(server.config.root, path.join(server.config.root, 'src', 'cards', 'user', `${id}.tsx`));
  }

  /*
   * ---------------- Multi-Agent (plan agent-workflow-plan.md A3) ----------------
   *
   * Bulletin board (server/agent/agent-board.mjs) is one per project, inside this process:
   * declare_scope / list_agents / send_message / check_messages are answered here (side: "server"),
   * and all Agents see the same copy. Change records are fed by the document service's commit stream
   * (when a project replica is bound, attachLink); when not bound, the page executor calculates the
   * scope and returns it with the result, recorded in dispatchTool below.
   * spawn_agent (server/agent/multi-agent.mjs) asks the page via SSE to open a new tab (agent.spawn),
   * and the page responds via POST /api/agent/spawned.
   * Scope names and unread marks on tabs are pushed to the page via the same SSE (agent.board); when
   * the page is idle, it fetches messages via POST /api/agent/inbox and sends them out.
   */
  /**
   * Current project: if a replica is bound, use the replica's project id; otherwise use the project
   * id in the mirror; if neither, '' (the local copy)
   */
  const currentProjectKey = () => {
    const b = agentBinding;
    if (b) return b.projectId;
    const id = (latestMirror())?.project?.id;
    return typeof id === 'string' ? id : '';
  };
  let lastTabs = [];
  let presenceBridge = null;
  let boardPushTimer = null;
  const pushBoard = () => {
    if (boardPushTimer) return;
    boardPushTimer = setTimeout(() => {
      boardPushTimer = null;
      if (!editorRes) return;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.board', agents: board().snapshot() })}\n\n`); } catch { /* Page is gone */ }
    }, 50);
  };
  const boards = createAgentBoards(() => ({
    labelOf: agentLabelOf,
    // Recipient is with another member of the shared project: forwarded via document service
    // (A3 phase 2; cannot forward when project replica is not bound or document service is legacy)
    forwardRemote: (msg) => presenceBridge?.forward(msg) ?? false,
    infoOf: (key) => {
      const e = agentSessions.get(key);
      return { role: e.role, roleName: e.role && e.role !== 'main' ? loadRole(e.role)?.name ?? null : null, parent: e.parent };
    },
  }));
  const boardKeys = new Set        ();
  /**
   * Bulletin board for the current project; subscribe when first used (push to page when changed)
   * and backfill tabs recently reported by the page
   */
  function board() {
    const key = currentProjectKey();
    const b = boards.boardFor(key);
    if (!boardKeys.has(key)) {
      boardKeys.add(key);
      b.subscribe(() => { if (currentProjectKey() === key) pushBoard(); });
      if (lastTabs.length) b.setTabs(lastTabs);
    }
    return b;
  }
  let spawnSeq = 0;
  const spawnWaiters = new Map                                                                                                     ();
  /** Ask the page to open a subagent tab and wait for its response (8 seconds) */
  function openAgentTab(spec) {
    return new Promise((resolve, reject) => {
      if (!editorRes) return reject(new Error('The editor is not open, so there is no tab to open'));
      const reqId = `s${++spawnSeq}`;
      const timer = setTimeout(() => {
        spawnWaiters.delete(reqId);
        reject(new Error('The page did not open a tab within 8 seconds'));
      }, 8_000);
      spawnWaiters.set(reqId, { resolve, reject, timer });
      editorRes.write(`data: ${JSON.stringify({ type: 'agent.spawn', reqId, ...spec })}\n\n`);
    });
  }
  const multiAgent = createMultiAgent({
    sessions: agentSessions,
    board,
    openTab: openAgentTab,
    projectCreativity: () => currentProjectCreativity(),
  });

  function callToolInternal(toolIn, args, agent, callId) {
    // Tools that modify the user interface have been renamed (`user_interface_` prefix,
    // server/tools/ui-names.mjs): old chat history still contains old names; when the model calls an
    // old name, execute as usual.
    // From here down (tool table, allowlist, gates, events), always use new names; convert back to the
    // old internal operation names when sending to the page
    const tool = modelToolName(toolIn);
    return toolCallScope.run({ callId: typeof callId === 'string' ? callId : undefined }, () => callToolScoped(tool, args, agent, callId));
  }

  async function callToolScoped(tool, args, agent, callId) {
    const { tools } = await import(new URL('../mcp-tools.mjs', import.meta.url).href);
    const toolDef = tools.find((t) => t.name === tool);

    if (!toolDef) {
      const err = new Error('Unknown tool');
      (err).code = 'UNKNOWN_TOOL';
      throw err;
    }

    return callToolChecked(tool, toolDef, args, agent, callId);
  }

  /**
   * Second half of the main tool invocation entry point: gates and execution (desktop tier reaches
   * here directly; hosted tier first passes the allowlist above)
   */
  async function callToolChecked(tool, toolDef, args, agent, callId) {

    /*
     * Read-only lock when the review loop runs via CLI (set by runners/cli-loop.mjs via setToolAccess).
     *
     * CLI MCP is registered globally, and tools cannot be reduced on a per-round basis, so they can
     * only be intercepted at the execution entry point: reviewer / judger rounds only permit the
     * read-only list, and reflection rounds permit none. The lock is global to this server: write
     * operations sent from other chat pages during those few locked minutes will also be blocked, which
     * is intentional: projects currently being inspected by reviewer should not be modified
     * concurrently.
     */
    if (loopToolLock && !loopToolLock.has(tool)) {
      return {
        ok: false,
        error: loopToolLock.size
          ? `This turn of the review loop is read-only: ${tool} cannot be used in this turn. Only ${[...loopToolLock].join(', ')} can be used.`
          : `This turn of the review loop calls no tools, so ${tool} was rejected. Answer in text only.`,
      };
    }

    /*
     * SKILL mode gate (server/skill-gate.mjs), intercepts by caller type (A4): registered desktop app
     * sessions do nothing when SKILL mode is off, whereas Agents in the AI panel are not governed by
     * it. **Intercepted before execution**: switching back to Classic mode revokes the desktop app's
     * hand, and the session there might be running mid-way unaware; rolling back after execution cannot
     * clean up cleanly. Invocations that are unregistered and report no identity are treated as
     * unknown and not intercepted.
     */
    if (!HOSTED) { // Cloud nodes have no desktop app sessions and no SKILL mode
      const callerEntry = agentSessions.get(agent);
      const gate = await import(new URL('../skill-gate.mjs', import.meta.url).href);
      const verdict = gate.checkGate(tool, callerEntry.registeredAt ? callerEntry.type : 'unknown');
      if (!verdict.ok) return { ok: false, skillClosed: true, error: verdict.message, message: verdict.message };
    }

    /*
     * Plug loopholes (plan agent-workflow-plan.md A1): if set_project_meta contains fields undeclared
     * in the schema, reject the entire request.
     * The implementation layer (src/mcp/handlers/project.ts) also blocks it; this is a common gate for
     * both entry points.
     */
    const strict = await import(new URL('./strict-args.mjs', import.meta.url).href);
    const unknownArgs = strict.undeclaredArgs(tool, toolDef, args);
    if (unknownArgs.length) return { ok: false, error: strict.undeclaredArgsError(tool, toolDef, unknownArgs) };

    /*
     * Creativity level gate (server/agent/creativity-gate.mjs, lookup table is there). The effective
     * level for this chat:
     * Chats in the AI panel take their own override value, falling back to the project if none; desktop
     * app sessions (unregistered chat IDs) follow the project. Intercept before execution.
     */
    const creativityGate = await import(new URL('./creativity-gate.mjs', import.meta.url).href);
    const { level: creativity, source: creativitySource } = agentSessions.creativityOf(agent, currentProjectCreativity());
    const allowed = creativityGate.checkCreativity(tool, args, creativity, { cardExists: userCardExists, source: creativitySource });
    if (!allowed.ok) {
      agentLog('agent.creativity-denied', { tool, agent: agent || '', ...allowed.creativity });
      return { ok: false, error: allowed.error, creativity: allowed.creativity };
    }
    agentSessions.touch(agent);

    /*
     * Bound to project replica (C6.5): delegate to server/agent/agent-side.mjs: emit an event before
     * and after each tool call (D2, with callId); side: "agent" executes on the replica (D1 / D4),
     * "page" via the page, and "server" in place (runServerTool).
     * Not bound: same as before, no events emitted.
     */
    /*
     * Multi-Agent (A3): wrap a layer: during invocation, the bulletin board knows "who is running what
     * tool"; after invocation, put what needs to be told to it (messages sent to it by other Agents,
     * others modifying scopes it declared, its writes being overwritten, it writing into scopes declared
     * by others) into the result, with notice first.
     */
    return multiAgent.wrap(agent || '', tool, async () => {
      const binding = agentBinding;
      if (binding) return binding.side.callTool(tool, args, { agent: agent || '', callId });
      // Replica not bound: writes execute via the page, and which clips were written is unknown here;
      // notify based on clips named in parameters (when bound, computed in agent-side from actual writes)
      try {
        const out = await dispatchTool(tool, args, agent, toolDef);
        return annotateResult(out, { userEditing: userEditingFor({ tool, args, editing: userEditingBoard.current() }) });
      } catch (err) {
        throw annotateError(err, userEditingFor({ tool, args, editing: userEditingBoard.current() }));
      }
    });
  }

  async function dispatchTool(tool, args, agent, toolDef) {
    /*
     * Read / render tools execute in place when mirrors exist, querying the prerender process
     * directly without going through the editor page (see runMirroredTool above).
     * Those returning undefined (no mirror, asset montages, etc.) go through the bridge as usual.
     */
    const mirrored = await runMirroredTool(tool, args, toolDef);
    if (mirrored !== undefined) return mirrored;
    if (toolDef.side === 'server') return runServerTool(tool, args, agent);
    const out = await callEditorPage(tool, args, agent, toolDef.timeoutMs || 60000);
    // When not connected to document service, bulletin board change records are recorded here: page
    // executor calculates which "cut->track" entries were modified and returns them with the response (A3)
    if (Array.isArray(out?.scopes) && out.scopes.length && !agentBinding) board().noteChange(agent || '', tool, out.scopes);
    if (out.ok) return out.result || out;
    throw new Error(out.error);
  }

  /** Tools with side: "server" (do not touch projects, do not go through browser bridge) */
  async function runServerTool(tool, args, agent) {
    // The five multi-Agent tools (A3): bulletin board and launching subagents, answered in this process
    if (multiAgent.isTool(tool)) return multiAgent.handle(tool, args, agent || '');

    /*
     * Tools with side: "server" execute in place and do not go through the browser bridge.
     *
     * Currently only wait. It is purely "sleeping for a while", with no reason to take a pass through
     * the editor: and this way, even if the bridge is busy at this moment, waiting between polling will
     * not fail.
     * The SKILL gate above still governs it (when the user revokes control, even waiting should not
     * continue).
     */
    {
      if (tool === 'wait') {
        // Only recognize genuine numbers: Number(null) is 0, Number('') is also 0; relying on isFinite
        // treats "not filled" as "filled 0" and clamps it to 1 second: that is not the user's intent, the
        // default should be 3 seconds
        const raw = (args)?.seconds;
        const secs = typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(30, Math.max(1, raw))
          : 3;
        await new Promise((r) => setTimeout(r, secs * 1000));
        return { ok: true, waited: secs };
      }
      if (tool === 'report_progress') {
        // Progress reports only undergo validation and normalization; the UI directly reads input in the
        // tool_call event.
        const { validateProgressReport } = await import(new URL('../progress-report.mjs', import.meta.url).href);
        const checked = validateProgressReport(args);
        if (!checked.ok) {
          return { ok: false, error: checked.error };
        }
        return { ok: true, message: 'Progress report recorded', report: checked.value };
      }
      return { ok: false, error: `Server tool ${tool} is not implemented` };
    }
  }

  /**
   * Execute a tool via editor page (SSE sends call, page returns via POST /api/mcp/result). Raw
   * response returned to page is { ok, result, error, opIds? }; returns ok:false on timeout.
   * `__page_state` (PAGE_STATE_TOOL in server/agent/agent-side.mjs) also takes this path: requests
   * read-only page state once from the page.
   */
  async function callEditorPage(tool, args, agent, limit) {
    if (!editorRes) {
      // Desktop app sessions hit this most often (SKILL mode keeps the editor closed by default;
      // background mode is plan A5): explain what it is and what to do
      throw new Error(`Editor is not open: no page is connected to /api/mcp/events. ${tool} has to run in the PromptCut editor; ask the user to open the editor and try again, and do not retry repeatedly.`);
    }

    const id = nextCallId++;
    // Most tools are instantaneous; slow tasks return a jobId for callers to poll, so 60 seconds is
    // sufficient.
    // The exception is see_frames: it launches a Chrome on the spot to render a frame; cold start plus
    // asset preheating may take over a minute.
    // Let tools declare their own limits rather than relaxing them for all tools: report errors early
    // when truly stuck. (limit is provided by callers per tool)
    // Keep timer handles: if not cleared after tool returns normally, each call leaves a stray timer
    // for up to tens of seconds in the event loop. Tool calls are frequent; accumulating them wastes
    // memory and wakeups.
    let timer;
    const p = new Promise     (resolve => {
      pendingCalls.set(id, (result) => { clearTimeout(timer); resolve(result); });
      timer = setTimeout(() => {
        if (pendingCalls.has(id)) {
          pendingCalls.delete(id);
          resolve({ ok: false, error: `${tool} did not return within ${Math.round(limit / 1000)} seconds; stopped waiting.` });
        }
      }, limit);
    });

    editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool: pageToolName(tool), args, agent: agent || undefined })}\n\n`);

    // When tools remaining on the page write to the project, the page response includes opIds
    // committed this time (c65-integ2 wiring); agent-side advances the version read by the chat accordingly
    return await p;
  }

  server.middlewares.use('/api/ai/chat', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    // 32MB: attachments carry addresses and text (ChatAttachment has no inline binary), enough for
    // whole captions and entire documents; anything larger is no longer normal input, but someone
    // flooding data through this path.
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, 'Request body exceeds 32MB'); });
    req.on('end', async () => {
      if (over) return;
      let hasDone = false;
      // This round on the bulletin board has started (A3): record an end regardless of how it finishes,
      // otherwise this chat remains considered "busy"
      let runBegun = false;
      let runAgentId = '';
      try {
        const runners = await getRunner();
        const data = JSON.parse(body);
        const { provider, prompt, sessionId, model, effort, fast, attachments, script, schemaCompat, deepAuto } = data;
        if (provider === 'codex') {
          const { codexAuthState, authFailureEvent } = await import('../runners/codex-auth-state.mjs');
          const auth = codexAuthState().snapshot();
          if (auth.state !== 'normal') {
            // Before quota probes or task registration: no CLI executes known-invalid credentials.
            const event = auth.state === 'invalid' ? authFailureEvent(auth.reason) : {
              type: 'error', message: 'Codex login state needs confirmation, please log in again.', retryable: false,
              authProvider: 'codex', authReason: 'state_unknown', authGeneration: auth.revision,
            };
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.end(`data: ${JSON.stringify(event)}\n\n`);
            return;
          }
        }
        // Multi-Agent tab: chat ID for this tab. Only recognizes the session id character set;
        // treat everything else as not provided
        const agentId = typeof data.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : '';
        runAgentId = agentId;

        let systemPrompt = '';
        try {
          systemPrompt = fs.readFileSync(new URL('../ai-system-prompt.md', import.meta.url), 'utf-8');
        } catch {
          systemPrompt = 'System prompt missing.';
        }

        // The script is concatenated into the system prompt each round rather than mentioned once in the
        // first user message: multi-round execution easily drifts off course following intermediate results;
        // placing it in the system prompt keeps it on track.
        if (typeof script === 'string' && script.trim()) {
          systemPrompt += `\n\n## Script for this video (written by the user; follow it at every step)\n\n${script.trim()}\n\n` +
            'This is the storyline of this video. Check against it for every decision about arrangement, captions and motion graphics; ' +
            'Do not do anything that conflicts with it, and when unsure follow what the script says. Details the script does not cover are yours to decide.';
        }

        let finalPrompt = prompt;
        // List those media library items separately: provide mediaId and cardUrl usable directly by cards,
        // **do not provide disk paths**: previously each round stuffed disk paths for every asset in, yet
        // the model had no tool to read them and was repeatedly misled to read them (see src/ai/mediaRef.ts)
        const library = (attachments || []).filter((a) => a.library);
        const userFiles = (attachments || []).filter((a) => !a.library);
        if (library.length > 0) {
          const kindName = { video: 'Video', image: 'Image', audio: 'audio' };
          finalPrompt += '\n\nMedia library (already imported; use mediaId in tools, use cardUrl for references in card parameters):\n' + library.map((a) => {
            let line = `- [${kindName[a.kind] || a.kind}] ${a.name} · mediaId ${a.id} · cardUrl ${a.url}`;
            if (a.durationSec && a.kind !== 'image') line += ` · duration ${a.durationSec} seconds`;
            return line;
          }).join('\n');
        }
        // Attachments also **do not provide disk paths** (for the same reason as media library items above):
        // Agents read and write bytes via interfaces and do not read any storage directories
        // (docs/semantics/product/agent.md "Assets and artifacts"); it cannot read disk paths and will only
        // be misled to read them.
        // To cut, transcribe, or add motion graphics, first use import_media to load the "site URL" into
        // the media library (import_media tool description documents this path).
        if (userFiles.length > 0) {
          finalPrompt += '\n\nAttachments (in the chat\'s working directory, not in the media library; to cut, transcribe or add motion graphics, first pass its in-app URL to import_media to load it into the media library):\n' + userFiles.map((a) => {
            let line = `- [${a.kind === 'video' ? 'Video' : a.kind}] ${a.name} · in-app URL ${a.url}`;
            if (a.durationSec) line += ` · duration ${a.durationSec} seconds`;
            if (a.text) line += `\n\`\`\`\n${a.text}\n\`\`\``;
            return line;
          }).join('\n');
        }

        /*
         * Register this chat (server/agent/agent-sessions.mjs): override values for type, vendor, role, and
         * creativity level.
         * creativity is the level set separately for this tab; null / omitted = follows project;
         * projectCreativity is the project default on the page at this moment, used only when the server
         * cannot read the project. Register with every message: users may switch drivers or levels between
         * two messages.
         */
        if (typeof data.projectCreativity === 'string') projectCreativityHint = normalizeCreativity(data.projectCreativity);
        agentSessions.register(agentId, {
          type: provider === 'api' ? 'api' : 'cli',
          vendor: provider === 'api' ? String((await import(new URL('../ai-config.mjs', import.meta.url).href)).publicConfig()?.api?.vendor || 'api') : String(provider || ''),
          role: 'main',
          creativity: normalizeCreativity(data.creativity),
        });
        const { level: convCreativity, source: convCreativitySource } = agentSessions.creativityOf(agentId, currentProjectCreativity());

        /*
         * Multi-Agent (A3):
         *   - Subagents launched by spawn_agent: concatenate its role prompt into the system prompt each
         *     round (after multiple rounds it is easiest to forget who it is);
         *   - Updates from other Agents (what scopes were modified, undelivered messages that reached inbox
         *     capacity) are concatenated before this round's prompt, entering only the model;
         *   - hops: which layer of automatic delivery this is (included when the page delivers another
         *     Agent's messages); the bulletin board uses this to cap cascades.
         */
        const sess = agentSessions.get(agentId);
        if (agentId && sess.parent && sess.role) {
          const role = loadRole(sess.role);
          if (role) {
            systemPrompt += `\n\n## Your role: ${role.name}\n\nYou are a sub-Agent spawned by Agent ${sess.parent} with spawn_agent, chat ID ${agentId}.` +
              'Do only the part it handed to you; start with declare_scope, report back with report_progress when done, then use send_message to tell the Agent that spawned you the result.' +
              ` You cannot spawn other Agents.\n\n${role.prompt}`;
          }
        }
        const agentNotes = agentId ? board().consumeNotes(agentId) : '';
        if (agentNotes) finalPrompt = `${agentNotes}\n\n${finalPrompt}`;
        const runHops = Number.isSafeInteger(data.hops) && data.hops > 0 ? data.hops : 0;

        const editorPort = (server.httpServer?.address())?.port || 5195;
        const editorState = editorRes ? "Editor connected" : "Not connected";
        finalPrompt += `\n\nCurrent port ${editorPort}; ${editorState}` + (agentId ? `; your Agent chat ID: ${agentId}` : '') +
          `; creativity level "${CREATIVITY_LABEL[convCreativity                                 ]}" (${convCreativitySource}): ` +
          `${CREATIVITY_HINT[convCreativity                                ]}. Tool calls above your level will be rejected; if rejected, stop and tell the user, do not work around it`;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.flushHeaders();

        const keepAlive = setInterval(() => {
          res.write(': ping\n\n');
        }, 15000);

        const mcp = {
          serverName: "promptcut",
          command: process.execPath,
          args: [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))],
          // PROMPTCUT_CALLER=cli: this MCP is started by the AI panel, not a desktop app session
          // (mcp-server.mjs uses this to not report desktop identity)
          env: { PROMPTCUT_CALLER: 'cli', PROMPTCUT_PORT: String(editorPort), ...(agentId ? { PROMPTCUT_AGENT: agentId } : {}) }
        };

        const cwd = path.join(server.config.root, 'exports', 'ai-workspace');
        fs.mkdirSync(cwd, { recursive: true });

        const runId = Math.random().toString(36).substring(2, 9);
        res.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);

        const { publicConfig } = await import(new URL('../ai-config.mjs', import.meta.url).href);
        const cfg = publicConfig();

        // Quota circuit breaker: check usage for this route first; if it exceeds the limit, do not launch
        // the CLI and tell the user the reason directly
        const { guard: quotaGuard, mod: quotaMod } = await getQuotaGuard();
        try {
          // Pass the model in together: windows like "This week (Fable)" in claude's /usage are model-specific;
          // if not running that model, do not use it to block (see decidingWindows in quota.mjs)
          await quotaGuard.gate(provider, cfg.quota, model);
        } catch (e) {
          if (e instanceof quotaMod.QuotaExceededError) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: e.message, quota: e.quota })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            clearInterval(keepAlive);
            res.end();
            return;
          }
          throw e;
        }
        let replyBytes = 0;
        /*
         * D2: Emit an event when the full text reply completes (when bound to a project replica).
         * Replies form segments between tool calls; when the next tool call or the end of this round is
         * reached, the accumulated segment is sent.
         */
        let pendingText = '';
        const flushText = () => {
          const b = agentBinding;
          if (b && pendingText.trim()) b.side.executor.text(agentId, pendingText);
          pendingText = '';
        };

        if (agentId) { board().beginRun(agentId, runHops); runBegun = true; }
        const run = runners.startRun({
          provider,
          prompt: finalPrompt,
          systemPrompt,
          sessionId,
          cwd,
          // Code block space is placed under the working directory by project (server/tools/code-cache.mjs,
          // A07 2026-10-22); when no project is bound, it uses the local copy
          codeCacheDir: path.join(cwd, 'code-cache', String(currentProjectKey() || 'local').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_') || 'local'),
          codeCacheWriter: agentId || sessionId,
          // Speed records for setting single-output limits based on measured speed: on this machine, placed
          // in the same directory as ai.json (localOutputSpeedFile in runners/api.mjs)
          outputSpeedFile: 'local',
          // User-added skills: skills/ in the same directory as ai.json (localSkillsDir in runners/api.mjs)
          skillsDir: 'local',
          model,
          /*
           * Deep autonomy: the round limit is replaced with "autonomous rounds" in settings (deepAutoRounds
           * in ai.json, default 300, 0 means unlimited), and no wording regarding rounds is given to the
           * model anymore.
           *
           * The number of rounds is taken from **server configuration**, ignoring the number in the
           * request body: the frontend only sends a boolean for "whether enabled". The limit is a safety
           * valve and should not be casually overridden by a request field.
           */
          maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
          deepAuto: !!deepAuto,
          // Reasoning effort and acceleration tiers: which provider supports which is translated into flags
          // by their respective runners; unsupported ones are directly ignored (the frontend has also grayed
          // out the corresponding controls)
          effort,
          fast,
          /*
           * Deep autonomy: the round limit is replaced with "autonomous rounds" in settings (deepAutoRounds
           * in ai.json, default 300, 0 means unlimited), and no wording regarding rounds is given to the
           * model anymore.
           *
           * The number of rounds is taken from **server configuration**, ignoring the number in the
           * request body: the frontend only sends a boolean for "whether enabled". The limit is a safety
           * valve and should not be casually overridden by a request field.
           */
          maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
          deepAuto: !!deepAuto,
          // Parameter compatibility mode (tool schema sanitized to Gemini subset): 'auto' / 'on' / 'off',
          // only used by direct API runners
          schemaCompat,
          // Standalone toggle for review loop (only used by direct API); if omitted, follows deep autonomy,
          // see runners/api.mjs
          reviewLoop: typeof data.reviewLoop === 'boolean' ? data.reviewLoop : undefined,
          // When review loop runs via CLI, place a read-only lock on tools per turn (see callToolInternal).
          // null = unlocked
          setToolAccess: (list) => { loopToolLock = list ? new Set(list) : null; },
          toolProtocol: cfg.toolProtocol,
          mcp,
          // codex and agy check in tool calls in the output stream; /api/mcp/call claims the same callId
          // based on clues (see callPairing above)
          callPairing,
          // meta.callId: the tool_use id from the direct API path (passed in from
          // server/harness/tools/index.mjs); events include it, and the AI panel matches against it
          callTool: async (name, args, meta) => await callToolInternal(name, args, agentId || undefined, typeof meta?.callId === 'string' ? meta.callId : undefined),
          onEvent: (ev) => {
            if (ev.type === 'done' || ev.type === 'error') hasDone = true;
            if (ev.type === 'text' && typeof ev.delta === 'string') pendingText += ev.delta;
            if (ev.type === 'tool_call' || ev.type === 'done' || ev.type === 'error') flushText();
            if (ev.type === 'text' && typeof ev.delta === 'string') replyBytes += Buffer.byteLength(ev.delta, 'utf8');
            // The chat never reads a tool result's full output (get_project is the whole
            // project); sending it made the editor parse and trace megabytes per result.
            // Server-side consumers of onEvent still receive it unchanged.
            const outbound = ev.type === 'tool_result' && ev.output !== undefined ? { ...ev, output: undefined, outputOmitted: true } : ev;
            res.write(`data: ${JSON.stringify(outbound)}\n\n`);
          }
        });

        const runState = {
          abort: run.abort, finished: false, provider,
          // When a background recheck detects that limits are exceeded, write the reason to the person
          // currently viewing this chat, then kill the process
          fail: (message) => { try { res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`); } catch {} },
        };
        activeRuns.set(runId, runState);

        res.on('close', () => {
          if (!runState.finished) run.abort();
          activeRuns.delete(runId);
          clearInterval(keepAlive);
        });

        try {
          await run.done;
        } catch (e) {
          if (!res.headersSent) throw e;
          res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
        }

        runState.finished = true;
        activeRuns.delete(runId);
        clearInterval(keepAlive);
        flushText();
        // Accounting: new context this round = sent prompt + received reply. Recheck in the background upon
        // hitting the limit, and kill other chats on the same path when limits are exceeded
        const noted = quotaGuard.note(provider, Buffer.byteLength(finalPrompt, 'utf8') + replyBytes, cfg.quota, model);
        if (noted) noted.then((v) => { if (v?.blocked) failProviderRuns(provider, v.message); }).catch(() => {});
        if (!hasDone) {
           res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        }
        res.end();

      } catch (e) {
        if (!res.headersSent) {
          sendJson(res, 503, { ok: false, error: String(e) });
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
          res.end();
        }
      } finally {
        if (runBegun) board().endRun(runAgentId);
      }
    });
  });

  server.middlewares.use('/api/ai/abort', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, 'Request body exceeds 8KB'); });
    req.on('end', () => {
      if (over) return;
      try {
        const { runId } = JSON.parse(body);
        const runState = activeRuns.get(runId);
        if (runState && !runState.finished) {
          runState.abort();
          runState.finished = true;
          activeRuns.delete(runId);
        }
        sendJson(res, 200, { ok: true });
      } catch(e) {
        sendJson(res, 400, { ok: false, error: String(e) });
      }
    });
  });

  server.middlewares.use('/api/mcp/events', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });

    // There is only one in this position (editorRes); subsequent connections evict the previous one:
    // user page refreshes rely on it to take over again
    if (editorRes) {
      editorRes.write(`data: ${JSON.stringify({ type: "replaced" })}\n\n`);
      editorRes.end();
    }

    editorRes = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const port = (server.httpServer?.address())?.port || 5195;
    res.write(`data: ${JSON.stringify({ type: 'hello', port })}\n\n`);
    // Push a copy of the bulletin board's current state (scope name on the tab, unread) first (A3);
    // also push a copy of desktop app session groups (A4)
    pushBoard();
    pushDesktop();

    req.on('close', () => {
      if (editorRes === res) editorRes = null;
    });
  });

  server.middlewares.use('/api/mcp/result', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    // Tool results return from the page, which may contain full visuals or large blocks of text, so
    // be generous; being generous still has an upper limit.
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, 'Tool result exceeds 64MB'); });
    req.on('end', () => {
      if (over) return;
      try {
        const data = JSON.parse(body);
        const cb = pendingCalls.get(data.id);
        if (cb) {
          cb(data);
          pendingCalls.delete(data.id);
        }
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e) });
      }
    });
  });

  server.middlewares.use('/api/mcp/call', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, 'Request body exceeds 32MB'); });
    req.on('end', async () => {
      if (over) return;
      try {
        const { tool, args, agent, callId, pair, caller } = JSON.parse(body);
        // callId: Claude Code brings it via MCP's _meta["claudecode/toolUseId"] (forwarded from
        // server/mcp-server.mjs); events include it
        let call = typeof callId === 'string' && callId.length <= 128 ? callId : undefined;
        /*
         * codex and agy do not carry callId, only pairing clues pair: { scope, hint? } (pairingOf in
         * mcp-server.mjs). Events are emitted only when bound to a project replica, which is when callId
         * is useful; when not bound, do not wait for pairing. If it cannot be paired, omit it, same as
         * before.
         */
        if (!call && agentBinding && pair && typeof pair.scope === 'string' && pair.scope.length <= 160) {
          call = await callPairing.claim(pair.scope, tool, args ?? {}, typeof pair.hint === 'string' && pair.hint.length <= 128 ? pair.hint : undefined);
        }
        /*
         * Desktop app sessions (A4): mcp-server.mjs reports caller { type: 'desktop', key, vendor,
         * label, client }. Register on each call (type desktop, following the project's creativity level),
         * using its key as the chat ID: write identity (document service opens connections per chat),
         * bulletin board, "user editing", and overwrite notices all distinguish by it, taking the same
         * path as Agents in the AI panel. AI panel calls carry agent, not caller.
         */
        const desk = desktopCallerOf(caller);
        const agentKey = desk ? desk.key : (typeof agent === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(agent) ? agent : undefined);
        if (desk) agentSessions.register(desk.key, { type: 'desktop', vendor: desk.vendor, label: desk.label, client: desk.client, role: null });
        const handle = desk ? desktopActivity.begin(desk.key, desk, String(tool), args) : null;
        let result;
        try {
          result = await callToolInternal(tool, args, agentKey, call);
        } catch (e) {
          if (handle) desktopActivity.end(handle, null, e);
          throw e;
        }
        if (handle) {
          desktopActivity.end(handle, result, null);
          requestSkillPreview(String(tool), args, result);
        }
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        if (e.code === 'UNKNOWN_TOOL') {
          sendJson(res, 404, { ok: false, error: e.message });
        } else {
          sendJson(res, 200, { ok: false, error: e.message });
        }
      }
    });
  });

  /*
   * C6.5 Project replica on the Agent server (see bindAgent above). After the page (c65-editor)
   * connects to the document service:
   *   POST /api/agent/bind   { projectId, mode?: "local" | "lan-host" | "ticket", url? } → { ok, projectId, mode, url }
   *   POST /api/agent/unbind {} → { ok } (when switching projects or disconnecting from document service)
   *   POST /api/agent/ticket { reqId, ticket? , error? } → returns connection ticket requested by { type: "agent.ticket" } in SSE
   *   GET  /api/agent/status → whether bound, version read by each chat, replica version (diagnostics)
   */
  const readJsonBody = (req, res, max, onBody) => {
    let body = '';
    let over = false;
    req.on('data', (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, max, `Request body exceeds ${max} bytes`); });
    req.on('end', () => {
      if (over) return;
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'Request body is not JSON' }); }
      onBody(data);
    });
  };
  server.middlewares.use('/api/agent/bind', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, async (data) => {
      try {
        const b = await bindAgent(data);
        sendJson(res, 200, { ok: true, projectId: b.projectId, mode: b.mode, url: b.url });
      } catch (e) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
    });
  });
  server.middlewares.use('/api/agent/unbind', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, () => { unbindAgent('page'); sendJson(res, 200, { ok: true }); });
  });
  server.middlewares.use('/api/agent/ticket', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, (data) => {
      const w = typeof data?.reqId === 'string' ? ticketWaiters.get(data.reqId) : undefined;
      if (!w) return sendJson(res, 404, { ok: false, error: 'Nothing is waiting for this ticket' });
      ticketWaiters.delete(data.reqId);
      clearTimeout(w.timer);
      if (typeof data.ticket === 'string' && data.ticket.length > 0 && data.ticket.length <= 2048) w.resolve(data.ticket);
      else w.reject(new Error(typeof data.error === 'string' ? `Page failed to sign a ticket: ${data.error}` : 'Ticket returned by the page is invalid'));
      sendJson(res, 200, { ok: true });
    });
  });
  /*
   * "User editing" (A2):
   *   POST /api/agent/editing { session, entities: [{ clipId, kind: "drag" | "text" | "recent", remainingMs? }] } → { ok, count }
   *     Full state pushed by editor page (src/editor/userEditing.ts), pushed on change (throttled),
   *     renewed via heartbeat when non-empty;
   *   GET  /api/agent/editing → { ok, entities } (diagnostics, probe)
   */
  server.middlewares.use('/api/agent/editing', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, entities: userEditingBoard.current() });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET / POST only' });
    readJsonBody(req, res, 64 * 1024, (data) => {
      try {
        const count = userEditingBoard.report(data?.session, data?.entities);
        sendJson(res, 200, { ok: true, count });
      } catch (e) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
    });
  });
  /*
   * Multi-Agent (A3):
   *   POST /api/agent/tabs    { tabs: [{ conversationId, title, busy }] } → { ok }
   *     Page tabs (full set), used by bulletin board list and concurrency quota
   *   POST /api/agent/inbox   { conversationId, onlyAuto? } → { ok, messages }
   *     When page is idle, fetches messages sent to this tab to emit as a user message
   *   POST /api/agent/spawned { reqId, ok, error? } → { ok }
   *     Page finished opening (or failed to open) tab requested by spawn_agent
   *   GET  /api/agent/board → { ok, agents, list }
   *     Diagnostics, probe
   */
  server.middlewares.use('/api/agent/tabs', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 64 * 1024, (data) => {
      lastTabs = Array.isArray(data?.tabs) ? data.tabs.slice(0, 64) : [];
      board().setTabs(lastTabs);
      sendJson(res, 200, { ok: true });
    });
  });
  server.middlewares.use('/api/agent/inbox', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, (data) => {
      const key = typeof data?.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : null;
      if (!key) return sendJson(res, 400, { ok: false, error: 'conversationId is invalid' });
      const b = board();
      b.markSeen(key);
      sendJson(res, 200, { ok: true, messages: b.takeInbox(key, data?.onlyAuto !== false) });
    });
  });
  server.middlewares.use('/api/agent/spawned', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, (data) => {
      const w = typeof data?.reqId === 'string' ? spawnWaiters.get(data.reqId) : undefined;
      if (!w) return sendJson(res, 404, { ok: false, error: 'Nothing is waiting for this tab' });
      spawnWaiters.delete(data.reqId);
      clearTimeout(w.timer);
      if (data.ok === true) w.resolve();
      else w.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 300) : 'Page failed to open a tab'));
      sendJson(res, 200, { ok: true });
    });
  });
  server.middlewares.use('/api/agent/board', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    res.setHeader('Cache-Control', 'no-store');
    const b = board();
    sendJson(res, 200, { ok: true, project: currentProjectKey(), agents: b.snapshot(), list: b.listRaw(''), sessions: agentSessions.list(), changes: b._changes().slice(-50) });
  });
  /*
   * Desktop app session groups (A4): GET /api/agent/desktop → { ok, sessions } (fetched once when
   * the page connects, then receives SSE's agent.desktop; probe also reads it). Each session: id,
   * vendor, ongoing operations, recent calls, submitted progress reports, as well as type in the
   * registry and effective creativity level.
   */
  server.middlewares.use('/api/agent/desktop', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    res.setHeader('Cache-Control', 'no-store');
    const level = currentProjectCreativity();
    const sessions = desktopActivity.snapshot().map((s) => {
      const c = agentSessions.creativityOf(s.id, level);
      return { ...s, type: c.entry.type, creativity: c.level };
    });
    sendJson(res, 200, { ok: true, sessions });
  });
  server.middlewares.use('/api/agent/status', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    res.setHeader('Cache-Control', 'no-store');
    const b = agentBinding;
    sendJson(res, 200, b ? { ok: true, bound: true, mode: b.mode, url: b.url, ...b.side.describe(), presence: presenceBridge?.describe() ?? null, editing: userEditingBoard.describe() } : { ok: true, bound: false });
  });

  server.middlewares.use('/api/mcp/status', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const port = (server.httpServer?.address())?.port || 5195;
    let activeRunCount = 0;
    for (const st of activeRuns.values()) if (!st.finished) activeRunCount++;
    sendJson(res, 200, {
      editorConnected: !!editorRes,
      pending: pendingCalls.size,
      /*
       * How many chat rounds are still running. The patch script (desktop/scripts/apply-patch.ps1)
       * relies on this to decide whether to intercept: the patch will overwrite the entire runtime/app,
       * and when an overwrite happens right under a dev server currently serving pages, the agent side
       * **will not crash, only go mute**: loops in Node run as usual, requests to the model are sent as
       * usual, but every HTTP request sent by the page (tool result returns, frame viewing, reading card
       * source code) hangs completely until the service restarts. The symptom is a series of inexplicable
       * tool timeouts with no traceable cause.
       */
      activeRuns: activeRunCount,
      port
    });
  });

  return {
    /** CLI quota circuit breaker: `/api/ai/quota` (kept in the host) shares the same copy with chats */
    getQuotaGuard,
    bindAgent,
    unbindAgent,
    callTool: callToolInternal,
    /**
     * Project replica bound to this instance and versions read by each chat (diagnostics); returns
     * null when not bound
     */
    describe: () => (agentBinding ? agentBinding.side.describe() : null),
    replica: () => {
      const r = agentBinding?.side?.link?.replica;
      return r && r.hasBody ? { project: r.project, rev: r.rev } : null;
    },
    close(reason = 'close') {
      unbindAgent(reason);
      clearTimeout(boardPushTimer);
      clearTimeout(desktopPushTimer);
    },
  };
}
