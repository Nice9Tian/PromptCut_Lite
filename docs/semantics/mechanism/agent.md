# Agent：机制

本册写 `../product/agent.md` 背后的具体机制（三级），从属于它，与它冲突时以它为准。

## 工具

- **读**：项目、素材、卡片清单、布局等从项目副本读。
- 只读页面独有状态（当前选中、播放头交互、面板界面）的工具在编辑界面里执行。
- 工具的清单和参数由卡片定义等数据自动生成，加卡片不需要改工具。

## 单次输出上限、截断续写与代码块空间（2026-10-22 用户定方向，见 `../product/agent.md`「工具」；下面的做法与数字都是〔裁：output-cache 2026-10-22，`docs/archive/agent-reports/AGENT-output-cache.md`〕）

只管 API 直连（本机 API 驱动，走 `server/runners/api.mjs` → `server/harness/`）；经 MCP 接入的命令行 Agent 用它们自己的输出上限，不在这里。

- **输出上限**（`server/harness/model-limits.mjs`）：按模型名查表：Claude 当前各型号 128000（Haiku 4.5、Sonnet 4.5、Opus 4.5、Sonnet 4 为 64000，Opus 4 / 4.1 为 32000）；GPT-5 及以后 128000，o 系 100000，gpt-4.1 32768，gpt-4o 16384；Gemini 2.5 及以后 65536，2.0 / 1.5 为 8192；认不出的 16384。配置（本机 `ai.json`）的 `maxTokens` 是上限的上限：发出去的是它和模型上限里小的那个；没写、写 0、或等于旧缺省 4096 时当作没写，用模型上限。
- **字段**：OpenAI 兼容口对 o 系、GPT-5 及以后发 `max_completion_tokens`，其余发 `max_tokens`，两个不同时带；Anthropic 发 `max_tokens`，Gemini 发 `generationConfig.maxOutputTokens`。
- **400 降档**：回 400 且报错说的是输出上限太大，按报错里写的上限（没写就取下一档：128000、100000、65536、64000、32768、32000、16384、8192、4096）重发一次；OpenAI 兼容口报错说字段名不对（`max_tokens` 不支持、要用 `max_completion_tokens`，或反过来）就换字段重发一次。每种至多一次，再不行照常报错。每次重发记一行日志 `[harness.max-output-fallback]`（厂商、模型、动作、前后的数），并作为 `diagnostic` 事件（`stage: 'max-output-fallback'`）进运行日志与诊断报告。
- **截断时保住写了一半的参数**：provider 在停止原因是写到上限（OpenAI 兼容口 `length`、Anthropic `max_tokens`）时，把参数 JSON 解不开的那次工具调用交成 `tool_use_partial`（带收到的参数原文），不执行、不进历史；写完的那几次照常执行。Gemini 的工具调用整块到达，截断时没有半截调用可保。`server/harness/partial-json.mjs` 从半截 JSON 里取出写到一半的那个字符串字段（最后一个、没收引号的；没有就取最长的字符串字段）和已经写完整的其它字段。
- **存进代码块、让模型接着写**（`server/harness/truncation.mjs`）：取出的字段存进新代码块 `cut_<工具名>_<序号>`，在下一条给模型的消息里写明：哪个工具、哪个参数、写到第几行、存在哪个块、结尾三行、其它参数原样是什么、怎么接着写（`code_cache_append` 从断开处接着写，一次几百行以内；写完以 `@code_cache:<块名>` 交给原工具）。半截的调用本身就是 `code_cache_append` / `code_cache_write` 且块名已写完的，写出的那一截直接接进（或写进）那个块。
- **中途被掐断按截断处理**（2026-10-22 用户定）：流已经出过数据（文字、思考、工具调用）之后、正常收尾（OpenAI 兼容口 `finish_reason`、Anthropic `message_stop`、Gemini `finishReason`）之前结束的——流里来了 error 事件、连接被断、流读完却没有收尾标志——三家 provider 都以停止原因 `stream_cut` 收尾（`server/harness/providers/base.mjs` 的 `STREAM_CUT`）：已经收到的文字照常交出，写完的工具调用照常执行，参数没写完（或一个字还没来）的那次交成 `tool_use_partial`；`agent.mjs` 把 `stream_cut` 和写到上限一样处理（存代码块、让模型接着写、次数上限相同）。还没收到任何数据就断的照旧是错误：先走 `retry-fetch.mjs` 的首块预读重试，重试用完由 `server/runners/api.mjs` 报错并标成可续跑（`retryable`，本机自动接着说一次）。
- **按实测速度设单次上限**（`server/harness/output-speed.mjs`）：单次上限 = min(模型上限, 配置上限, 速度 × 250 秒)，速度那一项不低于 4096。本机保存在 `ai.json` 同目录的 `output-speed.json`。
- **次数上限**（`server/harness/agent.mjs`）：每次截断都留下了内容的，一轮里最多接着写 6 次（第 7 次停）；什么也没留下的截断连续 3 次就停；到了这一轮的轮次上限也停。停下时这一轮以错误结束，话里写明已经写出的部分存在哪些代码块。
- **代码块空间**（`server/tools/code-cache.mjs`）：六个工具 `code_cache_write`、`code_cache_append`、`code_cache_read`、`code_cache_replace`、`code_cache_list`、`code_cache_delete`。块名只用字母、数字、`_`、`.`、`-`，1～64 字，不以点开头。一块最多 2 MiB，一个项目最多 64 块、合计 16 MiB。
- **引用**：任何工具的字符串参数**整个**写成 `@code_cache:<块名>` 时，`harness/agent.mjs` 在调用工具之前把它换成那一块的内容（嵌套的对象、数组里也换）；块不存在时这次调用报错、不执行。
- **存在哪**：一个目录一个项目，一块一个文件 `<块名>.txt`，`index.json` 记每块的更新时间和最后写它的对话。本机位于编辑器工作目录 `exports/ai-workspace/code-cache/<项目 id>`（没绑项目时 `local`）。不进项目文档、不经文档服务，不进撤销历史。

