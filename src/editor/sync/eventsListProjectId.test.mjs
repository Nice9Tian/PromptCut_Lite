/**
 * 页面向文档服务补取工具调用记录的 `events.list` 必须带项目号。
 *   node --test src/editor/sync/eventsListProjectId.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

test("EVL-01 syncManager.ts 里每一条 events.list 消息都带 projectId", () => {
  const src = fs.readFileSync(path.join(here, "syncManager.ts"), "utf8");
  const sends = [...src.matchAll(/\{\s*type:\s*["']events\.list["'][^}]*\}/g)].map((m) => m[0]);
  assert.ok(sends.length >= 1, `找到的 events.list 消息太少(${sends.length}),源码改了写法就更新这条测试`);
  for (const s of sends) assert.match(s, /projectId\s*:/, `这条 events.list 没带 projectId:${s}`);
});

test("EVL-02 文档服务的 events.list:不带 projectId 回 bad-message,带了回 events.listing", async () => {
  const { eventsModule } = await import(pathToFileURL(path.join(root, "server/docservice/modules/events.mjs")).href);
  const m = eventsModule({ project: { publishToProject: () => {} } });
  const sent = [];
  const ctx = { send: (connId, msg) => sent.push(msg), now: () => Date.now() };
  m.connect(ctx, "c1", { userId: "u", tenantId: "sp_" + "a".repeat(26) });
  m.handle(ctx, "c1", { type: "events.list" });
  m.handle(ctx, "c1", { type: "events.list", projectId: "sp_" + "a".repeat(26) });
  const [bad, ok] = sent;
  assert.equal(bad?.type, "error");
  assert.equal(ok?.type, "events.listing");
});
