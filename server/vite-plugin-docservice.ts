import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { apiPath, clientAddressOf, isLocalOrigin, remoteTagOf } from "./http-guard.mjs";

/**
 * 桌面版的本机文档服务插件：在同进程挂 `/docservice`（WebSocket）与 `/api/docservice/healthz`。
 *
 * 只服务本机回环（`local` 空间），不承载账号、云端房间或局域网广播。
 */
export function localDocumentDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.PROMPTCUT_DOCSERVICE_DATA || path.join(env.PROMPTCUT_DATA_DIR || path.join(root, "out"), "docservice");
}

export function prepareLocalDocumentDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = localDocumentDir(root, env);
  const legacy = path.join(root, "out", "docservice");
  if (
    !env.PROMPTCUT_DATA_DIR ||
    env.PROMPTCUT_DOCSERVICE_DATA ||
    path.resolve(target) === path.resolve(legacy) ||
    fs.existsSync(target) ||
    !fs.existsSync(legacy)
  ) {
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.migration-${process.pid}-${randomBytes(6).toString("hex")}`;
  fs.cpSync(legacy, staged, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter(source) {
      if (fs.lstatSync(source).isSymbolicLink()) {
        throw new Error("旧文档服务目录含外部符号链接，保留原数据，请显式恢复备份");
      }
      return true;
    },
  });
  try {
    fs.renameSync(staged, target);
  } catch (e) {
    if (!fs.existsSync(target)) throw e;
  }
  return target;
}

function sendJson(res: ServerResponse, status: number, body: object, head = false) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(head ? undefined : JSON.stringify(body));
}

function guardUpgradeSockets(httpServer: NonNullable<ViteDevServer["httpServer"]>) {
  const guarded = new WeakSet<Duplex>();
  const onUpgrade = (_req: IncomingMessage, socket: Duplex) => {
    if (guarded.has(socket)) return;
    guarded.add(socket);
    socket.on("error", () => {});
  };
  httpServer.prependListener("upgrade", onUpgrade);
  httpServer.once("close", () => httpServer.off("upgrade", onUpgrade));
}

export interface DocServicePluginOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function docServicePlugin(options: DocServicePluginOptions = {}): Plugin {
  const env = options.env ?? process.env;
  let root = process.cwd();
  let closing: Promise<void> | null = null;

  return {
    name: "promptcut-docservice",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server: ViteDevServer) {
      const httpServer = server.httpServer;
      if (!httpServer) return;

      guardUpgradeSockets(httpServer);

      const dataDir = options.dataDir ?? prepareLocalDocumentDir(root, env);

      const isLoopback = (req: IncomingMessage) => {
        const address = clientAddressOf(req);
        return address !== null && isLocalOrigin(req, address);
      };

      type Built = Awaited<ReturnType<typeof import("./docservice/shared-service.mjs")["createSharedDocService"]>>;
      let ready: Promise<Built> | null = null;
      const ensure = () => {
        if (!ready) {
          ready = import("./docservice/shared-service.mjs").then(({ createSharedDocService }) =>
            createSharedDocService({
              dataDir,
              server: httpServer,
              path: "/docservice",
              isLoopback,
              remoteOf: (req: IncomingMessage) => remoteTagOf(req, clientAddressOf(req)),
            }),
          );
        }
        return ready;
      };

      void ensure().catch(() => {});

      const closeAll = () => {
        if (closing) return closing;
        closing = Promise.resolve(ready)
          .then((b) => b?.service.close())
          .catch(() => {});
        return closing;
      };
      httpServer.once("close", () => {
        void closeAll();
      });

      server.middlewares.use(async (req, res, next) => {
        const p = apiPath(req.url);
        const method = String(req.method || "GET").toUpperCase();
        if (p === "/api/docservice/device") {
          if (method !== "GET") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET");
            res.end();
            return;
          }
          sendJson(res, 200, { ok: true, deviceId: "local", deviceName: "Local", lanHost: false, lanHostRequested: false });
          return;
        }
        if (p === "/api/docservice/healthz") {
          if (method !== "GET" && method !== "HEAD") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET, HEAD");
            res.end();
            return;
          }
          try {
            const { service } = await ensure();
            sendJson(res, 200, service.health(), method === "HEAD");
          } catch (err) {
            sendJson(res, 500, { ok: false, error: (err as Error)?.message || "docservice init failed" }, method === "HEAD");
          }
          return;
        }
        next();
      });
    },
  };
}

export { docServicePlugin as docservicePlugin };
export default docServicePlugin;
