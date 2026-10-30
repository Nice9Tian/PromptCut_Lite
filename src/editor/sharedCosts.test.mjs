/**
 * 页面侧的成本记录转换与转写(`sharedCosts.ts`)。
 * 跑:node --test src/editor/sharedCosts.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { costDeviceString } from "../render/costDevice.mjs";

const S = await import(srcUrl("editor/sharedCosts.ts"));

const ENV = {
  platform: "Windows",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  vendor: "Google Inc. (Intel)",
};
const deviceHere = costDeviceString({ ua: ENV.userAgent, renderer: ENV.renderer, compact: false, offscreenGl: true, mode: "dev" });
const deviceOther = costDeviceString({ ua: "Mozilla/5.0 (Macintosh) Chrome/150.0.0.0", renderer: "Apple M2", compact: false, offscreenGl: true, mode: "dev" });
const deviceSingle = costDeviceString({ ua: ENV.userAgent, renderer: ENV.renderer, compact: true, offscreenGl: false, mode: "build" });
const k1 = (identityKey, stepMs, extra = {}) => ({ identityKey, fps: 30, stepMs, inlineMs: 0, rasterMs: 0, serializeMs: 0, catchUpMs: 0, kind: "stepped", mode: "dev", measuredAt: 1_790_000_000_000, device: deviceHere, ...extra });

test("SC-01 samplesOf / toSharedInput / measuredHere:形状转换与「是不是这台浏览器测的」", () => {
  assert.equal(S.samplesOf({ samples: 24 }), 24);
  assert.equal(S.samplesOf({ device: deviceHere }), 16, "没有 samples 取 device 串里的 stepN");
  assert.equal(S.samplesOf({}), 1);
  assert.deepEqual(S.toSharedInput(k1("abc", 4.25)), { identityKey: "abc", stepMs: 4.25, samples: 16, measuredAt: 1_790_000_000_000, mode: "dev" });
  assert.equal(S.toSharedInput({ identityKey: "abc" }), null);
  assert.equal(S.toSharedInput({ identityKey: "bad/key", stepMs: 1 }), null);
  assert.equal(S.toSharedInput(k1("x", 1, { measuredAt: undefined, mode: "build" }), () => 42).measuredAt, 42);
  assert.equal(S.measuredHere(k1("a", 1), ENV), true);
  assert.equal(S.measuredHere(k1("a", 1, { device: deviceOther }), ENV), false, "别的机器测的不转写");
  assert.equal(S.measuredHere(k1("a", 1, { device: deviceSingle }), ENV), true);
  assert.equal(S.measuredHere(k1("a", 1, { device: "" }), ENV), false);
});

test("SC-06 桌面转写:没连时不写、不报错", async () => {
  let called = 0;
  const relay = new S.SharedCostRelay({
    request: async () => { called++; return {}; }, linkKey: () => null, projectId: () => "p", environment: () => ENV,
    costs: () => [k1("cardA", 1)], identityKeys: () => new Set(["cardA"]),
  });
  assert.equal(await relay.sync(), 0);
  assert.equal(called, 0);
});

test("SC-07 桌面转写:写失败下一拍再试;同时只跑一次", async () => {
  let fail = true;
  let calls = 0;
  const relay = new S.SharedCostRelay({
    request: async (msg) => { calls++; await new Promise((r) => setTimeout(r, 20)); return fail ? { type: "error", reason: "forbidden" } : { type: "cost.stored", added: msg.records.length, updated: 0, ignored: 0 }; },
    linkKey: () => "l", projectId: () => "p", environment: () => ENV, costs: () => [k1("cardA", 1)], identityKeys: () => new Set(["cardA"]),
  });
  const [a, b] = await Promise.all([relay.sync(), relay.sync()]);
  assert.deepEqual([a, b], [0, 0]);
  assert.equal(calls, 1, "同时只跑一次");
  fail = false;
  assert.equal(await relay.sync(), 1, "失败的下一拍再试");
  assert.equal(relay.debug().log.length, 2);
});
