/**
 * 桌面产物里标题栏整套照旧,「⋯」菜单不重复「快捷键」「关于」。
 * 产物写进临时目录,不碰 `dist/`。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-titlebar-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

async function viteBuild(mode, outDir) {
  const { build } = await import('vite');
  const prevCwd = process.cwd();
  process.chdir(ROOT);
  try {
    await build({ root: ROOT, mode, logLevel: 'error', build: { outDir, emptyOutDir: true, reportCompressedSize: false } });
  } finally {
    process.chdir(prevCwd);
  }
}

const bundleText = (dir) => fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, 'assets', f), 'utf8')).join('\n');

test('TITLEBAR-ONLINE-02 桌面产物里标题栏整套照旧,「⋯」菜单不重复「快捷键」「关于」', { timeout: 240_000 }, async () => {
  const dir = path.join(OUT, 'dist');
  await viteBuild('production', dir);
  const text = bundleText(dir);
  for (const kept of ['titlebar-${', 'pc-titlebar-menus', '应用菜单', '窗口控制', 'pc-window-control', 'desktop_titlebar_command']) {
    assert.ok(text.includes(kept), `桌面产物里标题栏应还有 ${kept}`);
  }
  for (const dup of ['more-shortcuts', 'more-about']) {
    assert.equal(text.includes(dup), false, `桌面产物里「⋯」菜单不该重复 ${dup}`);
  }
});
