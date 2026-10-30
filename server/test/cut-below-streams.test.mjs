/**
 * 剪辑段里的卡产流(〔裁〕R01、R02;`docs/plan/user-decisions-2026-10-22.md` 第 2 节第 4 条)。用例名以 `CB-` 开头。
 * 跑:npm test -- server/test/cut-below-streams.test.mjs
 *
 * R01(剪辑段里毛玻璃这类依赖下层的卡带着下层一起产流)0.7.20 做过一版,靠给嵌套场景挂 `clip-path` 让它成为毛玻璃的采样边界;
 * 2026-10-23 用户推翻这条二级〔裁〕(原话「那条裁定我推翻,把 clip-path 那一行拿掉,R01 按做不通处理并返工。」),
 * 所以剪辑段里依赖下层、没审阅过的卡回到没有流的状态:不出流、不抑制,照旧在嵌套场景里活渲(嵌套场景里的毛玻璃会透过剪辑段
 * 采样段外面的层,只带段里下层的流和活渲对不上)。报告 `docs/reports/AGENT-claude-revert-r01.md`。
 *
 *   CB-golden  流(没有剪辑段的项目整张流表;有剪辑段的项目整张流表)与开工提交 b362e254 逐字相同;依赖下层的流的输入签名也相同
 *   CB-r01     剪辑段里依赖下层、没登记的卡不出流;嵌套场景不挂 clip-path
 *   CB-split   切分方给剪辑段里独立卡(平面的)出流任务;外框三维的、依赖下层的照旧不给
 */
import '../../src/testing/registerTs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { planStreams, planListStreams, queueStreamOf, STREAM_CODE_VERSION } from '../frame-stream.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { captureCode } from '../frame-code.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { clipsPlanTaskOf } from '../render-queue/index.mjs';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';
import { cutProject, topProject, entryOf, pageValueOf, FP, CV } from './cut-below-fixtures.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const h = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
/**
 * 金样比的那一份:流的每一项原样,只是 `members`(卡片计划的控件)里只留和流有关的几项 —— 控件里另有生成快照的代码指纹算进去的键
 * (`contentKey`、`snapshotKey`,`server/frame-code.mjs` 的 `snapshotCode`),0.7.20 改了 `createSnapshot.ts`(加了一个缺省关着的参数),
 * 它们跟着变,但不进任何流的键(单卡流用 `streamMemberKey`,组流和依赖下层的流用 `cacheContentKey`)。
 */
const view = s => ({ ...s, members: s.members.map(m => ({ clipId: m.clipId, streamMemberKey: m.streamMemberKey, cacheContentKey: m.cacheContentKey, sampling: m.sampling, count: m.count })) });
const plan = p => planStreams(entryOf(p), { envFingerprint: FP, codeVersion: CV, below: true });

/* ================================================================== R01(已推翻,退回) */

test('CB-golden 流与开工提交 b362e254 逐字相同(没有剪辑段的项目、有剪辑段的项目整张流表;依赖下层的流的签名)', () => {
  // 金样:在开工提交上(`git archive b362e254` 解出来的树)用同一份场景、同一个 `view` 算的(`server/test/cut-below-fixtures.mjs`)
  assert.equal(h(plan(topProject()).map(view)), 'd433e1b11d0af435', '没有剪辑段的项目:流表逐字相同');
  assert.equal(h(plan(cutProject()).map(view)), '72c7b90197564be3', '有剪辑段的项目:流表逐字相同(剪辑段里依赖下层的卡没有流)');
  const specs = plan(cutProject());
  const want = { over: '5e49f36ef9d578ba', 'S~S2~cc': '4d1e02e642a66958', 'S~m': '421d9dcd43f4bf8d', 'S~up': '2523fb08171ba9ea', topg: 'af0aab0e91abff08' };
  for (const [id, hash] of Object.entries(want)) {
    const spec = specs.find(s => s.topClipId === id);
    assert.ok(spec, `${id} 的流还在`);
    assert.equal(h(view(spec)), hash, `${id} 的流逐字相同`);
  }
  assert.equal(streamInputSig(topProject(), { clipIds: ['glass'], kind: 'below' }), 's1-c03e47ff075c67d9');
  assert.equal(streamInputSig(cutProject(), { clipIds: ['topg'], kind: 'below' }), 's1-b008c155a4d05838');
  // 剪辑段里那两张卡的「依赖下层签名」也回到开工提交的算法(下层不按嵌套场景筛)
  assert.equal(streamInputSig(cutProject(), { clipIds: ['S~g'], kind: 'below' }), 's1-eb0a1cc7f47115fc');
  assert.equal(streamInputSig(cutProject(), { clipIds: ['S~u'], kind: 'below' }), 's1-be41e3749588320b');
});

