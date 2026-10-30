/**
 * 用户 2026-10-21 定的三件事(`docs/plan/user-decisions-2026-10-21.md` 第 2.2 节、第 3 节;报告 `docs/reports/AGENT-cut-look-ui.md`):
 *
 *   CL-1  `cutLookView`:不给 cutId 原样返回(当前激活);给停放剪辑的 id 换成「那条当激活」的视图,原项目不动;id 不存在明确报错
 *   CL-2  Agent 服务端执行器(`agent-exec.mjs` 的 see_frames):带 cutId 时交给渲染的是那条剪辑的视图、
 *         不给 t 取那条剪辑上次停下的播放头、`cutLook` 记号带给出图那一侧;不带 cutId 照旧;id 不存在报错;全程不提交、副本不变
 *   CL-3  没绑副本时的镜像那条路(`instance.mjs` 的 runMirroredTool):同上
 *   CL-5  工具改名:模型清单里只有新名、旧名不在;入口新旧都认;发给页面的 SSE `call` 里是旧的内部操作名;
 *         路由表与页面执行器认新名
 *   CL-6  add_cut 只建不切;set_cut_segment 不再收 cutId(工具说明);PAGE_STATE_TOOLS 跟着改
 *
 * 跑:npm test -- server/test/cut-look-ui.test.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cutLookView } from '../../src/kernel/agentScopes.mjs';
import { createAgentExecutor, PAGE_STATE_TOOLS, seeFramesView } from '../agent/agent-exec.mjs';
import { tools } from '../mcp-tools.mjs';
import { UI_TOOL_RENAMES, modelToolName, pageToolName, isUserInterfaceTool } from '../tools/ui-names.mjs';
import { TOOL_ROUTES, SPECIAL_TOOLS } from '../../src/mcp/routes.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 剪辑1(激活,红卡)+ 剪辑2(停放,蓝卡,上次停在 1.5 秒) */
function project() {
  return {
    version: 1, id: 'p-look', name: 'look', width: 640, height: 360, fps: 30, duration: 4, themeId: 'midnight', media: [],
    tracks: [{ id: 't1', name: '序列 1', clips: [{ id: 'red', cardId: 'solid', params: { color: '#ff0000' }, start: 0, end: 4 }] }],
    cuts: [
      { id: 'cut-1', name: '剪辑1' },
      { id: 'cut-2', name: '剪辑2', t: 1.5, duration: 6, transitions: [], tracks: [{ id: 't2', name: '序列 1', clips: [{ id: 'blue', cardId: 'solid', params: { color: '#0000ff' }, start: 0, end: 6 }] }] },
    ],
    activeCutId: 'cut-1',
  };
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

test('CL-1 cutLookView:不给 cutId 原样;给停放剪辑换视图且原项目不动;不存在明确报错', () => {
  const p = deepFreeze(project());
  const same = cutLookView(p, undefined);
  assert.equal(same.project, p);
  assert.deepEqual([same.active, same.cut, same.parkedT], [true, { id: 'cut-1', name: '剪辑1' }, null]);
  assert.equal(cutLookView(p, 'cut-1').project, p, '传当前激活的 id 也原样');
  assert.equal(cutLookView(p, '').project, p, '空串当没传');
  const v = cutLookView(p, 'cut-2');
  assert.equal(v.active, false);
  assert.deepEqual(v.cut, { id: 'cut-2', name: '剪辑2' });
  assert.equal(v.parkedT, 1.5);
  assert.equal(v.project.activeCutId, 'cut-2');
  assert.equal(v.project.tracks, p.cuts[1].tracks, '视图的 tracks 就是剪辑2 的');
  assert.equal(v.project.duration, 6);
  const entry1 = v.project.cuts.find((c) => c.id === 'cut-1');
  assert.equal(entry1.tracks, p.tracks, '剪辑1 退回条目、带着自己的内容(剪辑段引用照常解析)');
  const entry2 = v.project.cuts.find((c) => c.id === 'cut-2');
  assert.equal('tracks' in entry2 || 't' in entry2, false, '激活那条的条目不带内容');
  assert.equal(p.activeCutId, 'cut-1', '原项目没被改');
  assert.throws(() => cutLookView(p, 'cut-9'), (e) => e.code === 'cut-not-found' && /找不到剪辑 "cut-9"/.test(e.message) && /剪辑2\(cut-2\)/.test(e.message));
  assert.throws(() => seeFramesView(p, 3), /cutId 要是字符串/);
  // 老项目(没有 cuts):只有剪辑1
  const old = { ...project(), cuts: undefined, activeCutId: undefined };
  assert.deepEqual(cutLookView(old).cut, { id: 'cut-1', name: '剪辑1' });
  assert.throws(() => cutLookView(old, 'cut-2'), /找不到剪辑/);
});

/** 执行器要的最小项目副本(只读工具用到的那几样) */
function fakeLink(p, rev = 7) {
  const replica = { hasBody: true, project: p, rev, waitRev: async () => true, offer() { throw new Error('读工具不该提交'); } };
  return {
    projectId: 'p-look', replica,
    ready: async () => {},
    conversation: () => ({ request: async () => { throw new Error('读工具不该向文档服务发请求'); } }),
  };
}

test('CL-2 执行器 see_frames:带 cutId 渲那条剪辑的视图、不提交;不带照旧;id 不存在报错', async () => {
  const p = deepFreeze(project());
  const posts = [];
  const exec = createAgentExecutor({
    link: fakeLink(p), loadHost: async () => { throw new Error('see_frames 不该进 host'); }, playhead: () => 3,
    prerenderPost: async (path, body, opts) => {
      posts.push({ path, body, opts });
      if (path === '/api/vision/snapshot') return { ok: true, t: body.t ?? null, __image: { mime: 'image/png', base64: 'AAAA' } };
      return { ok: true, visualId: 'v1' };
    },
  });
  const def = tools.find((t) => t.name === 'see_frames');
  assert.ok(def.inputSchema.properties.cutId, 'see_frames 的说明里有 cutId');

  const r2 = await exec.execute('see_frames', { source: 'timeline', cutId: 'cut-2' }, 'a1', def);
  const snap2 = posts.find((x) => x.path === '/api/vision/snapshot');
  assert.equal(snap2.body.project.activeCutId, 'cut-2', '交给渲染的是剪辑2 当激活的视图');
  assert.equal(snap2.body.project.tracks[0].clips[0].id, 'blue');
  assert.equal(snap2.body.t, 1.5, '不给 t 取剪辑2 上次停下的位置,不是页面播放头');
  assert.equal('cutId' in snap2.body, false, '请求体里不带 cutId:旧版渲染进程只认 project,一样出得对');
  assert.equal(snap2.opts.cutLook, true, '出图那一侧知道这是看别的剪辑');
  assert.deepEqual(r2.cut, { id: 'cut-2', name: '剪辑2' }, '回包写明看的是哪条剪辑');
  assert.equal(r2.rev, 7);
  assert.equal(p.activeCutId, 'cut-1');

  posts.length = 0;
  const r2t = await exec.execute('see_frames', { source: 'timeline', cutId: 'cut-2', times: [0.5, 2] }, 'a1', def);
  assert.deepEqual(posts[0].body.times, [0.5, 2]);
  assert.equal(posts[0].body.project.activeCutId, 'cut-2');
  assert.deepEqual(r2t.cut, { id: 'cut-2', name: '剪辑2' });

  posts.length = 0;
  const r1 = await exec.execute('see_frames', { source: 'timeline' }, 'a1', def);
  const snap1 = posts.find((x) => x.path === '/api/vision/snapshot');
  assert.equal(snap1.body.project, p, '不带 cutId:原项目原样交过去');
  assert.equal(snap1.body.t, 3, '不带 cutId:页面播放头');
  assert.equal(snap1.opts.cutLook, undefined);
  assert.deepEqual(r1.cut, { id: 'cut-1', name: '剪辑1' });

  posts.length = 0;
  await assert.rejects(() => exec.execute('see_frames', { source: 'timeline', cutId: 'nope' }, 'a1', def), /找不到剪辑 "nope"/);
  assert.equal(posts.length, 0, 'id 不存在时不去渲');
});

test('CL-5 工具改名:清单只有新名;入口新旧都认;页面收到旧的内部操作名;路由表认新名', () => {
  const names = new Set(tools.map((x) => x.name));
  for (const [oldName, newName] of Object.entries(UI_TOOL_RENAMES)) {
    assert.ok(names.has(newName), `${newName} 在清单里`);
    assert.equal(names.has(oldName), false, `旧名 ${oldName} 不在交给模型的清单里`);
    assert.match(newName, /^[a-zA-Z0-9_-]{1,64}$/, '模型侧的名字只能是字母数字下划线连字符');
    assert.equal(modelToolName(oldName), newName);
    assert.equal(pageToolName(newName), oldName);
    assert.ok(isUserInterfaceTool(oldName) && isUserInterfaceTool(newName));
  }
  assert.equal(modelToolName('add_clip'), 'add_clip');
  assert.equal(pageToolName('add_clip'), 'add_clip');
  // 不会动界面的工具名字里不带前缀
  for (const n of names) if (n.startsWith('user_interface_')) assert.ok(isUserInterfaceTool(n), `${n} 登记在 ui-names.mjs 里`);
  // 路由表 / 特殊分支认新名
  for (const n of ['user_interface_switch_cut', 'user_interface_seek', 'user_interface_play', 'user_interface_pause', 'user_interface_collect_login']) assert.ok(TOOL_ROUTES[n], n);
  assert.ok(SPECIAL_TOOLS.includes('user_interface_web_handoff'));
  for (const n of ['switch_cut', 'seek', 'play', 'pause', 'collect_login']) assert.equal(Object.hasOwn(TOOL_ROUTES, n), false);
});

test('CL-6 add_cut 只建不切;set_cut_segment 不收 cutId;切剪辑要播放头的表跟着改', () => {
  const addCut = tools.find((t) => t.name === 'add_cut');
  assert.equal('switch' in addCut.inputSchema.properties, false, 'add_cut 去掉 switch 参数');
  assert.match(addCut.description, /只建不切/);
  const setSeg = tools.find((t) => t.name === 'set_cut_segment');
  assert.deepEqual(Object.keys(setSeg.inputSchema.properties).sort(), ['clipId', 'cutOffset']);
  assert.match(setSeg.description, /引用哪条剪辑不能改/);
  assert.deepEqual(Object.keys(PAGE_STATE_TOOLS).sort(), ['attach_clip_motion', 'remove_cut', 'user_interface_switch_cut']);
  const switchCut = tools.find((t) => t.name === 'user_interface_switch_cut');
  assert.match(switchCut.description, /会动用户的界面/);
  assert.match(switchCut.description, /see_frames 传 cutId/);
});