## 汇报与对用户说话（2026-10-20 用户定，见 `../product/agent.md`「汇报」）

- Agent 对用户说话用工具 `send_message`，`to` 填 `"user"`、`text` 写一两句话。它和多 Agent 协调的 `send_message`（发给别的 Agent 的对话 ID 或 `all`）是同一个工具。API 直连由 `server/harness/tools/index.mjs` 就地答，不经公告板；经 MCP 的 CLI 驱动由公告板 `server/agent/agent-board.mjs` 直接答「已显示」。
- harness 的执行规则在有 `send_message` 时让模型每组操作前后用它说一两句，和这一组的工具调用放在同一次回复里；收尾仍交 `final: true` 的 `report_progress`。说过话的一轮，最后一次空回复不算「没有返回」。
- 气泡里显示的话由页面从这一轮的事件里取（`src/ai/userMessages.ts`）：这一轮调过 `send_message`（发给 user、没失败）的，按先后列出它们的 `text`；一次都没调的，用文字回复（相邻的文字并成一句）。两种不混：调过的那一轮，文字回复只在「显示思考」里看得到。
- 操作区（`src/editor/right/chat/ActivityPanel.tsx`）一次显示一轮：缺省跟着最新一轮，点气泡切到那一轮，也能前后翻；内容是这一轮的操作图标、操作详细预览（写了项目的那一步能「撤销这步」）和阶段 / 本轮小结。只取这个对话的消息，不取文档服务项目频道上的工具事件。每一轮的回复各占一个气泡，紧跟在发起它的用户消息后面。

## 命令行登录接标准输入与粘贴授权码（见 `../product/agent.md`「接入」；做法与数字都是〔裁：主会话 2026-10-22，三级，`docs/reports/AGENT-claude-cli-paste-code.md`〕）