test('CB-r01 剪辑段里依赖下层、没登记的卡不出流(〔裁〕R01 被推翻);嵌套场景不挂 clip-path', () => {
  const specs = plan(cutProject());
  for (const id of ['S~g', 'S~u']) assert.ok(!specs.some(s => s.clipIds.includes(id)), `${id} 没有流`);
  assert.ok(!specs.some(s => 'within' in s), '没有带 within 的流');
  // 顶层那张毛玻璃照旧有依赖下层的流,下层里有剪辑段里摊出来的卡
  assert.ok(specs.find(s => s.topClipId === 'topg').belowClipIds.includes('S~g'));
  const scene = fs.readFileSync(path.join(ROOT, 'src/render/CutSegmentScene.tsx'), 'utf8');
  assert.ok(!/clipPath|clip-path/.test(scene), '嵌套场景不挂 clip-path(毛玻璃照旧透过剪辑段采样段外面的层)');
});

/* ================================================================== R02 */

const OWN = '1111111111111111';
const BROWSER = '2222222222222222';
const CODES = { capture: captureCode(ROOT) };
const CODE_VERSION = 'code-version-for-test';

/** 服务端这条链:card plan → 清单计划的流 → 切分出的那一份 */
function serverSide(project, value, clips) {
  const wire = JSON.parse(JSON.stringify(value));
  const cache = new CardFrameCache({ root: path.join(os.tmpdir(), 'pc-cut-below-split'), project, envFingerprint: OWN });
  const cardIdOf = new Map(wire.graph.nodes.map(node => [node.id, node.cardId ?? null]));
  const cardPlan = cache.plan(wire).map(control => ({ ...control, cardId: cardIdOf.get(control.nodeId) ?? null }));
  const entry = { key: 'entry-cut', project, cardPlan };
  const specs = planListStreams(entry, clips, { codeVersion: `${STREAM_CODE_VERSION}:${CODES.capture}`, envFingerprint: OWN });
  const planTask = clipsPlanTaskOf({ projectId: project.id, projectRev: 7, clips, codeVersion: CODE_VERSION });
  const tasks = splitPlan({
    planTask, entryKey: entry.key, cardPlan, prerenderSet: new Set(clips),
    streams: specs.map(queueStreamOf).map(s => ({ ...s, browserOnly: true })),
    envFingerprint: OWN, codeVersion: CODE_VERSION, browserFingerprints: [BROWSER],
    weightOf: control => ({ class: ['belowDependent', 'unknown'].includes(control?.compositing ?? control?.capabilities?.compositing) ? 'heavy' : 'medium', estMs: null }),
  }).filter(t => t.kind === 'stream');
  return { specs, tasks, planTask };
}

/** 剪辑段里的重卡:独立卡(平面的)、外框三维的独立卡、毛玻璃 */
function r02Project() {
  const p = cutProject();
  const B = p.cuts.find(c => c.id === 'B');
  B.tracks.push({ id: 'b-3d', clips: [{ id: 'd3', cardId: 'caption-track', start: 0, end: 8, params: { text: 'd3' }, frame: { x: 0, y: 0, w: 300, h: 200, rotateY: 30 } }] });
  return p;
}

test('CB-split 切分方给剪辑段里平面独立卡出那一份流任务;外框三维的、依赖下层的不给', () => {
  const p = r02Project();
  const clips = ['S~up', 'S~m', 'S~S2~cc', 'S~d3', 'S~g'];
  const { specs, tasks } = serverSide(p, pageValueOf(p), clips);
  assert.ok(specs.some(s => s.topClipId === 'S~d3' && s.solo === 'flat'), '三维外框的那张照旧是切分方自己的 solo flat 单卡流');
  const forBrowser = new Set(tasks.filter(t => t.requires.envFingerprint === BROWSER).map(t => t.input.clipId));
  for (const id of ['S~up', 'S~m', 'S~S2~cc']) assert.ok(forBrowser.has(id), `${id} 有对应那一份:${[...forBrowser].join(' ')}`);
  assert.ok(!forBrowser.has('S~d3'), '外框三维的不给');
  assert.ok(!forBrowser.has('S~g'), '依赖下层的不给(和顶层一样)');
  const m = tasks.find(t => t.input.clipId === 'S~m');
  assert.equal(m.input.stream.kind, 'card');
  assert.equal(m.input.stream.plane, 'local');
  assert.equal(m.input.bake.sampling.firstFrame, 60, '露出窗口 [2, 6) 秒的第一帧');
});
