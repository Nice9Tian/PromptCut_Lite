/**
 * Agent 服务的一个实例(契约 `docs/plan/cloud-agent-contract.md` 第 2.1、3 节)。
 *
 * 这里是原来 `server/vite-plugin-ai.ts` 插件闭包里的那一套:页面通道、项目副本的绑定、工具调用的总入口
 * (SKILL 闸、创造力等级闸、多 Agent)、对话(`/api/ai/chat`)、多 Agent 与桌面会话的接口。
 * 闭包里的状态就是这个实例的状态:桌面档只建一个实例,由 `vite-plugin-ai.ts` 把 `routes` 挂到编辑器进程上。
 *
 * `env.server` 是宿主给的一小块 vite 服务器形状(`httpServer`、`ssrLoadModule`、`config.root`、`middlewares.use`),
 * 前端代码只经 `ssrLoadModule` → `../ssr-host.mjs` 载入;本目录不直接引用 `src/`。
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
 * @param {Function} env.prerenderPost 问预渲染进程(`server/prerender-client.mjs`;必须由宿主静态引入后传进来,见宿主里的说明)
 * @param {() => object | null} env.latestMirror 当前编辑页的数据镜像(`server/vite-plugin-mirror.ts`)
 * @param {() => { t: number } | null} env.latestPlayhead
 * @param {'desktop' | 'hosted'} [env.profile] 缺省 `desktop`。`hosted`(云节点,契约第 3 节)时另给:
 *   `projectId`(这个实例只为它服务)、`docUrl`、`protocolsFor(对话号, 对话 id)`(连文档服务的子协议)、
 *   `execSerial`(进程级的串行锁,所有实例共用)、`log(event, fields)`,以及可选的
 *   `initiatorOnline(对话 id)`(发起这一轮的成员此刻有没有连着看)、`pageCall(对话 id, 工具, 参数)`(反向通道:让发起这一轮的那张页面执行一次,
 *   回 `{ ok: true, result: { ok, result?, error? } }` 或 `{ offline: true }`;契约第 28 节)、`onWrite(对话 id, { opId, rev, clipIds })`(一次写入落地了)、
 *   `onFinalClose({ code, reason })`(文档服务以 4003 / 4004 关掉了数据连接:撤销)、
 *   `hostedTools`(`hosted-tools.mjs` 的进程级那一份:在服务端实现的工具)、`ownerKey`(对话归谁,工作区的目录按它分)
 */
