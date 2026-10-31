# 术语表

本仓库文档统一使用下列术语。「定义在」一列指向给出完整规则的文件，路径相对于 `docs/semantics/`。「级」一列是给出定义的那一本的级别：一 = 用户体验，二 = 产品功能，三 = 具体机制（见 `README.md` 的「语义的三级」）。二级文件里提到三级术语时，承诺以二级文件为准。

## 用词约定

- 说「预渲染」，不说「烘焙」。说「生成快照」，不说「冻结」。代码标识符不受此限。
- **不说「图卡」**（2026-10-09 用户定）。改叫「素材效果卡」。旧契约、旧报告和代码注释里的「图卡」指的都是它。
- **不说「补渲」**（2026-10-09 用户定）。渲染只有「预渲染」和「即时渲染」两种。发出去等节点认领的叫「预渲染任务」；已经开始的预渲染任务没做成、重新做，叫「预渲染重试」。旧契约、旧报告和代码注释里的「补渲」指的都是预渲染任务。

## 产品与工作方式

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 传统式 | 打开编辑界面工作，用户和 AI 栏里的 Agent 一起改 | 一 | `user-workflow.md` |
| SKILL | 桌面 APP 里的 Agent 经 MCP 接入；默认关闭编辑界面，转入后台运行 | 一 | `user-workflow.md` |
| 技能 | Agent 按需读取的一份做事说明（`SKILL.md` 格式）；和工作方式 SKILL 是两回事 | 二 | `product/agent.md` |
| 氛围式 | 不打开编辑界面，对着 Agent 说话把片子做出来：开始页「说一句话」的输入框、聊天页、右侧拓展栏（画面、修改前 / 修改后）、详细编辑。从右侧拓展栏的「画面」可以进详细编辑，**那里的时间轴用户自己可以调**；要整套编辑界面（左栏、特效、字幕等）才切传统式。也是顶栏工作方式开关的第一格（2026-10-23 用户定名；用户同时定下不另起「专业模式」这个名字，打开编辑界面那一种仍叫传统式） | 一 | `user-workflow.md` |
| 后台运行 | 桌面应用关闭编辑界面后转为托盘图标和悬浮窗继续运行 | 一 | `user-workflow.md` |
| AI 栏 | 编辑界面右侧和 Agent 对话、看进度的区域 | 一 | `user-workflow.md` |
| 接入方式 | Agent 的三种接入：CLI、API（在 AI 栏里对话）、桌面 APP（经 SKILL） | 一 | `user-workflow.md` |
| 创造力等级 | 低、中、高三档，决定 Agent 能改到多深；项目有默认值，每个对话可单独改 | 一 | `user-workflow.md` |
| 主 Agent、角色 | 主 Agent 可拉起其它 Agent 并分派任务，拉起时可附加预设的角色 | 一 | `user-workflow.md` |
| 进度汇报 | Agent 交给用户的结构化条目：做了、待办、问题 | 一 | `user-workflow.md` |

