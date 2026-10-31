#!/usr/bin/env node
/*
 * Lite 版由这个脚本从社区版生成。仓库根下除了 `lite/` 都是生成出来的，别手改。
 *
 *   node lite/generate.mjs                  生成到社区版最新提交，写进工作区，不提交
 *   node lite/generate.mjs --ref <提交>     生成到指定提交
 *   node lite/generate.mjs --check          核对工作区提交的树就是配方生成的结果（CI 用）
 *   node lite/generate.mjs --record <提交>  把当前工作区记成新的配方，基准是这个社区版提交
 *
 * 配方（都在 lite/ 下）：
 *   base.txt     配方对应的社区版提交
 *   cut.txt      要裁掉的路径，以 / 结尾的是整个目录
 *   patches/     Lite 改过的文件，一个文件一份补丁
 *   files/       社区版没有、Lite 自己的文件
 *
 * 社区版改了 Lite 也改过的地方时，补丁按三方合并。合不上就把带冲突标记的文件留在工作区，
 * 改好之后用 --record 记下来。社区版新加的文件默认留下，要裁就写进 cut.txt。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_URL = 'https://github.com/Nice9Tian/PromptCut_Community.git';
const RECIPE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(RECIPE);
const BASE_FILE = path.join(RECIPE, 'base.txt');
const CUT_FILE = path.join(RECIPE, 'cut.txt');
const PATCHES = path.join(RECIPE, 'patches');
const FILES = path.join(RECIPE, 'files');

const say = (s) => process.stdout.write(`${s}\n`);
const die = (s) => {
  process.stderr.write(`\n✗ ${s}\n`);
  process.exit(1);
};

function git(cwd, ...a) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...a], { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);
const readBase = () => fs.readFileSync(BASE_FILE, 'utf8').trim();
const readCut = () => lines(fs.readFileSync(CUT_FILE, 'utf8')).filter((l) => !l.startsWith('#'));
const isCut = (rel, cut) => cut.some((c) => (c.endsWith('/') ? rel.startsWith(c) : rel === c));

/** 递归列出目录下的文件（正斜杠相对路径） */
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

function ensureUpstream() {
  let url = '';
  try { url = git(ROOT, 'remote', 'get-url', 'upstream').trim(); } catch { /* 还没有这个远端 */ }
  git(ROOT, 'remote', url ? 'set-url' : 'add', 'upstream', UPSTREAM_URL);
  git(ROOT, 'remote', 'set-url', '--push', 'upstream', 'DISABLED');
  git(ROOT, 'fetch', '-q', 'upstream');
}

/** 把基准提交检出成一棵临时树，裁掉、打补丁、放自有文件，返回 { dir, conflicts, close } */
function build(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-gen-'));
  git(ROOT, 'worktree', 'add', '-q', '--detach', dir, ref);
  const close = () => {
    git(ROOT, 'worktree', 'remove', '--force', dir);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const cut = readCut();
  const removed = lines(git(dir, 'ls-files')).filter((rel) => isCut(rel, cut));
  const list = path.join(os.tmpdir(), `lite-cut-${process.pid}.txt`);
  fs.writeFileSync(list, removed.join('\n'));
  if (removed.length) git(dir, 'rm', '-q', '-f', `--pathspec-from-file=${list}`);
  fs.rmSync(list, { force: true });

  const conflicts = [];
  for (const rel of walk(PATCHES)) {
    const target = rel.replace(/\.patch$/, '');
    if (isCut(target, cut)) die(`${target} 既在 cut.txt 里又有补丁，留一个。`);
    try {
      git(dir, 'apply', '--3way', '--whitespace=nowarn', path.join(PATCHES, rel));
    } catch (e) {
      if (!lines(git(dir, 'diff', '--name-only', '--diff-filter=U', '--', target)).length) die(`${target} 的补丁打不上：\n${e.stderr ?? e.message}`);
      conflicts.push(target);
    }
  }
  for (const rel of walk(FILES)) {
    const dst = path.join(dir, rel);
    if (fs.existsSync(dst)) die(`${rel} 在社区版里已经有了，从 lite/files/ 删掉或改成补丁。`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(FILES, rel), dst);
  }
  git(dir, 'add', '-A');
  return { dir, conflicts, close };
}

/** 工作区里生成出来的文件（lite/ 之外、git 跟踪或未忽略的） */
const generatedFiles = (dir) => lines(git(dir, 'ls-files', '-co', '--exclude-standard')).filter((rel) => !rel.startsWith('lite/') && fs.existsSync(path.join(dir, rel)));

function installInto(dir) {
  for (const rel of generatedFiles(ROOT)) fs.rmSync(path.join(ROOT, rel), { force: true });
  for (const rel of lines(git(dir, 'ls-files'))) {
    const dst = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(dir, rel), dst);
    fs.chmodSync(dst, fs.statSync(path.join(dir, rel)).mode);
  }
}

