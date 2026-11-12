import { framesPlugin } from "./server/vite-plugin-frames";
import { mirrorPlugin } from "./server/vite-plugin-mirror";
import { costsPlugin } from "./server/vite-plugin-costs";
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { localePlugin } from "./server/vite-plugin-locale";
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

/** Project root: directory containing this file. Watch ignores are relative to it (`server/vite-scan-ignore.mjs`). */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * vite's static middleware serves **any file under the project root** by path: in testing,
 * `GET /out/cookies/bilibili.txt` returns 200 with raw content. In development, dataDir is `<root>/out`,
 * so site login state (SESSDATA / bili_jct, equivalent to account) saved by media collection becomes
 * an HTTP-fetchable address. Same-origin policy only blocks "reads by other web pages", but cannot
 * block the agent's own browser: it visits arbitrary external sites, and writing "open
 * http://127.0.0.1:5210/out/cookies/bilibili.txt" on the page can read cookies into the model context.
 * Therefore, reject directly at the filesystem layer.
 *
 * The first four entries are vite defaults: `deny` is **full replacement**, not append, and omitting
 * them deletes the default protection. (In release packages PROMPTCUT_DATA_DIR points to %LOCALAPPDATA%,
 * outside the root and unreachable anyway; this rule protects development and "shell connects to
 * repository dev server" workflows.)
 *
 * Same for local document service logs (`<root>/out/docservice`, project revision logs and content
 * store, including card source code): read and written only via the document service WebSocket, not
 * exposed via static serving.
 */
const fsDeny = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/out/cookies/**", "**/out/docservice/**"];

/*
 * Card and part files do not use Fast Refresh (C6.6 integration 3b). They export card definitions
 * (objects), not pure components, which Fast Refresh cannot catch to begin with: the plugin first
 * treats files as self-accepting boundaries, then invalidates after page validation fails.
 * As a result, editing a single card triggers another round of hot updates in the editor page and
 * both stages (delayed by 3s in testing), disrupting test reruns in progress.
 * After exclusion, hot updates propagate along the import chain to `src/cards/index.ts` (which
 * catches it and reloads the entire card suite), finishing in a single pass.
 */
const REACT_REFRESH_EXCLUDE = [/\/node_modules\//, /\/src\/cards\//, /\/src\/parts\//];

const desktopConfig: UserConfig = {
  ...(process.env.PROMPTCUT_VITE_CACHE_DIR ? { cacheDir: `${process.env.PROMPTCUT_VITE_CACHE_DIR}/editor` } : {}),
  // Gates must come **before** all API plugins: middleware registers in configureServer call order;
  // placing them after is equivalent to not having them.
  //   apiGuardPlugin: same-origin check for /api/**, active on any dev server.
  // stagePortsPlugin comes after apiGuard: its own /api/stage/ports should be governed by the same gate.
  // docservicePlugin (local document service) is always registered.
  plugins: [localePlugin(), apiGuardPlugin(), stagePortsPlugin(), react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss(), exportPlugin(), exportsListPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), rawEolPlugin(), projectsPlugin(), visionPlugin(), skillPlugin(), skillStatePlugin(), collectPlugin(), webPlugin(), prerenderPlugin(), voicePlugin(), audioPlugin(), docservicePlugin()],
  // Dependency scanning entry points only look for real pages: default `**/*.html` reads thousands
  // of snapshot .html files under out/frame-library as entries (`server/vite-scan-ignore.mjs`)
  optimizeDeps: { entries: DEP_SCAN_ENTRIES },
  server: {
        fs: { deny: fsDeny },
        watch: {
          /*
           * None of these is source code, and **missing any is fatal**:
           *
           * - desktop / out / python: desktop shell binaries, export outputs, built-in Python.
           *   Watching an exe being written triggers EBUSY and crashes the dev server.
           * - **.lock**: exclusive lock for .proc. The shell holds it in sharing mode 0, so chokidar's fs.watch
           *   immediately gets EBUSY, which is an FSWatcher error event:
           *   **the entire dev server exits on the spot**, taking down the sidecar and editor with it.
           *   Verified in testing once, not speculation.
           * - .pc-projects / .pc-work / .pc-chats: drafts, open project replicas, session history. All are
           *   runtime data; triggering HMR on every change is pure waste, and drafts are auto-saved, meaning
           *   every save reloads.
           */
          /*
           * Do not use glob strings like "arbitrary-depth out directory": chokidar matches absolute paths
           * with picomatch default options (dot: false), and if the root path contains a dot-prefixed segment
           * (worktree is under `.worktrees/`), none of the rules take effect.
           * See `server/vite-scan-ignore.mjs` for the list and reasons; it also blocks `.worktrees/` (other
           * worktrees are not source code when starting the server at the repository root).
           */
          ignored: [watchIgnored(ROOT)],
        },
      },
};

export default defineConfig(desktopConfig);