## 系统角色

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 编辑界面 | 用户看和操作的地方 | 二 | `architecture.md` |
| 文档服务 | 项目文档的唯一修改入口 | 二 | `architecture.md`、product/document-service.md |
| 素材服务 | 字节的唯一读写入口，按内容哈希寻址 | 二 | `architecture.md`、product/asset-service.md |
| 成片渲染 | 把项目渲染成给人看的画面 | 二 | `architecture.md`、product/rendering.md |
| 即时渲染 | 有人正等着看结果时按需当场渲染指定时刻的画面，结果从渲染所在的位置直接交给请求方，不进文档服务的任务队列，不经过素材服务；目前的请求方是 Agent。与「预渲染」相对；取代旧名「查询渲染」（代码标识符和旧文档里的 query-render、查询渲染指的就是它） | 二 | `architecture.md`、product/rendering.md |
| 会话 | 文档服务与每一方之间的连接单位：消息双向有序、带序号、接收方确认；单次传输中断不结束会话 | 二 | product/document-service.md、mechanism/document-service.md |
| 连接发现 | 文档服务把素材服务的地址下发给各方。文档服务只下发地址，不承担素材传输流量 | 三 | mechanism/document-service.md |
| 渲染任务队列 | 文档服务在内存里托管的预渲染任务清单：只记状态和认领者，不测算、不分配 | 二 | product/document-service.md |
| 渲染节点 | 从渲染任务队列认领并完成预渲染任务的地方 | 二 | product/platforms.md |
| 认领 | 渲染节点从队列里取一个任务：比对状态再加锁一步完成，同一任务同时只有一个认领者；断开或超时后任务回到未认领 | 三 | mechanism/document-service.md |
| 单项目模式 | 渲染服务只为一个项目干活：整个项目装进来一直留着。桌面版的预渲染进程用它。和预渲染进程的 Agent / User / Full 模式不是一回事 | 二 | product/rendering.md |
| 多项目模式 | 渲染服务同时为多个项目干活：每个请求只记项目、版本和帧，排进同一条队列，轮到时只加载这几帧用到的卡和素材，不让哪个项目占着 | 二 | product/rendering.md |
| 环境指纹 | 渲染环境的标识（操作系统、GPU 基础类别、Chrome 主版本），并入预渲染结果的键；不同环境的结果不混用 | 三 | mechanism/rendering.md |
| 卡片级指纹锁 | 一张卡的轨道流只出自一种环境：最先产出的环境锁定这张卡，别的环境只能用自己的指纹另起一套键、从头接手 | 三 | mechanism/rendering.md |
| 桌面应用 | 装在电脑上的那一份本产品，带预渲染进程，在本机运行文档服务和素材服务。文档里也写「桌面版」；口头也说「桌面版编辑器」「桌面编辑器」，指的都是它。写文档用「桌面应用」或「桌面版」 | 二 | product/platforms.md |
| 桌面运行环境 | 带预渲染进程的桌面应用（或本机 dev server）所在的运行环境 | 二 | product/platforms.md |
| 本地内容库 | 素材服务在本机按哈希存字节的存储或缓存，不是绕过素材服务的直读通道 | 三 | mechanism/asset-service.md |
| 素材原尺寸、素材小尺寸 | 同一素材的两档：用户导入的原始文件、编码不变，导出和像素级检查只用它；缩到 800×600 以内、重压成 H.264 的副本，预览用。取代旧词「原片」「小版」 | 二 | product/asset-service.md |
| 预渲染重试 | 已经开始的预渲染任务因为节点故障或长时间没有进展而没做成时，把它重新做一遍。排队等节点不算。它和预渲染一样是后台自动的：系统自己重试，不让用户点「重试」「取消」，也不要用户手动重新发起；重试几次、隔多久由实现定。2026-10-09 用户定名并定规则；不叫「补渲」 | 二 | product/rendering.md |
| 素材采集 | Agent 的一组工具（2026-10-08 用户定名，文档里以前写「网页采集」「采集」的都是它）：按网页链接把视频或素材下载进项目，含站内搜索、探测清晰度、下载。本机 Agent 在用户的电脑上下载，可以用用户扫码登录后留在本机的站点登录态 | 一 | workflow/materials.md |

## 项目数据

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 剪辑 | 项目里的一条独立时间轴；同一时刻只有一条激活；分 2D 剪辑与 3D 剪辑两类 | 二 | product/project-model.md |
| 2D 剪辑 | 画面在平面上合成的剪辑，遮挡按序列；新建的剪辑都是这一类（2026-10-24 用户定） | 二 | product/project-model.md |
| 3D 剪辑 | 画面在空间里合成的剪辑，遮挡按深度（2026-10-24 用户定） | 二 | product/project-model.md |
| 序列 | 时间轴上的一行，不分种类；2D 剪辑里靠上的画在上层，3D 剪辑里只管分组与同深度时的先后 | 二 | product/project-model.md |
| 片段 | 序列上的一段，分卡片段、素材段和剪辑段 | 二 | product/project-model.md |
| 剪辑段 | 放在一条剪辑序列里、引用另一条剪辑的片段 | 二 | product/project-model.md |
| 效果库 | 项目里的滤镜、像素映射、音频效果定义 | 二 | product/project-model.md |
| 滤镜 | 整帧调色 | 二 | product/project-model.md |
| 像素映射 | 需要逐像素判断的选区处理 | 二 | product/project-model.md |
| 转场 | 交叉溶解、淡入、淡出；独立对象，把相关片段绑成一组 | 二 | product/project-model.md |
| 历史序号 | 项目内容被修改过多少次的递增计数（原称「版本号」），和软件版本号（如 0.7.18）、卡片代码版本区分开（2026-10-14 用户定） | 二 | product/document-service.md、mechanism/document-service.md |