- 实现在 `server/runners/setup.mjs`、`server/vite-plugin-ai.ts`、`src/editor/right/AiSetupDialog.tsx`。
- **只有 Claude 的登录任务**把子进程的标准输入接成管道（它的登录命令会问「Paste code here if prompted」），其余登录与安装任务照旧不接。任务以任何方式结束——成功、失败、超时、取消、启动出错、`dispose`——都把标准输入关掉，不留着挂住进程；子进程先退出时写管道的 EPIPE 吞掉，以任务自己的结果为准。
- **形状校验**在写入之前（`normalizeAuthCode`）：字符集 `[A-Za-z0-9._~+/=%#-]`（base64url 字符加 `#`）、长度 16～512、每条任务最多提交 5 次。不合格当场拒绝，出错信息里不带输入的任何内容，免得把任意字符串管道给子进程。
- **送码的口**是 `/api/ai/setup` 的 `POST`，请求体 `{provider, code}`：同源、`application/json`、8 KB 上限，保护照抄同一文件里既有的 `DELETE`。
- **对话框**只在登录任务在跑、且服务端在任务上报了 `acceptsCode` 时，才在「打开登录网页」下面显示那一块（缺省收着）；任务一结束整块消失。
- 码是凭证：不进日志、不进任务字段、不进出错信息。

## 桌面 APP 接入

- 桌面工具经 stdio MCP 服务 `server/mcp-server.mjs` 接入。找实例的优先级为 `--port`、`PROMPTCUT_PORT`、`--port-file` / `PROMPTCUT_PORT_FILE`、公共 `%TEMP%\promptcut\port.json`；每次调用重新找。找不到、进程已退出或端口无人监听时返回说明。
- Claude Code 按 MCP 进程区分会话，Codex 按 `tools/call` 的 `_meta.threadId`（兼容旧字段 `x-codex-turn-metadata.thread_id`）区分；多个 Codex 线程共用一个 MCP 进程时仍分别登记。厂商由 `initialize.clientInfo` 识别，登记类型为 `desktop`，创造力等级跟项目。
- SKILL 做法由 MCP 初始化的短 `instructions` 和桌面会话本地工具 `get_skill_guide` 提供，不写用户级 skill 文件。
- 登记项名为 `promptcut`，写 Claude Code 的 `~/.claude.json` 或 Codex 的 `~/.codex/config.toml`，只写命令与脚本，不写端口。整份配置先备份到 `<skillRoot>/mcp-register/`；撤销只还原该条目，用户改过条目或无法安全识别 TOML 写法时拒绝覆盖。
- 桌面调用在服务端按登记身份经过 SKILL 闸；AI 栏里的 Agent 与未报桌面身份的调用不经过这道闸。AI 栏按桌面会话分组：每个会话保留最近 20 次调用、30 份报告，界面显示最近 5 份报告；最多 16 个会话，2 小时无活动且没有调用在跑的不显示，推送节流 100 毫秒，只存内存。SKILL 下草稿的独占锁照常持有；悬浮窗的上一步画面由用户这份页面渲染，只记录时间轴操作。

## 创造力等级的判定

- 工具需要的等级集中在一张对照表（`server/agent/creativity-gate.mjs`），在所有工具调用的总入口、执行之前判：新建卡片、新建效果要「高」；改已有卡片的源码（含整篇重写已有的卡）、改效果的定义（表达式、步骤、参数声明）要「中」；其余（用已有的卡片、效果、部件拼装，改片段参数，只改效果的名字和说明，内置测量）「低」就能用。自定义测量代码（`measure_audio_js`）要「高」。
- 这个对话生效的等级：AI 栏的对话取它自己的覆盖值，没有覆盖就跟项目；桌面 APP 的会话（以及认不出来源的调用）跟项目。项目没写等级按出厂的「高」。越级的调用什么都不做，回当前等级、这个操作要的等级和怎么调，Agent 据此停下说明。
- 等级只由用户在项目设置或 AI 栏里改；`set_project_meta` 只收它声明过的字段，Agent 写不进等级，也不能借它改项目里别的内容。