export function createAgentInstance(env) {
  const { server, prerenderPost, latestMirror, latestPlayhead } = env;
  /** 托管档:没有页面、没有命令行驱动与桌面会话;工具按开放清单放行,凭证由宿主给(契约第 3、4、9 节) */
  const HOSTED = false;
  /**
   * 账号模式下这条任务的工具提供者(`account-tools.mjs`,宿主按这个进程里真的建出来的给);旧托管档与桌面档没有。
   * 工具算不算「已接上」只看它:`accountProvided` 里有才交给模型、才执行,否则照静态表回「还没接上」或走原来的路。
   */

  /** 这一次工具调用的调用号(模型那一侧的 tool_use id):提供者拿它当请求号,宿主重试同一次调用不会开第二个作业 */
  const toolCallScope = new AsyncLocalStorage();
  let editorRes = null;
  let nextCallId = 1;
  const pendingCalls = new Map                               ();
  const activeRuns = new Map                                                                                                       ();
  /**
   * codex、agy 两路的 callId 配对(server/agent/call-pairing.mjs):runner 在输出流里看到工具调用就报到,
   * /api/mcp/call 进来的同一次调用按 mcp-server.mjs 转来的线索认领,拿到和聊天记录里同一个 callId。
   */
  const callPairing = createCallPairing();
  /**
   * CLI 额度熔断(server/runners/quota.mjs):对话开始前 gate,结束后按新增字节记账、到线后台重查;
   * 重查发现超线就把同一路正在跑的对话全部掐掉。模块懒加载,和别的 runner 一样。
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
      // 相对路径按 server/ 目录解析(与搬进本目录之前相同)
      runnerUrl = new URL(mod, new URL('../', import.meta.url)).href;
    }
    try {
      return await import(runnerUrl);
    } catch (e) {
      throw new Error(`Runner 尚未就绪或加载失败: ${e.message}`);
    }
  }

  /**
   * agent:发起这次调用的 Agent 对话 ID(多 Agent 分页)。CLI 那条路由 mcp-server 从环境变量
   * PROMPTCUT_AGENT 带上来,API 直连那条路由 startRun 的 callTool 闭包带;编辑台拿它记「谁改了哪儿」。
   */
  /*
   * 数据管理的只读镜像(docs/archive/topics/decoupling-plan.md 第 3.2 节,阶段 4;A7)。
   *
   * 编辑页把项目(带版本号)推给**镜像插件**(server/vite-plugin-mirror.ts,两个进程都挂),
   * 播放头走它的 /api/data/playhead。这里只读:Agent 的读和渲染 —— get_project /
   * see_frames(成片)/ get_gif / bake_card / inspect_card_dom —— 直接拿镜像去问预渲染进程,
   * **完全不经过编辑器页面**:以前这些调用要经 SSE 转给页面,页面再发渲染请求,请求一挂几分钟,
   * 占的是编辑器那个源的连接,界面因此卡死而 CPU 一点都不忙。
   * 写操作仍然经过页面(撤销 / 重做都在那边),页面在回结果之前会先把改动推过来,读后写一致。
   * 页面关掉之后镜像还留在内存里,Agent 照样能读、能看画面。
   *
   * 镜像本身(存储、版本窗口、两层 diff、转发给预渲染)搬到镜像插件里了 —— ai 插件只在
   * 编辑器那一端挂,而预渲染进程也要按键取项目。
   */

  /**
   * 这几个工具在服务端就地执行(有镜像时);其余照旧经编辑器页面。
   * C6.5 D4:绑了项目副本(见下面 bindAgent)时不再用镜像 —— 这几个加上 get_layout 由 server/agent/agent-exec.mjs
   * 读**副本**执行,回包带 rev;这张表只管没绑副本时的老路。
   */
  const MIRRORED_TOOLS = new Set(['get_project', 'see_frames', 'get_gif', 'bake_card', 'inspect_card_dom']);

  /**
   * 服务端执行一个读 / 渲染类工具。返回 undefined = 这里不接,交给编辑器页面。
   * 出错就抛(和经页面那条路一样:桥把 error 原样交给 Agent)。
   */
  async function runMirroredTool(tool, args, toolDef) {
    const mirror = latestMirror();
    if (!MIRRORED_TOOLS.has(tool) || !mirror) return undefined;
    const required = toolDef?.inputSchema?.required ?? [];
    const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
    if (missing.length) throw new Error(`缺少必填参数：${missing.join('、')}。请补齐后重试。`);
    const project = mirror.project;
    const timeoutMs = toolDef?.timeoutMs || 60000;

    if (tool === 'get_project') {
      // 和编辑器页面的 getProject 同一个形状:文字稿只给摘要,全文走 get_transcript
      // 停放剪辑的片段索引放最前,模型不必 user_interface_switch_cut 就拿得到别的剪辑里的 clipId
      const parkedCuts = parkedCutsIndex(project);
      return {
        ...(parkedCuts ? { parkedCuts } : null),
        ...project,
        media: (project.media || []).map((m) => m?.transcript ? {
          ...m,
          transcript: {
            engine: m.transcript.engine, model: m.transcript.model, language: m.transcript.language,
            createdAt: m.transcript.createdAt, segments: m.transcript.segments?.length ?? 0,
            hint: '完整文字稿请用 get_transcript',
          },
        } : m),
      };
    }

    if (tool === 'see_frames') {
      const { source, cutId, ...rest } = args || {};
      // 素材镜头拼图要跑镜头识别、写回项目,留给编辑器页面
      if (source !== undefined && source !== 'timeline') return undefined;
      // cutId:看那条剪辑的画面,不切换(视图只在这次出图时用,见 agent-exec.mjs 的 seeFrames)
      if (cutId !== undefined && cutId !== null && typeof cutId !== 'string') throw new Error('cutId 要是字符串(list_cuts 里的剪辑 id);不传就看当前激活的剪辑。');
      const look = cutLookView(project, cutId);
      const times = Array.isArray(rest.times) ? rest.times.filter((x) => typeof x === 'number').slice(0, 10) : [];
      const body = times.length
        ? { project: look.project, times, clipId: rest.clipId }
        : { project: look.project, t: typeof rest.t === 'number' ? rest.t : (rest.clipId ? undefined : (look.active ? (latestPlayhead()?.t ?? 0) : look.parkedT)), clipId: rest.clipId };
      const data = await prerenderPost('/api/vision/snapshot', body, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || '渲染画面失败');
      let result = times.length ? { ok: true, frames: data.frames, note: data.note, __images: data.__images } : data;
      result = { ...result, cut: look.cut };
      // 聊天栏里「看得见的工具结果」:和编辑器页面的 withVisual 同一份记录
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
      // 两步(cloud-task.md 决议 12):Agent 这一侧只写规格(`'agent'`),像素渲染交给 `user` 那一侧的 `/render`
      const spec = await prerenderPost('/api/ai/visual', { tool: 'get_gif', clipId: args.clipId, after: project }, { timeoutMs });
      if (!spec?.ok) throw new Error(spec?.error || '做动图失败');
      if (!spec.gifKey) throw new Error(`时间轴上没有 id 为 ${args.clipId} 的片段。`);
      const data = await prerenderPost('/api/ai/visual/render', { key: spec.gifKey }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || '做动图失败');
      return {
        visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
        note: '拼图 4×2,第 k 格对应 times 的第 k 个时刻(按行从左到右)。用户在聊天栏点开这一步能看到动图。',
        ...(data.grid ? { __image: { mime: 'image/png', base64: data.grid } } : {}),
      };
    }

    if (tool === 'bake_card') {
      const data = await prerenderPost('/api/vision/bake', { project, clipId: args.clipId, t: args.t, size: args.size, bg: args.bg }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || '渲染失败');
      return data;
    }

    if (tool === 'inspect_card_dom') {
      const ref = typeof args.ref === 'string' ? Number(String(args.ref).replace(/^ref_/, '')) : args.ref;
      const data = await prerenderPost('/api/cards/dom', { project, clipId: args.clipId, t: args.t, ref, depth: args.depth }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || '读不到 DOM 树');
      return data;
    }
    return undefined;
  }

  /*
   * ---------------- C6.5:Agent 服务端的项目副本(D1、D2、D4;docs/plan/c65-design.md 第 5、7 节) ----------------
   *
   * 页面接上文档服务后调 POST /api/agent/bind 告诉这里「我在编辑哪个项目、连的是哪个文档服务」。绑上之后:
   *   - side: "agent" 的工具在这里、在项目副本上执行(server/agent/agent-exec.mjs),写入以 Agent 对话的身份、
   *     带期望版本提交给文档服务,不再经页面;get_project / get_layout / see_frames 等读副本;
   *   - 每个工具调用(不论在哪一侧执行)向文档服务的 events 模块发创建 / 完成两条事件,文字回复整条完成时发一条。
   * 没绑(页面没接文档服务、无头实例停用了文档服务)时一切照旧:写工具经 SSE 送页面执行,读工具读数据镜像。
   *
   * 凭证按对话号给(server/agent/doc-link.mjs 一个对话一条连接):
   *   - mode "local":本机 local 空间,回环 + promptcut.role.agent.<n>;
   *   - mode "lan-host":局域网主机上创建者自己的共享项目,本机声明 promptcut.tenant.<projectId> + promptcut.role.agent.<n>;
   *   - mode "ticket":共享项目(托管端、局域网成员),经 SSE 向页面要一张连接票据(k:'conn', r:'agent', c:<n>),
   *     页面用 POST /api/agent/ticket 交回。
   */
  /*
   * 「用户正在编辑」(计划 agent-workflow-plan.md A2):编辑页把正在编辑的片段节流推到 POST /api/agent/editing,
   * 这里记下(带过期时刻)。Agent 读或写到这些片段时工具结果带 userEditing 和一句提示;只提示,不拦。
   */
  const userEditingBoard = createUserEditingBoard();
  /** 对话 id → 给人看的厂商名(覆盖提示里「Agent <身份>(<厂商>)刚改过」用;桌面 APP 的会话用「Claude Code」这样的名字;登记表在下面) */
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
    // 托管档的日志交给宿主(一行一条 JSON,只有 id、计数、原因码)
    if (HOSTED) { try { env.log?.(event, fields); } catch { /* 日志失败不影响服务 */ } return; }
    try { console.info("[agent]", event, JSON.stringify(fields)); } catch { console.info("[agent]", event); }
  };

  /** 向页面要一张 agent 角色的连接票据(页面凭它在文档服务上的身份签) */
  function requestTicket(projectId, conversation) {
    return new Promise((resolve, reject) => {
      if (!editorRes) return reject(new Error("编辑台没有打开,要不到连接票据"));
      const reqId = `t${++ticketSeq}`;
      const timer = setTimeout(() => {
        ticketWaiters.delete(reqId);
        reject(new Error("页面 10 秒内没有交回连接票据"));
      }, 10_000);
      ticketWaiters.set(reqId, { resolve, reject, timer });
      editorRes.write(`data: ${JSON.stringify({ type: "agent.ticket", reqId, projectId, role: "agent", conversation })}\n\n`);
    });
  }

  async function bindAgent(input) {
    const projectId = typeof input?.projectId === "string" && PROJECT_ID_RE.test(input.projectId) ? input.projectId : null;
    if (!projectId) throw new Error("projectId 不合法");
    const mode = typeof input?.mode === "string" ? input.mode : (HOSTED ? "hosted" : "local");
    if (!AGENT_MODES.has(mode)) throw new Error(`mode 只能是 ${[...AGENT_MODES].join(" / ")}`);
    let url = `ws://127.0.0.1:${editorPortOf()}/docservice`;
    if (mode === "ticket") {
      if (typeof input?.url !== "string" || !/^wss?:\/\//.test(input.url)) throw new Error("mode 为 ticket 时要给文档服务的 ws(s):// 地址");
      url = input.url;
    }
    if (mode === "hosted") {
      // 托管档的实例只为建它时定下的那个项目服务:项目与文档服务地址都不听请求的
      if (projectId !== env.projectId) throw new Error("这个实例不为这个项目服务");
      if (env.accountDataRequired === true &&
          (env.accountMode !== true || typeof env.accountDataWebSocketImpl !== 'function'))
        throw new Error('账号数据连接缺少可信实例证明');
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
      // 托管档:凭证按对话给(对话委托绑死一个对话,契约第 4.2 节),所以连同这个对话号对应的对话 id 一起交给宿主
      if (mode === "hosted") {
        const conversationId = side.describe().conversations.find((c) => c.conversation === n)?.key ?? '';
        // 没有对话 id 的那一个('')是实例自己的连接(副本的订阅、在场状态);宿主决定它用谁的凭证,以及被拒时哪一轮收尾
        return env.protocolsFor(n, conversationId);
      }
      if (mode === "local") return ["promptcut.v1", `promptcut.role.agent.${n}`];
      if (mode === "lan-host") return ["promptcut.v1", `promptcut.tenant.${projectId}`, `promptcut.role.agent.${n}`];
      return ["promptcut.v1", `promptcut.ticket.${await requestTicket(projectId, n)}`];
    };
    // 分派(side: agent / page / server)与事件都在 server/agent/agent-side.mjs 里,测试用同一份
    const side = createAgentSide({
      projectId,
      url,
      protocolsFor,
      ...(env.accountMode === true && env.accountDataWebSocketImpl ? { WebSocketImpl: env.accountDataWebSocketImpl } : {}),
      // 托管档:几个只读项目与注册表的页面工具改在服务端副本上执行;在服务端另有实现的(导入素材、建卡改卡、配音)
      // 标成经「页面」执行——托管档的「页面」就是下面的 hostedCallPage,由它交给 hosted-tools.mjs
      // 这个进程里建出了提供者的工具(账号模式,`account-tools.mjs`)一律交给它(走「经页面执行」那条分派,见 hostedCallPage);
      // `see_frames` 保持 `side: "agent"`,时间轴看画面照旧在副本上执行,素材拼图(`source: "media"`)在执行器回 undefined 后落到 hostedCallPage
      tools,
      toolGroups,
      // 托管档没有编辑器进程:工具实现里漏网的 /api/* 调用指到一个解析不了的地址,立刻失败,不会打到同机别的服务
      loadHost: () => loadSsrHost((id) => server.ssrLoadModule(id), { apiBase: HOSTED ? "http://agent-service.invalid" : `http://127.0.0.1:${editorPortOf()}` }),
      prerenderPost,
      // 托管档没有「服务端记着的页面播放头」:播放头只来自发消息时的快照,按对话找(下面的 hostedCallPage)
      playhead: () => (HOSTED ? 0 : (latestPlayhead()?.t ?? 0)),
      ...(HOSTED ? {
        onWrite: (agent, write) => { try { env.onWrite?.(agent, write); } catch { /* 宿主的事 */ } },
        // 文档服务以 4003 / 4004 关掉数据连接就是撤销(契约第 4.5 节):不重连,报给宿主立刻停这一轮、记原因
        linkOptions: { onFinalClose: (_n, info) => { try { env.onFinalClose?.(info); } catch { /* 宿主的事 */ } } },
      } : {}),
      // 托管档:服务端 store 是进程里的单例,所有实例共用一把锁、进锁清场(契约第 3.3 节)

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
    // 公告板的改动记录由这条连接的提交流喂;发给各对话连接的 project.overwritten 记给被覆盖的那个 Agent(A3)
    const detachLink = attachLink(side.link, () => boards.boardFor(projectId));
    /*
     * 跨设备(A3 第二阶段):经文档服务的在场状态收别的成员正在编辑的片段(进 A2 看板)、别的成员那边 Agent 的范围与消息
     * (进公告板),发本机 Agent 的范围与发给他们的消息。旧版文档服务不认识这些消息就停发,不报错。
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
    try { b.detachBoard?.(); } catch { /* 已经解了 */ }
    try { b.side.close(); } catch { /* 已经关了 */ }
    agentLog("agent.unbind", { projectId: b.projectId, reason });
  }
  server.httpServer?.once("close", () => unbindAgent("server-close"));

  /** 审查环路走 CLI 时的只读锁:null = 不锁;Set = 只放行这些工具(空 Set = 全拦)。见下面 callToolInternal */
  let loopToolLock = null;

  /*
   * Agent 会话登记表(server/agent/agent-sessions.mjs):对话 ID → 类型、厂商、角色、创造力等级的覆盖值。
   * /api/ai/chat 每次发消息登记一次;桌面 APP 的会话每次调用在 /api/mcp/call 登记(类型 desktop,跟项目)。
   */
  const agentSessions = createAgentSessions();
  /*
   * 桌面 APP 会话在 AI 栏里的分组(A4,server/agent/desktop-activity.mjs):厂商、正在进行的操作、交上来的进度报告。
   * 变了就把整份快照经 SSE(agent.desktop)推给页面,节流 100 毫秒。
   */
  let desktopPushTimer = null;
  const pushDesktop = () => {
    if (desktopPushTimer) return;
    desktopPushTimer = setTimeout(() => {
      desktopPushTimer = null;
      if (!editorRes) return;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.desktop', sessions: desktopActivity.snapshot() })}\n\n`); } catch { /* 页面走了 */ }
    }, 100);
  };
  const desktopActivity = createDesktopActivity({ onChange: pushDesktop });
  /** /api/mcp/call 的 caller 字段:只认 mcp-server.mjs 报的桌面会话身份,形状不对就当没带 */
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
   * SKILL 悬浮窗下面的「上一步做成的动作」预览(desktop/src-tauri/src/skill_shell.rs 盯 skillRoot/last-action.*):
   * 桌面会话做成一次操作、SKILL 模式开着时,让页面渲一张那一刻的画面交回来(页面只对时间轴操作照做,失败静默)。
   * 原来这件事由无头实例的页面做,无头实例归档之后由用户这份页面做。
   */
  const requestSkillPreview = (tool, args, result) => {
    if (!editorRes || (result && typeof result === 'object' && result.ok === false)) return;
    void import(new URL('../skill-gate.mjs', import.meta.url).href).then((gate) => {
      if (!gate.readState().active || !editorRes) return;
      const clipId = typeof args?.clipId === 'string' ? args.clipId : typeof result?.clip?.id === 'string' ? result.clip.id : null;
      const start = typeof args?.start === 'number' ? args.start : null;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'skill.preview', tool, clipId, start })}\n\n`); } catch { /* 页面走了 */ }
    }).catch(() => {});
  };
  /** 页面发消息时顺手报上来的项目默认等级:服务端读不到项目(没绑副本、没有镜像)时用它 */
  let projectCreativityHint = null;
  /**
   * 项目当前的默认等级。按新鲜程度:绑了项目副本就读副本(文档服务的最新版本),
   * 否则读页面推来的镜像,再没有用页面发消息时报的那个,都没有按出厂的「高」。
   */
  function currentProjectCreativity() {
    const replica = (agentBinding)?.side?.link?.replica?.project;
    if (replica && typeof replica === 'object') return projectCreativity(replica);
    const mirrored = latestMirror()?.project;
    if (mirrored && typeof mirrored === 'object') return projectCreativity(mirrored);
    return normalizeCreativity(projectCreativityHint) ?? projectCreativity(null);
  }
  /** create_card 的等级按「这张用户卡在不在」判(整篇重写已有的 = 中,新建 = 高);按生效的那一份判,改动层优先 */
  function userCardExists(id) {
    // 托管档:用户卡在这个项目的内容库里(总入口在判等级之前已经把它列过一遍)
    return effectiveIsFile(server.config.root, path.join(server.config.root, 'src', 'cards', 'user', `${id}.tsx`));
  }

  /*
   * ---------------- 多 Agent(计划 agent-workflow-plan.md A3) ----------------
   *
   * 公告板(server/agent/agent-board.mjs)按项目一份,在这个进程里:declare_scope / list_agents / send_message /
   * check_messages 在这里答(side: "server"),所有 Agent 看到同一份。改动记录由文档服务的提交流喂(绑了项目副本时,
   * attachLink),没绑时由页面执行器算好范围随结果带回来、在下面 dispatchTool 里记。
   * spawn_agent(server/agent/multi-agent.mjs)经 SSE 让页面开新页签(agent.spawn),页面 POST /api/agent/spawned 回话。
   * 页签上的范围名、未读标记经同一条 SSE 推给页面(agent.board);页面空闲时 POST /api/agent/inbox 取走消息发出。
   */
  /** 当前项目:绑了副本用副本的项目 id,否则用镜像里的项目 id,都没有是 ''(本机那一份) */
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
      try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.board', agents: board().snapshot() })}\n\n`); } catch { /* 页面走了 */ }
    }, 50);
  };
  const boards = createAgentBoards(() => ({
    labelOf: agentLabelOf,
    // 收件方在共享项目别的成员那边:经文档服务转过去(A3 第二阶段;没绑项目副本、旧版文档服务时转不出去)
    forwardRemote: (msg) => presenceBridge?.forward(msg) ?? false,
    infoOf: (key) => {
      const e = agentSessions.get(key);
      return { role: e.role, roleName: e.role && e.role !== 'main' ? loadRole(e.role)?.name ?? null : null, parent: e.parent };
    },
  }));
  const boardKeys = new Set        ();
  /** 当前项目的公告板;第一次用到时订阅(变了就推给页面)并补上页面最近报的页签 */
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
  /** 让页面开一个子 Agent 的页签,等它回话(8 秒) */
  function openAgentTab(spec) {
    return new Promise((resolve, reject) => {
      if (!editorRes) return reject(new Error('编辑台没有打开,没有页签可开'));
      const reqId = `s${++spawnSeq}`;
      const timer = setTimeout(() => {
        spawnWaiters.delete(reqId);
        reject(new Error('页面 8 秒内没有开出页签'));
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
    // 会动用户界面的工具改了名(`user_interface_` 前缀,server/tools/ui-names.mjs):老对话的历史里还是旧名,模型照着调旧名时照常执行。
    // 从这里往下(工具表、开放清单、闸门、事件)一律用新名;发给页面时再换回旧的内部操作名
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

  /** 工具调用总入口的后半:各道闸与执行(桌面档直接到这里;托管档先过上面的开放清单) */
  async function callToolChecked(tool, toolDef, args, agent, callId) {

    /*
     * 审查环路走 CLI 时的只读锁(runners/cli-loop.mjs 通过 setToolAccess 设置)。
     *
     * CLI 的 MCP 是全局登记的,没法按回合少给工具,所以只能在执行入口拦:reviewer / judger
     * 回合只放行只读名单,反省回合一个都不放行。锁是这个服务端全局的 —— 锁住的那几分钟里
     * 别的对话页发来的写操作也会被拦,这是有意的:reviewer 正在看的工程不该被同时改。
     */
    if (loopToolLock && !loopToolLock.has(tool)) {
      return {
        ok: false,
        error: loopToolLock.size
          ? `审查环路的这一回合是只读的:${tool} 这一回合不能用。能用的只有 ${[...loopToolLock].join('、')}。`
          : `审查环路的这一回合不调用任何工具,${tool} 被拒绝。只用文字回答。`,
      };
    }

    /*
     * SKILL 模式的闸门(server/skill-gate.mjs),按调用方类型拦(A4):登记过的桌面 APP 会话在 SKILL 模式关着时
     * 什么都不做,AI 栏的 Agent 不受它管。**拦在执行之前** —— 用户切回传统式就是收回了桌面 APP 的手,
     * 那边的会话可能正跑在半路并不知情;执行完再回滚是收拾不干净的。没登记过、也没报身份的调用按 unknown,不拦。
     */
    if (!HOSTED) { // 云节点上没有桌面 APP 的会话,也没有 SKILL 模式
      const callerEntry = agentSessions.get(agent);
      const gate = await import(new URL('../skill-gate.mjs', import.meta.url).href);
      const verdict = gate.checkGate(tool, callerEntry.registeredAt ? callerEntry.type : 'unknown');
      if (!verdict.ok) return { ok: false, skillClosed: true, error: verdict.message, message: verdict.message };
    }

    /*
     * 堵口子(计划 agent-workflow-plan.md A1):set_project_meta 带了 schema 没声明的字段就整次拒绝。
     * 实现那一层(src/mcp/handlers/project.ts)也拦,这里是两条入口共同的一道。
     */
    const strict = await import(new URL('./strict-args.mjs', import.meta.url).href);
    const unknownArgs = strict.undeclaredArgs(tool, toolDef, args);
    if (unknownArgs.length) return { ok: false, error: strict.undeclaredArgsError(tool, toolDef, unknownArgs) };

    /*
     * 创造力等级的闸门(server/agent/creativity-gate.mjs,对照表在那里)。这个对话生效的等级:
     * AI 栏的对话取它自己的覆盖值,没有就跟项目;桌面 APP 会话(没登记过的对话 ID)跟项目。拦在执行之前。
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
     * 绑了项目副本(C6.5):交给 server/agent/agent-side.mjs —— 每个工具调用前后各发一条事件(D2,带 callId),
     * side: "agent" 在副本上执行(D1 / D4),"page" 经页面,"server" 就地(runServerTool)。
     * 没绑:和以前一样,不发事件。
     */
    /*
     * 多 Agent(A3):包一层 —— 调用期间公告板知道「谁在跑什么工具」,调用完把要告诉它的(别的 Agent 给它的消息、
     * 别人动了它声明的范围、它写的被覆盖了、它写进了别人声明的范围)放进结果,notice 在最前。
     */
    return multiAgent.wrap(agent || '', tool, async () => {
      const binding = agentBinding;
      if (binding) return binding.side.callTool(tool, args, { agent: agent || '', callId });
      // 没绑副本:写经页面执行,写到哪些片段这里不知道,按参数点名的片段提示(绑了的在 agent-side 里按实际写到的算)
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
     * 读 / 渲染类工具有镜像时就地执行,直接问预渲染进程,不经过编辑器页面(见上面 runMirroredTool)。
     * 返回 undefined 的(没有镜像、素材拼图这类)照旧走桥。
     */
    const mirrored = await runMirroredTool(tool, args, toolDef);
    if (mirrored !== undefined) return mirrored;
    if (toolDef.side === 'server') return runServerTool(tool, args, agent);
    const out = await callEditorPage(tool, args, agent, toolDef.timeoutMs || 60000);
    // 没接文档服务时公告板的改动记录由这里记:页面执行器算好这次改了哪几条「剪辑->序列」随回包带回来(A3)
    if (Array.isArray(out?.scopes) && out.scopes.length && !agentBinding) board().noteChange(agent || '', tool, out.scopes);
    if (out.ok) return out.result || out;
    throw new Error(out.error);
  }

  /** side: "server" 的工具(不碰项目、不过浏览器桥) */
  async function runServerTool(tool, args, agent) {
    // 多 Agent 的五个工具(A3):公告板与拉起子 Agent,在这个进程里答
    if (multiAgent.isTool(tool)) return multiAgent.handle(tool, args, agent || '');

    /*
     * side: "server" 的工具就地执行,不过浏览器桥。
     *
     * 目前只有 wait。它纯粹是「睡一会儿」,没有任何理由绕编辑台走一趟 ——
     * 而且这样一来,即使桥这一刻忙着,轮询之间的等待也不会失败。
     * 上面那道 SKILL 闸门仍然管得着它(用户收回控制权时连等待都不该继续)。
     */
    {
      if (tool === 'wait') {
        // 只认真正的数字:Number(null) 是 0、Number('') 也是 0,靠 isFinite 判会把
        // 「没填」当成「填了 0」再夹到 1 秒 —— 那不是用户的意思,默认该是 3 秒
        const raw = (args)?.seconds;
        const secs = typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(30, Math.max(1, raw))
          : 3;
        await new Promise((r) => setTimeout(r, secs * 1000));
        return { ok: true, waited: secs };
      }
      if (tool === 'report_progress') {
        // 进度报告只做校验和规范化,界面直接读 tool_call 事件里的 input。
        const { validateProgressReport } = await import(new URL('../progress-report.mjs', import.meta.url).href);
        const checked = validateProgressReport(args);
        if (!checked.ok) {
          return { ok: false, error: checked.error };
        }
        return { ok: true, message: '已记录进度报告', report: checked.value };
      }
      return { ok: false, error: `服务端工具 ${tool} 没有实现` };
    }
  }

  /**
   * 经编辑器页面执行一个工具(SSE 发 call,页面 POST /api/mcp/result 回来)。回页面的原始回包
   * { ok, result, error, opIds? };超时回 ok:false。`__page_state`(server/agent/agent-side.mjs 的
   * PAGE_STATE_TOOL)也走这条:向页面要一次只读的页面状态。
   */
  async function callEditorPage(tool, args, agent, limit) {
    if (!editorRes) {
      // 桌面 APP 的会话最常碰到这一条(SKILL 模式默认关着编辑界面;后台运行是计划 A5):说清是什么、该怎么办
      throw new Error(`编辑台没有打开:没有页面连着 /api/mcp/events。${tool} 要在 PromptCut 的编辑界面里执行,请用户打开编辑界面后再试,不要反复重试。`);
    }

    const id = nextCallId++;
    // 大多数工具是即时的,慢活儿都返回 jobId 让调用方轮询,所以 60 秒够用。
    // 例外是 see_frames:它当场起一个 Chrome 渲一帧,冷启动加素材预热可能过分钟。
    // 让工具自己声明上限,而不是把所有工具一起放宽 —— 真卡住的时候还是该早点报错。(limit 由调用方按工具给)
    // 定时器句柄要留着:工具正常返回之后不清掉的话,每一次调用都在事件循环里留一个
    // 最长几十秒的游离定时器。工具调用是高频的,积起来就是白占的内存和唤醒。
    let timer;
    const p = new Promise     (resolve => {
      pendingCalls.set(id, (result) => { clearTimeout(timer); resolve(result); });
      timer = setTimeout(() => {
        if (pendingCalls.has(id)) {
          pendingCalls.delete(id);
          resolve({ ok: false, error: `${tool} 超过 ${Math.round(limit / 1000)} 秒没有返回,已放弃等待。` });
        }
      }, limit);
    });

    editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool: pageToolName(tool), args, agent: agent || undefined })}\n\n`);

    // 留在页面的工具写了项目时,页面回包带它这次提交的 opIds(c65-integ2 接线);agent-side 据此推进对话读到的版本
    return await p;
  }

  server.middlewares.use('/api/ai/chat', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    // 32MB:附件带的是地址和文本(ChatAttachment 没有内联二进制),整段字幕、整篇文档都够;
    // 再大就不是正常输入了,而是有人在往这条路上灌东西。
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, '请求体超过 32MB'); });
    req.on('end', async () => {
      if (over) return;
      let hasDone = false;
      // 公告板上这一轮开始了(A3):无论怎么结束都要记一次结束,否则这个对话一直算「忙」
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
              type: 'error', message: 'Codex 登录状态待确认，请重新登录。', retryable: false,
              authProvider: 'codex', authReason: 'state_unknown', authGeneration: auth.revision,
            };
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.end(`data: ${JSON.stringify(event)}\n\n`);
            return;
          }
        }
        // 多 Agent 分页:这一页的对话 ID。只认会话 id 的字符集,别的一律当没带
        const agentId = typeof data.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : '';
        runAgentId = agentId;

        let systemPrompt = '';
        try {
          systemPrompt = fs.readFileSync(new URL('../ai-system-prompt.md', import.meta.url), 'utf-8');
        } catch {
          systemPrompt = 'System prompt missing.';
        }

        // 剧本每一轮都拼进系统提示词,而不是只在第一条用户消息里说一次:
        // 多轮执行最容易顺着中间结果越走越偏,摆在系统提示里才拉得住。
        if (typeof script === 'string' && script.trim()) {
          systemPrompt += `\n\n## 本片剧本(用户写的,每一步都要照它来)\n\n${script.trim()}\n\n` +
            '这是这条片子的主线。做任何编排、配字幕、配动效的决定时都要对照它;' +
            '和它冲突的做法不要做,拿不准就按剧本写的来。剧本没写到的细节可以自己判断。';
        }

        let finalPrompt = prompt;
        // 素材库那几条单列:给 mediaId 和卡片能直接用的 cardUrl,**不给磁盘路径** ——
        // 以前每轮都把每个素材的磁盘路径塞进来,模型没有能读它的工具,却一再被引着去读(见 src/ai/mediaRef.ts)
        const library = (attachments || []).filter((a) => a.library);
        const userFiles = (attachments || []).filter((a) => !a.library);
        if (library.length > 0) {
          const kindName = { video: '视频', image: '图片', audio: '音频' };
          finalPrompt += '\n\n素材库(已导入,工具里用 mediaId;卡片参数里引用填 cardUrl):\n' + library.map((a) => {
            let line = `- [${kindName[a.kind] || a.kind}] ${a.name} · mediaId ${a.id} · cardUrl ${a.url}`;
            if (a.durationSec && a.kind !== 'image') line += ` · 时长 ${a.durationSec} 秒`;
            return line;
          }).join('\n');
        }
        // 附件也**不给磁盘路径**(和上面素材库那几条同一个理由):Agent 经接口读写字节,不读任何存储目录
        // (docs/semantics/product/agent.md「素材与产物」),磁盘路径它读不了,只会被引着去读。
        // 要剪辑、转写、配动效,先用 import_media 把「站内地址」装进素材库(import_media 的工具说明写着这条路)。
        if (userFiles.length > 0) {
          finalPrompt += '\n\n附件(在对话的工作目录里,不在素材库;要剪辑、转写或配动效,先用 import_media 传它的站内地址装进素材库):\n' + userFiles.map((a) => {
            let line = `- [${a.kind === 'video' ? '视频' : a.kind}] ${a.name} · 站内地址 ${a.url}`;
            if (a.durationSec) line += ` · 时长 ${a.durationSec} 秒`;
            if (a.text) line += `\n\`\`\`\n${a.text}\n\`\`\``;
            return line;
          }).join('\n');
        }

        /*
         * 登记这个对话(server/agent/agent-sessions.mjs):类型、厂商、角色、创造力等级的覆盖值。
         * creativity 是这个页签单独设的等级,null / 不带 = 跟项目;projectCreativity 是页面这一刻的项目默认,
         * 服务端读不到项目时才用。每条消息都登记:用户可能在两条消息之间换了驱动或等级。
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
         * 多 Agent(A3):
         *   - spawn_agent 拉起的子 Agent:每一轮系统提示词都拼上它的角色提示词(多轮跑下来最容易忘了自己是谁);
         *   - 别的 Agent 的动态(改了什么范围、信箱里到顶没自动投递的消息)拼在这一轮提示词前面,只进模型;
         *   - hops:这条是第几层自动投递(页面投递别的 Agent 的消息时带上),公告板据此给连锁封顶。
         */
        const sess = agentSessions.get(agentId);
        if (agentId && sess.parent && sess.role) {
          const role = loadRole(sess.role);
          if (role) {
            systemPrompt += `\n\n## 你的角色:${role.name}\n\n你是 Agent ${sess.parent} 用 spawn_agent 拉起的子 Agent,对话 ID ${agentId}。` +
              '只做它交给你的那部分;开工先 declare_scope,做完用 report_progress 交代,再用 send_message 把结果告诉拉起你的 Agent。' +
              `你不能再拉起别的 Agent。\n\n${role.prompt}`;
          }
        }
        const agentNotes = agentId ? board().consumeNotes(agentId) : '';
        if (agentNotes) finalPrompt = `${agentNotes}\n\n${finalPrompt}`;
        const runHops = Number.isSafeInteger(data.hops) && data.hops > 0 ? data.hops : 0;

        const editorPort = (server.httpServer?.address())?.port || 5195;
        const editorState = editorRes ? "编辑台已连接" : "未连接";
        finalPrompt += `\n\n当前端口 ${editorPort};${editorState}` + (agentId ? `;你的 Agent 对话 ID:${agentId}` : '') +
          `;创造力等级「${CREATIVITY_LABEL[convCreativity                                 ]}」(${convCreativitySource}):` +
          `${CREATIVITY_HINT[convCreativity                                ]}。越级的工具调用会被拒绝,被拒就停下告诉用户,不要绕`;

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
          // PROMPTCUT_CALLER=cli:这份 MCP 是 AI 栏起的,不是桌面 APP 的会话(mcp-server.mjs 据此不报桌面身份)
          env: { PROMPTCUT_CALLER: 'cli', PROMPTCUT_PORT: String(editorPort), ...(agentId ? { PROMPTCUT_AGENT: agentId } : {}) }
        };

        const cwd = path.join(server.config.root, 'exports', 'ai-workspace');
        fs.mkdirSync(cwd, { recursive: true });

        const runId = Math.random().toString(36).substring(2, 9);
        res.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);

        const { publicConfig } = await import(new URL('../ai-config.mjs', import.meta.url).href);
        const cfg = publicConfig();

        // 额度熔断:先看这一路的用量,超线就不起 CLI 了,直接把原因告诉用户
        const { guard: quotaGuard, mod: quotaMod } = await getQuotaGuard();
        try {
          // 把模型一起递进去:claude 的 /usage 里「本周(Fable)」那种窗口是模型专属的,
          // 不跑那个模型就不该拿它来拦(见 quota.mjs 的 decidingWindows)
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
         * D2:文字回复整条完成时推一条事件(绑了项目副本时)。回复在工具调用之间成段,
         * 遇到下一次工具调用或这一轮结束就把攒着的那一段发出去。
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
          // 代码块空间按项目放在工作目录下(server/tools/code-cache.mjs,A07 2026-10-22);没绑项目时是 local 那一份
          codeCacheDir: path.join(cwd, 'code-cache', String(currentProjectKey() || 'local').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_') || 'local'),
          codeCacheWriter: agentId || sessionId,
          // 按实测速度设单次输出上限的速度记录:本机放在 ai.json 同目录(runners/api.mjs 的 localOutputSpeedFile)
          outputSpeedFile: 'local',
          // 用户自己放的技能:ai.json 同目录的 skills/(runners/api.mjs 的 localSkillsDir)
          skillsDir: 'local',
          model,
          /*
           * 深度自主:轮次上限换成设置里的「自主轮次」(ai.json 的 deepAutoRounds,
           * 默认 300,填 0 就是不限),而且不再给模型任何关于轮次的话。
           *
           * 轮数从**服务端配置**取,不听请求体里的数 —— 前端只发一个「开没开」的布尔。
           * 上限是道安全阀,不该由一个请求字段随手顶开。
           */
          maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
          deepAuto: !!deepAuto,
          // 推理强度和加速档:哪家支持哪些由各自的 runner 翻译成标志,
          // 不支持的直接忽略(前端也已经把对应控件灰掉了)
          effort,
          fast,
          /*
           * 深度自主:轮次上限换成设置里的「自主轮次」(ai.json 的 deepAutoRounds,
           * 默认 300,填 0 就是不限),而且不再给模型任何关于轮次的话。
           *
           * 轮数从**服务端配置**取,不听请求体里的数 —— 前端只发一个「开没开」的布尔。
           * 上限是道安全阀,不该由一个请求字段随手顶开。
           */
          maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
          deepAuto: !!deepAuto,
          // 参数兼容模式(工具 schema 按 Gemini 子集清洗):'auto' / 'on' / 'off',API 直连的 runner 才用
          schemaCompat,
          // 审查环路单独开关(只有 API 直连用);不传就跟着深度自主走,见 runners/api.mjs
          reviewLoop: typeof data.reviewLoop === 'boolean' ? data.reviewLoop : undefined,
          // 审查环路走 CLI 时,按回合给工具上只读锁(见 callToolInternal)。null = 解锁
          setToolAccess: (list) => { loopToolLock = list ? new Set(list) : null; },
          toolProtocol: cfg.toolProtocol,
          mcp,
          // codex、agy 在输出流里报到工具调用,/api/mcp/call 按线索认领同一个 callId(见上面 callPairing)
          callPairing,
          // meta.callId:API 直连那条路的 tool_use id(server/harness/tools/index.mjs 传进来),事件带上它,AI 栏按它对上
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
          // 后台重查发现超线时,把原因写给正在看这条对话的人,再掐进程
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
        // 记账:这一轮新增的上下文 = 发出去的提示词 + 收回来的回复。到线就后台重查,超线掐同一路的其他对话
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
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
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

    // 这个位置只有一个(editorRes),后连的把前一个挤掉:用户刷新页面就靠它重新接管
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
    // 公告板的现状(页签上的范围名、未读)先推一份(A3);桌面 APP 会话的分组也推一份(A4)
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
    // 工具结果从页面回来,里面可能整段是画面或大段文本,给得宽一点;宽也是有上限的。
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, '工具结果超过 64MB'); });
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
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, '请求体超过 32MB'); });
    req.on('end', async () => {
      if (over) return;
      try {
        const { tool, args, agent, callId, pair, caller } = JSON.parse(body);
        // callId:Claude Code 经 MCP 的 _meta["claudecode/toolUseId"] 带来(server/mcp-server.mjs 转过来),事件带上它
        let call = typeof callId === 'string' && callId.length <= 128 ? callId : undefined;
        /*
         * codex、agy 不带 callId,只带配对线索 pair: { scope, hint? }(mcp-server.mjs 的 pairingOf)。
         * 只有绑了项目副本时事件才发出去,callId 才有用;没绑就不去等配对。配不上就不带,和以前一样。
         */
        if (!call && agentBinding && pair && typeof pair.scope === 'string' && pair.scope.length <= 160) {
          call = await callPairing.claim(pair.scope, tool, args ?? {}, typeof pair.hint === 'string' && pair.hint.length <= 128 ? pair.hint : undefined);
        }
        /*
         * 桌面 APP 的会话(A4):mcp-server.mjs 报来 caller { type: 'desktop', key, vendor, label, client }。
         * 每次调用登记一次(类型 desktop、跟项目的创造力等级),用它的 key 当对话 ID —— 写入身份(文档服务按对话开连接)、
         * 公告板、「用户正在编辑」与覆盖提示都按它区分,和 AI 栏的 Agent 走同一条路。AI 栏的调用带 agent,不带 caller。
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
   * C6.5 Agent 服务端的项目副本(见上面 bindAgent)。页面(c65-editor)接上文档服务后:
   *   POST /api/agent/bind   { projectId, mode?: "local" | "lan-host" | "ticket", url? } → { ok, projectId, mode, url }
   *   POST /api/agent/unbind {} → { ok }(换项目、断开文档服务时)
   *   POST /api/agent/ticket { reqId, ticket? , error? } → 交回 SSE 里 { type: "agent.ticket" } 要的连接票据
   *   GET  /api/agent/status → 绑没绑、各对话读到的版本、副本版本(诊断)
   */
  const readJsonBody = (req, res, max, onBody) => {
    let body = '';
    let over = false;
    req.on('data', (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, max, `请求体超过 ${max} 字节`); });
    req.on('end', () => {
      if (over) return;
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }); }
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
      if (!w) return sendJson(res, 404, { ok: false, error: '没有在等这张票据' });
      ticketWaiters.delete(data.reqId);
      clearTimeout(w.timer);
      if (typeof data.ticket === 'string' && data.ticket.length > 0 && data.ticket.length <= 2048) w.resolve(data.ticket);
      else w.reject(new Error(typeof data.error === 'string' ? `页面没签出票据:${data.error}` : '页面交回的票据不合法'));
      sendJson(res, 200, { ok: true });
    });
  });
  /*
   * 「用户正在编辑」(A2):
   *   POST /api/agent/editing { session, entities: [{ clipId, kind: "drag" | "text" | "recent", remainingMs? }] } → { ok, count }
   *     编辑页(src/editor/userEditing.ts)推的整份状态,变了就推(节流)、非空时心跳续期;
   *   GET  /api/agent/editing → { ok, entities }(诊断、探针)
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
   * 多 Agent(A3):
   *   POST /api/agent/tabs    { tabs: [{ conversationId, title, busy }] } → { ok }   页面的页签(整份),公告板的名单与并发名额用
   *   POST /api/agent/inbox   { conversationId, onlyAuto? } → { ok, messages }       页面空闲时取走投给这一页的消息,作为一条用户消息发出
   *   POST /api/agent/spawned { reqId, ok, error? } → { ok }                         页面开好(或开不出)spawn_agent 要的页签
   *   GET  /api/agent/board → { ok, agents, list }                                   诊断、探针
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
      if (!key) return sendJson(res, 400, { ok: false, error: 'conversationId 不合法' });
      const b = board();
      b.markSeen(key);
      sendJson(res, 200, { ok: true, messages: b.takeInbox(key, data?.onlyAuto !== false) });
    });
  });
  server.middlewares.use('/api/agent/spawned', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, (data) => {
      const w = typeof data?.reqId === 'string' ? spawnWaiters.get(data.reqId) : undefined;
      if (!w) return sendJson(res, 404, { ok: false, error: '没有在等这个页签' });
      spawnWaiters.delete(data.reqId);
      clearTimeout(w.timer);
      if (data.ok === true) w.resolve();
      else w.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 300) : '页面没开出页签'));
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
   * 桌面 APP 会话的分组(A4):GET /api/agent/desktop → { ok, sessions }(页面刚连上时取一次,之后收 SSE 的 agent.desktop;
   * 探针也读它)。每个会话:id、厂商、正在进行的操作、最近的调用、交上来的进度报告,以及登记表里的类型与生效的创造力等级。
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
       * 还有几轮对话正在跑。装补丁的脚本(desktop/scripts/apply-patch.ps1)靠它决定
       * 要不要拦一下 —— 补丁会把整个 runtime/app 覆盖掉,而覆盖发生在一个正在服务
       * 页面的 dev server 脚下时,agent 那边**不会崩,只会哑**:Node 里的循环照跑、
       * 对模型的请求照发,但页面发出的每一个 HTTP 请求(工具结果回传、看画面、读卡源码)
       * 全部挂住,直到服务重新起来。表现就是一连串莫名其妙的工具超时,查不到原因。
       */
      activeRuns: activeRunCount,
      port
    });
  });

  return {
    /** CLI 额度熔断:`/api/ai/quota`(留在宿主里)与对话用的是同一份 */
    getQuotaGuard,
    bindAgent,
    unbindAgent,
    callTool: callToolInternal,
    /** 这个实例绑着的项目副本与各对话读到的版本(诊断);没绑回 null */
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