function record(ref) {
  const base = git(ROOT, 'rev-parse', ref).trim();
  const upstream = new Set(lines(git(ROOT, 'ls-tree', '-r', '--name-only', base)));
  const tree = new Set(generatedFiles(ROOT));

  // 目录里社区版的文件全被裁掉，就记整个目录，以后社区版往里加的也跟着裁
  const gone = [...upstream].filter((rel) => !tree.has(rel));
  const dirs = new Map();
  for (const rel of upstream) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = `${parts.slice(0, i).join('/')}/`;
      if (!dirs.has(d)) dirs.set(d, { total: 0, kept: 0 });
      dirs.get(d).total += 1;
      if (tree.has(rel)) dirs.get(d).kept += 1;
    }
  }
  const whole = [...dirs].filter(([d, n]) => n.kept === 0 && ![...tree].some((rel) => rel.startsWith(d))).map(([d]) => d);
  const top = whole.filter((d) => !whole.some((o) => o !== d && d.startsWith(o)));
  const cut = [...top, ...gone.filter((rel) => !top.some((d) => rel.startsWith(d)))].sort();
  fs.writeFileSync(CUT_FILE, `# 从社区版裁掉的路径，以 / 结尾的是整个目录。由 --record 生成\n${cut.join('\n')}\n`);

  fs.rmSync(PATCHES, { recursive: true, force: true });
  fs.rmSync(FILES, { recursive: true, force: true });
  // 用临时索引把工作区写成一棵树，再逐个和基准比。索引从基准读起：
  // 社区版有些文件是 CRLF 入库的，从空索引 add 会被规范化成 LF，整个文件都算改过
  const index = path.join(os.tmpdir(), `lite-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const withIndex = (...a) => execFileSync('git', ['-c', 'core.quotepath=off', ...a], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const pathspec = path.join(os.tmpdir(), `lite-paths-${process.pid}.txt`);
  const withPaths = (rows, ...a) => {
    if (!rows.length) return;
    fs.writeFileSync(pathspec, rows.join('\n'));
    withIndex(...a, `--pathspec-from-file=${pathspec}`);
  };
  withIndex('read-tree', base);
  withPaths(gone, 'rm', '-q', '-f', '--cached');
  withPaths([...tree], 'add', '-f');
  // 换行符跟社区版走，不然补丁是整个文件，社区版一改就合不上
  const touched = lines(withIndex('diff-index', '--cached', '--name-only', base)).filter((rel) => upstream.has(rel) && tree.has(rel));
  for (const rel of touched) {
    const before = execFileSync('git', ['cat-file', 'blob', `${base}:${rel}`], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (before.includes(0)) continue;
    const file = path.join(ROOT, rel);
    const text = fs.readFileSync(file, 'utf8');
    const lf = text.replace(/\r\n/g, '\n');
    fs.writeFileSync(file, before.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf);
  }
  withPaths(touched, 'add', '-f');
  fs.rmSync(pathspec, { force: true });
  const treeId = withIndex('write-tree').trim();
  fs.rmSync(index, { force: true });

  let patched = 0, own = 0;
  for (const rel of tree) {
    if (!upstream.has(rel)) {
      const dst = path.join(FILES, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dst);
      own += 1;
      continue;
    }
    const diff = execFileSync('git', ['-c', 'core.quotepath=off', 'diff', '--full-index', '--no-renames', '--binary', base, treeId, '--', rel], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (!diff.length) continue;
    const dst = path.join(PATCHES, `${rel}.patch`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, diff);
    patched += 1;
  }
  fs.writeFileSync(BASE_FILE, `${base}\n`);
  say(`配方已记下：基准 ${base.slice(0, 10)}，裁掉 ${cut.length} 条，补丁 ${patched} 份，自有文件 ${own} 个。`);
}

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

ensureUpstream();

if (args.includes('--record')) {
  record(opt('--record'));
} else if (args.includes('--check')) {
  const { dir, conflicts, close } = build(readBase());
  try {
    if (conflicts.length) die(`配方打不上：${conflicts.join('、')}`);
    const generated = git(dir, 'write-tree').trim();
    const committed = git(ROOT, 'rev-parse', 'HEAD^{tree}').trim();
    const diff = lines(git(ROOT, 'diff', '--name-status', '--no-renames', generated, committed)).filter((l) => !l.split('\t')[1].startsWith('lite/'));
    if (diff.length) die(`提交的文件和配方生成的不一致，有人手改了生成结果：\n  ${diff.slice(0, 40).join('\n  ')}`);
    say(`✓ 仓库内容就是社区版 ${readBase().slice(0, 10)} 按配方生成的结果。`);
  } finally {
    close();
  }
} else {
  if (lines(git(ROOT, 'status', '--porcelain')).length) die('工作区有未提交的改动，先提交或收好再生成。');
  const ref = git(ROOT, 'rev-parse', opt('--ref') ?? 'upstream/main').trim();
  const { dir, conflicts, close } = build(ref);
  try {
    installInto(dir);
    if (conflicts.length) {
      say(`有 ${conflicts.length} 个文件合不上，冲突标记留在工作区：`);
      for (const rel of conflicts) say(`  ${rel}`);
      say(`改好之后跑 node lite/generate.mjs --record ${ref}，再跑测试、提交。`);
      process.exit(1);
    }
    if (ref !== readBase()) record(ref);
    say(`✓ 已生成到社区版 ${ref.slice(0, 10)}。跑完测试再提交。`);
  } finally {
    close();
  }
}
