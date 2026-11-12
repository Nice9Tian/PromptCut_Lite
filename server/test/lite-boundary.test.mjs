/**
 * Lite edition boundary: local-only, with no LAN, mobile, account, or cloud layers.
 *
 * These checks ensure that cut layers do not creep back in. Lite is generated from the community
 * edition by script, and newly added files in the community edition remain by default, which could
 * otherwise bring back cut paths or bind the editor to LAN interfaces again.
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

test('LT-1 LAN, mobile, online, and account layers are absent', () => {
  for (const gone of ['server/lan', 'src/mobile', 'server/auth', 'server/recovery', 'src/account', 'cloud']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, gone);
  }
  for (const gone of [
    'src/editor/sync/JoinForm.tsx',
    'src/editor/sync/CollabSection.tsx',
    'src/editor/sync/MembersPanel.tsx',
    'src/editor/LanOpenDialog.tsx',
    'server/vite-plugin-lan-open.ts',
    'server/data-server.mjs',
    'server/render-server-pool.mjs',
    'src/start/LoginDialog.tsx',
    'src/start/NewProjectDialog.tsx',
    'src/editor/sync/DataServerPanel.tsx',
    'src/editor/sync/RenderServerPanel.tsx',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, gone);
  }
});

test('LT-2 source files contain no hosted origin URLs or cloud module entrypoints', () => {
  const hits = [];
  for (const rel of tracked()) {
    if (!/\.(ts|tsx|mjs|cjs|js|json|rs|toml|html|css)$/.test(rel) || rel === 'server/test/lite-boundary.test.mjs' || rel.startsWith('lite/')) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    if (/visuhive\.com|#promptcut-cloud|PROMPTCUT_CLOUD_DIR|\/hosted\/shared/.test(text)) hits.push(rel);
  }
  assert.deepEqual(hits, []);
});

test('LT-3 editor dev script binds exclusively to loopback', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(scripts.dev, /--host 127\.0\.0\.1/);
  assert.equal(scripts['dev:lan'], undefined);
});