## 卡片

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 卡片 | 画面上的特效或动效，本质是一段代码 | 二 | product/cards.md |
| DOM 卡、素材效果卡、组合卡、素材封装卡 | 卡片的四种形态 | 二 | product/cards.md |
| 素材效果卡 | 作用在素材上的效果：画面的滤镜、调色、转场、强调，声音的混音、音效、响度。按时间产出一份图形处理的描述或一段音频采样，由宿主执行。一律用 JS 写，画面部分配显卡着色器。它不算动效卡。2026-10-09 用户定名，原称「图卡」；代码里的 `card()` 与 graph card 指的是它 | 二 | product/cards.md、../plan/render-standard.md |
| remotion 式、motion 式 | 2D 动效卡的两种写法（2026-10-09 用户定）。remotion 式：画面只由时间 t 和参数决定，不依赖前后状态，跳到任意一帧都是直接算；只是这种写法，不使用 Remotion 这个库。motion 式：有状态，要从起点一帧帧推进。对应代码里的 `frameMode: "direct"` 与 `"stateful"`。取代原先对外的三分法（随机访问卡、可定位的推帧卡、只能逐帧推的卡），那三个词只在软件内部的优化里用 | 二 | ../plan/render-standard.md |
| 部件 | 组合卡的零件，有自己的框、参数和进场时机 | 二 | product/cards.md |
| 约定封装 | 一张卡对外唯一的样子，Agent 和代码页看的都是它 | 二 | product/cards.md |
| 随机访问卡 | 〔2026-10-09 起不再作为对外的分类，就是「remotion 式」〕按时间直接算出画面的卡 | 三 | mechanism/cards.md |
| 可定位的推帧卡 | 〔2026-10-09 起不再作为对外的分类，属于「motion 式」，只在软件内部的优化里用〕能把动画时间一步钉到目标帧的有状态卡 | 三 | mechanism/cards.md |
| 只能逐帧推的卡 | 〔2026-10-09 起不再作为对外的分类，属于「motion 式」〕自己累积状态、只能从起点逐帧推进的卡 | 三 | mechanism/cards.md |
| canvas 卡 | 画在 2D canvas 或 WebGL 上的卡 | 三 | mechanism/cards.md |
| 独立卡、源依赖卡、下层依赖卡 | 按依不依赖下层分的三类 | 三 | mechanism/cards.md |
| 审阅表 | 卡片分类的权威记录，优先于卡片源码里的声明 | 三 | mechanism/cards.md |

