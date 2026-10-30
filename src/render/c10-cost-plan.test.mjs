/**
 * 界限搜索接进分派:
 * 跑:node --experimental-test-module-mocks --test src/render/c10-cost-plan.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { planPipelines, pipelineAt } from "./pipelinePlan.mjs";

globalThis.window = globalThis;

const FPS = 30;
function project(clips) {
  return { version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 60, themeId: "midnight",
    tracks: [{ id: "tr", name: "tr", clips: clips.map((c) => ({ id: c.id, cardId: `card-${c.id}`, start: c.start, end: c.end, params: {} })) }] };
}

test("CP-01 searchLight:判轻的卡在每个位置都判轻(同时 40 张也不挤出),其余与没有身份的每个位置都判重", () => {
  const clips = Array.from({ length: 40 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, start: 0, end: 5 }));
  clips.push({ id: "noid", start: 1, end: 3 });
  const identityKeys = Object.fromEntries(clips.filter((c) => c.id !== "noid").map((c) => [c.id, `key-${c.id}`]));
  const lightKeys = new Set(clips.filter((_, i) => i % 2 === 0 && i < 40).map((c) => `key-${c.id}`));
  const plan = planPipelines(project(clips), [], FPS, { identityKeys, searchLight: lightKeys });
  for (const c of clips) {
    const isLight = lightKeys.has(identityKeys[c.id]);
    for (let t = c.start; t < c.end; t += 0.5) assert.equal(pipelineAt(plan, c.id, t), isLight ? "light" : "heavy", `${c.id} @ ${t}`);
    assert.equal(plan.prerenderSet.has(c.id), !isLight, c.id);
  }
  assert.ok(plan.prerenderSet.has("noid"), "没有身份的卡判重");
});

test("CP-02 planDispatch:判定表按搜索结果;搜索完成前全部判重、searchJudged=false;最低一档显示表一直全部判重", async () => {
  mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
  mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys: { a: "ka", b: "kb", c: "kc" }, frameModes: { a: "direct", b: "direct", c: "direct" } }) } });
  (await import(srcUrl("kernel/registry.ts"))).registerCards(["a", "b", "c"].map((id) => ({ id: `card-${id}`, name: id, defaults: {}, controls: [], frameMode: "direct", Component: () => null })));
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }, { id: "c", start: 1, end: 3 }]));
  await settle();
  assert.equal(d.searchJudged(), true, "不按界限搜索判时恒为 true");
  assert.equal(d.judgedPlan(), d.currentPlan(), "两样开关都关:两张表是同一张");
  d.setPlanSearch(true);
  await settle();
  assert.equal(d.planSearch(), true);
  assert.equal(d.searchJudged(), false, "搜索还没做完");
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["a", "b", "c"], "没有结果时判定表全部判重");
  d.setPlanSearchLight(["ka", "kc"]);
  assert.equal(d.searchJudged(), true);
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "判定表按搜索结果(同步重算)");
  assert.equal(pipelineAt(d.judgedPlan(), "a", 1), "light");
  await settle();
  assert.equal(d.currentPlan(), d.judgedPlan(), "精简模式:显示用的表就是判定的表(判轻的照常活渲)");
  d.setPlanLowest(true);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], ["a", "b", "c"], "最低一档:显示用的表全部判重");
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "判定的表不变");
  assert.deepEqual([...d.planSearchLight()].sort(), ["ka", "kc"]);
  d.setPlanLowest(false);
  d.setPlanSearch(false);
  await settle();
  assert.equal(d.planSearchLight(), null, "不按界限搜索判了:丢掉结果");
  assert.equal(d.judgedPlan(), d.currentPlan());
  d.resetPlanDispatch();
});

test("CP-05 桌面不受影响:不给新选项时 planPipelines 的结果与原来逐字段相同(同一份输入跑两遍、对照 allHeavy 以外的路径)", () => {
  const clips = [{ id: "a", start: 0, end: 4 }, { id: "b", start: 1, end: 3 }, { id: "c", start: 2, end: 6 }];
  const costs = [
    { identityKey: "ka", fps: FPS, device: "d", stepMs: 3, kind: "random", catchUpMs: 0 },
    { identityKey: "kb", fps: FPS, device: "d", stepMs: 30, kind: "random", catchUpMs: 0 },
  ];
  const opts = { identityKeys: { a: "ka", b: "kb", c: "kc" }, frameModes: { a: "direct", b: "direct", c: "stateful" } };
  const x = planPipelines(project(clips), costs, FPS, opts);
  const y = planPipelines(project(clips), costs, FPS, { ...opts, searchLight: null });
  const wire = (p) => JSON.stringify({ s: p.segments.map((g) => [g.fromSec, g.toSec, [...g.heavy], [...g.light]]), set: [...p.prerenderSet] });
  assert.equal(wire(x), wire(y));
  assert.deepEqual([...x.prerenderSet], ["b", "c"], "b 实测超预算、c 没记录且声明 stateful");
});

test("CP-06 searchLight 与 allHeavy 同时给:allHeavy 优先", () => {
  const plan = planPipelines(project([{ id: "a", start: 0, end: 1 }]), [], FPS, { identityKeys: { a: "ka" }, searchLight: ["ka"], allHeavy: true });
  assert.deepEqual([...plan.prerenderSet], ["a"]);
});

test("CP-07 即时渲染闸门:测崩过的卡直接当重卡(有记录的钉死为重,没有记录的补一条),按界限搜索判时也从判轻里去掉", async () => {
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }, { id: "c", start: 1, end: 3 }]));
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], [], "声明 direct 的三张都判轻");
  d.setPlanForcedHeavy(["kb"]);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], ["b"], "测崩过的 b 当重卡");
  d.setPlanSearch(true);
  d.setPlanSearchLight(["ka", "kb", "kc"]);
  await settle();
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "界限搜索判它轻也照样当重卡");
  d.setPlanForcedHeavy([]);
  d.resetPlanDispatch();
});