## 自定义测量

- Agent 写的测量代码只在一个专用的无头 Chrome 里跑：每次一个新的无痕上下文，代码在 Worker 里执行、到点终止；不给 Node 能力，不能联网（内容安全策略、请求拦截、指向无人监听端口的代理、Worker 里换掉联网接口，四道各自独立）。不用预渲染的 Chrome：内存上限是整个浏览器的启动参数，模型写的内存炸弹不能带走正在预渲染的页面。
- 测谁与内置的响度测量相同（片段用到的素材原声、整个素材、时间轴混音），服务端把那段声音解成 32 位浮点 PCM 交给代码，代码返回可 JSON 序列化的汇总。要单声道时各声道取平均；时间轴混音与导出一致是立体声。
- 数字：缺省 16 kHz（8～48 kHz）、最多 2 声道、所有声道合计最多 1200 万个样本；代码缺省 10 秒、最长 30 秒；结果最多 256 KB；V8 老生代 256 MB；空闲 60 秒关掉 Chrome。
- 代码自己的错（语法、抛错、超时、结果不能序列化或太大、内存超限）回给 Agent 改代码重试，不当成工具故障；沙箱崩溃或卡死（测量期间每秒问一次页面，连续 3 次没回话）就整个重开，只丢这一次。

## 用户正在编辑与覆盖提示

- 编辑界面把正在编辑的片段（卡片、字幕条都算所在片段）报给本机服务：拖动中、文字编辑中、选中后 30 秒内动过的算；只选中不动不算，取消选中即作废，撤销、重做与 Agent 让页面做的修改不算动过。推送节流 250 毫秒，非空时每 5 秒续一次，拖动与文字编辑 15 秒没续期就清掉。
- Agent 读到或写到这些片段时（参数点名的、这次提交实际写到的、读整个项目的），工具结果带 `userEditing` 与一句「用户正在编辑……」的提示，只提示不拦。
- 文档服务回的 `overwrote`（10 分钟内覆盖了别人写的实体）进工具结果：写入方是页面的标「用户刚改过」，是别的 Agent 的标「Agent <对话>（<厂商>）刚改过」。
- 被覆盖的一方：文档服务发给它那条连接的覆盖通知按对话记下，在它下一次工具结果里带「你写的 … 被 用户 / Agent <对话>（<厂商>）覆盖了」。

## 多 Agent

- 主 Agent 用 `spawn_agent` 拉起子 Agent：新对话 ID 即新身份，登记厂商、驱动（沿用父对话）、预设角色、父对话；在当前项目的 AI 栏分页清单里开一个带角色名的新页签（页签 id 是「项目ID_AgentID」，清单按项目分开，见 `../workflow/editing.md`），不抢焦点；任务作为第一条消息进它的信箱，页签空闲就发出；角色提示词每一轮拼进它的系统提示词。子 Agent 不能再拉起；同一个主 Agent 开着页签的子 Agent 至多 4 个，关掉页签才腾出名额；没有页签可开（桌面 APP 会话、编辑台没打开）时回错误。子 Agent 的创造力等级取父对话此刻生效的等级，之后也不高于父对话。
- 协调公告板在本机服务里、按项目一份：范围声明、改动记录、信箱。改动记录由文档服务的提交流喂，带写入身份（用户、各 Agent）；没接文档服务时由工具入口记。范围按「剪辑->序列」算。一个 Agent 30 分钟没动静就不算在跑，它的范围不再拿来比。
- 消息：收件页签空闲就作为一条用户消息发出，忙就带在它下一次工具结果里、跑完还没看到的再送；自动连锁至多 3 层，到顶的留到用户下次开口。
- 工具结果里带（提示在最前）：给它的消息、别人动了它声明的范围（每条一次）、它写的被覆盖了、它这次写进了别的在跑 Agent 声明的范围。
