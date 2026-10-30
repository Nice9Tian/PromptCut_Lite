import { framesPlugin } from "./server/vite-plugin-frames";
import { mirrorPlugin } from "./server/vite-plugin-mirror";
import { costsPlugin } from "./server/vite-plugin-costs";
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { apiGuardPlugin } from "./server/vite-plugin-api-guard";
import { exportPlugin } from "./server/vite-plugin-export";
import { exportsListPlugin } from "./server/vite-plugin-exports-list";
import vitePluginAi from "./server/vite-plugin-ai";
import { sttPlugin } from "./server/vite-plugin-stt";
import { shotsPlugin } from "./server/vite-plugin-shots";
import { trackPlugin } from "./server/vite-plugin-track";
import { subjectPlugin } from "./server/vite-plugin-subject";
import { mediaPlugin } from "./server/vite-plugin-media";
import { chatsPlugin } from "./server/vite-plugin-chats";
import vitePluginCards from "./server/vite-plugin-cards";
import { projectsPlugin } from "./server/vite-plugin-projects";
import { visionPlugin } from "./server/vite-plugin-vision";
import { skillPlugin } from "./server/vite-plugin-skill";
import { skillStatePlugin } from "./server/vite-plugin-skill-state";
import { collectPlugin } from "./server/vite-plugin-collect";
import { webPlugin } from "./server/vite-plugin-web";
import { prerenderPlugin } from "./server/vite-plugin-prerender";
import { voicePlugin } from "./server/vite-plugin-voice";
import { audioPlugin } from "./server/vite-plugin-audio";
import { stagePortsPlugin } from "./server/vite-plugin-stage-ports";
import { docservicePlugin } from "./server/vite-plugin-docservice";
import { rawEolPlugin } from "./server/raw-eol.mjs";
import { watchIgnored, DEP_SCAN_ENTRIES } from "./server/vite-scan-ignore.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根:本文件所在目录。监听忽略按相对它的路径判断(`server/vite-scan-ignore.mjs`)。 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * vite 的静态中间件会把**项目根下的任意文件**按路径发出去 —— 实测
 * `GET /out/cookies/bilibili.txt` 是 200,内容原样。开发期 dataDir 就是 `<root>/out`,
 * 于是素材收集存下的站点登录态(SESSDATA / bili_jct,等于账号)成了一条 HTTP 可取的地址。
 * 同源策略只挡「别的网页读」,挡不住 agent 自己那个浏览器:它会去任意外站,
 * 页面上写一句「打开 http://127.0.0.1:5210/out/cookies/bilibili.txt」就能把 cookie
 * 读进模型上下文。所以在文件系统这一层直接拒掉。
 *
 * 前四条是 vite 的默认值:`deny` 是**整体替换**不是追加,不带上就等于把默认防护删了。
 * (正式包里 PROMPTCUT_DATA_DIR 指向 %LOCALAPPDATA%,不在根下,本来就取不到;
 *  这一条保的是开发期和「壳连仓库 dev server」那种跑法。)
 *
 * 本地文档服务的日志(`<root>/out/docservice`,项目版本日志与内容库,含卡片源码)同理:
 * 只经文档服务的 WebSocket 读写,不经静态服务暴露。
 */
const fsDeny = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/out/cookies/**", "**/out/docservice/**"];

/*
 * 卡片、部件文件不做 Fast Refresh(C6.6 集成 3b)。它们导出的是卡片定义(对象),不是纯组件,
 * Fast Refresh 本来就接不住:插件先把文件当成自接的边界,页面里校验不过再 invalidate,
 * 于是每改一张卡,编辑器页面和两个舞台各自再触发一轮热更新(实测晚到 3 s),正好打断在跑的重测。
 * 排除之后热更新直接沿导入链走到 `src/cards/index.ts`(它自己接住、重装整套卡片),一次就完。
 */
const REACT_REFRESH_EXCLUDE = [/\/node_modules\//, /\/src\/cards\//, /\/src\/parts\//];

const desktopConfig: UserConfig = {
  ...(process.env.PROMPTCUT_VITE_CACHE_DIR ? { cacheDir: `${process.env.PROMPTCUT_VITE_CACHE_DIR}/editor` } : {}),
  // 卡口必须排在所有接口插件**前面**:中间件按 configureServer 的调用顺序注册,排在后面就等于没有。
  //   apiGuardPlugin  —— /api/** 的同源校验,任何 dev server 都生效。
  // stagePortsPlugin 排在 apiGuard 后面:它自己那条 /api/stage/ports 也该受同一道卡口管。
  // docservicePlugin(本地文档服务)总是注册。
  plugins: [apiGuardPlugin(), stagePortsPlugin(), react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss(), exportPlugin(), exportsListPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), rawEolPlugin(), projectsPlugin(), visionPlugin(), skillPlugin(), skillStatePlugin(), collectPlugin(), webPlugin(), prerenderPlugin(), voicePlugin(), audioPlugin(), docservicePlugin()],
  // 依赖扫描入口只找真正的页面:缺省的 `**/*.html` 会把 out/frame-library 下成千上万个快照 .html 当入口读一遍(`server/vite-scan-ignore.mjs`)
  optimizeDeps: { entries: DEP_SCAN_ENTRIES },
  server: {
        fs: { deny: fsDeny },
        watch: {
          /*
           * 这里每一条都不是源码,而且**漏掉会出人命**:
           *
           * - desktop / out / python:桌面壳的二进制、导出产物、内置 Python。
           *   watch 到正在写的 exe 会 EBUSY 把 dev server 崩掉。
           * - **.lock**:.proc 的独占锁。外壳用共享模式 0 握着它,chokidar 去 fs.watch
           *   立刻拿到 EBUSY,而那是 FSWatcher 的 error 事件 —— **整个 dev server 当场退出**,
           *   连带 sidecar 和编辑器一起没。实测过一次,不是推测。
           * - .pc-projects / .pc-work / .pc-chats:草稿、打开的项目副本、会话历史。都是运行时数据,
           *   改一下就触发一次 HMR 纯属浪费,而且草稿是自动保存的,等于每次保存都重载。
           */
          /*
           * 不用「任意深度 out 目录」这类 glob 字符串:chokidar 拿 picomatch 的缺省选项(dot: false)匹配绝对路径,
           * 根路径里只要有以点开头的一段(worktree 在 `.worktrees/` 下)就一条都不生效。
           * 名单与原因见 `server/vite-scan-ignore.mjs`;另外还挡 `.worktrees/`(在仓库根起服务时别的 worktree 不是源码)。
           */
          ignored: [watchIgnored(ROOT)],
        },
      },
};

export default defineConfig(desktopConfig);
