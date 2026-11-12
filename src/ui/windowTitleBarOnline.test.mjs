/**
 * Desktop build artifacts keep the full title bar as is, and the "⋯" menu does not duplicate
 * "Keyboard shortcuts" and "About".
 * Artifacts are written to a temporary directory without touching `dist/`.
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

/** The translation table chunk holds every interface string, including ones this build prunes */
const isTranslationTable = (f) => /^i18n-[\w-]+\.js$/.test(f);
const bundleText = (dir) => fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js') && !isTranslationTable(f)).map((f) => fs.readFileSync(path.join(dir, 'assets', f), 'utf8')).join('\n');

test('TITLEBAR-ONLINE-02 the desktop build keeps the whole title bar as is; the "⋯" menu does not duplicate "Shortcuts" and "About"', { timeout: 240_000 }, async () => {
  const dir = path.join(OUT, 'dist');
  await viteBuild('production', dir);
  const text = bundleText(dir);
  for (const kept of ['titlebar-${', 'pc-titlebar-menus', 'App menu', 'Window controls', 'pc-window-control', 'desktop_titlebar_command']) {
    assert.ok(text.includes(kept), `the desktop build's title bar should still have ${kept}`);
  }
  for (const dup of ['more-shortcuts', 'more-about']) {
    assert.equal(text.includes(dup), false, `the desktop build's "⋯" menu should not duplicate ${dup}`);
  }
});