## 渲染

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 舞台 | 渲染给人看的画面的独立进程页面 | 二 | product/rendering.md |
| 可见舞台、后台舞台 | 两个舞台的角色：一个负责播放，一个负责测量和补跑，可互换 | 三 | mechanism/rendering.md |
| 活渲 | 在舞台里实时渲染卡片 | 二 | product/rendering.md、mechanism/rendering.md |
| 轻卡、重卡 | 某一段里活渲的卡和贴预渲染结果的卡 | 二 | product/rendering.md、mechanism/rendering.md |
| 预算 | 每拍的成本上限：1000 / fps × 70% | 三 | mechanism/rendering.md |
| 测量 | 打开项目或新加卡时实测每张卡的成本 | 二 | product/rendering.md |
| 追帧 | 推帧卡跳转后，从起点推到目标帧 | 三 | mechanism/rendering.md |
| 降级 | 播放中把最贵的轻卡改判为重卡 | 三 | mechanism/rendering.md |
| 预渲染、预渲染结果 | 没人等着看的时候离屏预先渲染重卡，产出轨道流（先产稀疏版，再补成满密度版），推送到素材服务，供播放、暂停、拖动时直接贴上；任务发布到文档服务的任务队列由渲染节点认领，连不上时本机自己做。与「即时渲染」相对 | 二 | product/rendering.md |
| 预渲染集合 | 所有段里重卡的并集，只有它们会被预渲染 | 三 | mechanism/rendering.md |
| 帧库 | 桌面版在本机存预渲染结果的目录，是可重新生成的缓存，有上限、按最近使用淘汰 | 三 | mechanism/platforms.md |
| 成本记录 | 一张卡的活渲单帧耗时，按「卡片身份（不含测量机器）+ 环境指纹」存在文档服务 | 三 | mechanism/document-service.md、mechanism/rendering.md |
| 快照 | 分 HTML 快照与 PNG 快照两类。详见「HTML 快照」与「PNG 快照」 | 二 | mechanism/rendering.md |
| HTML 快照 | 把舞台 DOM 序列化成的一份 HTML 文本。每张卡的 HTML 快照已作废（2026-10-13 用户定）；整场景的 HTML 快照保留（导出、Agent 看画面、基线脚本；浏览器里为取像素临时生成、画成位图就丢，不存、不当产物；2026-10-14 用户定） | 二 | mechanism/rendering.md |
| PNG 快照 | bake_card 为单张卡片渲出的那张 PNG 位图（代码注释、报错与工具说明里的「卡片快照」统一改称「PNG 快照」；2026-10-14 用户定） | 二 | mechanism/rendering.md |
| 生成快照 | 把当前的 DOM 连同样式、画布转成 HTML 快照，或由 bake_card 渲出单张卡的 PNG 快照 | 三 | mechanism/rendering.md |
| 轨道流、组流 | 重卡贴的 alpha 视频流，播放、暂停、拖动都用它。每条流有稀疏版（从这条流自己的第一帧起每 15 帧一张，打开项目测量时先产）和满密度版（每帧都有）。多张相邻重卡合成的一条流叫组流 | 三 | mechanism/rendering.md |
| 实体框 | 卡片实际画出内容的最小矩形 | 二 | product/rendering.md、mechanism/rendering.md |
| 兜底顺序 | 画面来不及时按满帧流 → 稀疏流 → 占位符逐级退化，受算力预算约束 | 二 | product/rendering.md、mechanism/rendering.md |
| 占位符 | 兜底顺序尽头在卡片位置显示的沙漏加噪点，只出现在预览里 | 二 | product/rendering.md |
| 隔离舞台 | 与编辑页面跨源、带内容安全策略与出口白名单的舞台文档；桌面版舞台里的卡片代码不许调本机编辑器进程与预渲染进程的接口，按哈希读素材只放行当前项目（2026-10-14 用户定） | 三 | mechanism/platforms.md |
| 预渲染进程 | 做预渲染和即时渲染的进程，有 Agent、User、Full 三种模式 | 三 | mechanism/rendering.md |

## 开发

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 叠加卡 | 挂在一个片段上的东西的统称：滤镜、像素映射、音频效果、素材效果卡。时间轴上画成片段里的一条**叠加带**，从左到右就是处理顺序 | 一 | `workflow/editing.md` |
| 叠加带 | 片段里画叠加卡的那一格（上半格）。每个片段都留着，没挂东西时透明不画 | 一 | `workflow/editing.md` |
| 基线 | 每次改动都必须通过的验证集合 | — | guide_files/verification.md |
| 发布验收闸门 | 开发者判断版本是否达到交付标准的检查：产品交互验收（合入、发版前在本机隔离环境验功能、交互、画面、安全与隔离等）。验收运行耗时只记录，不作通过条件；功能、画面、长任务数、安全与隔离仍须满足，等待时限仍用于防卡死 | — | guide_files/verification.md、guide_files/git_and_release.md |
| 本机修改状态检查 | 核对当前设备的前台编辑、待提交操作、保存、素材入库/上传、本机 Agent、渲染和后台写入。保存时暂时禁用前台编辑，等待本机写入完成后再保存 | 三 | mechanism/document-service.md |
| 本机说明 | 只和本机有关的环境信息，不入库 | — | guide_files/constraints.md |
