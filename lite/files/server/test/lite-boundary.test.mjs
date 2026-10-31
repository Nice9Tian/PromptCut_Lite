/**
 * Lite 版的边界：只有本地，没有局域网、手机、账号、云端。
 *
 * 这几条守的是「裁掉的东西没有回来」。Lite 从社区版裁出来，同步社区版的改动时最容易把裁掉的路径带回来，
 * 或者让编辑器又绑到局域网网卡上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracked = () => execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  .split(/\r?\n/).filter(Boolean);

test('LT-1 局域网、手机、在线、账号这几层都不在', () => {
  for (const gone of ['server/lan', 'src/mobile', 'server/auth', 'server/recovery', 'src/account', 'cloud']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, gone);
  }
  for (const gone of ['src/editor/sync/JoinForm.tsx', 'src/editor/sync/CollabSection.tsx', 'src/editor/sync/MembersPanel.tsx', 'src/editor/LanOpenDialog.tsx', 'server/vite-plugin-lan-open.ts']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, gone);
  }
});

test('LT-2 代码里没有我们的线上地址，也没有去找云端模块的入口', () => {
  const hits = [];
  for (const rel of tracked()) {
    if (!/\.(ts|tsx|mjs|cjs|js|json|rs|toml|html|css)$/.test(rel) || rel === 'server/test/lite-boundary.test.mjs') continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    if (/visuhive\.com|#promptcut-cloud|PROMPTCUT_CLOUD_DIR|\/hosted\/shared/.test(text)) hits.push(rel);
  }
  assert.deepEqual(hits, []);
});

test('LT-3 编辑器只绑回环地址', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(scripts.dev, /--host 127\.0\.0\.1/);
  assert.equal(scripts['dev:lan'], undefined);
});
