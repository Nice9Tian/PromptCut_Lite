/**
 * Test cases for asset service HTTP layer after connecting data layer (contract
 * `docs/plan/asset-store-contract.md` sections 3 and 4, test cases H1, H2, H4, H5).
 * Run: node --test server/test/asset-store-http.test.mjs
 *
 * Written against contract only, without looking at implementation. `asset-service.ts` is
 * transpiled to a temp directory with typescript and imported, following `asset-service.test.mjs`;
 * before transpilation, convert all relative-path imports (static and dynamic) in source code to
 * absolute paths: `.ts` modules are recursively transpiled, `.mjs` / `.js` point directly to
 * repository files. This way, new references added by implementers like `./asset-store/index.mjs`
 * do not need to be registered here individually.
 *
 * When the data layer (`server/asset-store/index.mjs`) and `assetServiceMiddleware` with options
 * fail to load / do not accept options, each test case fails individually and reports the reason.
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-asset-http-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;
delete process.env.PROMPTCUT_EDITOR_URL;
delete process.env.PROMPTCUT_CLUSTER_TOKEN;

/* ------------------------------------------------------------------ *
 * Transpilation
 * ------------------------------------------------------------------ */

const compiled = new Map();
function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.mjs')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
/** Transpile a .ts source file, returning output file:// URL. All relative imports rewritten to absolute paths */
function compileTs(absFile) {
  if (compiled.has(absFile)) return compiled.get(absFile);
  const rel = path.relative(ROOT, absFile).replace(/[\\/]/g, '__').replace(/\.ts$/, '');
  const outFile = path.join(OUT, `${rel}.mjs`);
  const url = pathToFileURL(outFile).href;
  compiled.set(absFile, url); // Register first so circular references do not loop infinitely
  let src = fs.readFileSync(absFile, 'utf8');
  const rewrite = (spec) => {
    const hit = resolveRel(absFile, spec);
    if (!hit) return spec;
    return hit.endsWith('.ts') ? compileTs(hit) : pathToFileURL(hit).href;
  };
  src = src.replace(/(\bfrom\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
  src = src.replace(/(\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
  src = src.replace(/(\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(outFile, js);
  return url;
}

const ASSET_SRC = path.join(ROOT, 'server', 'asset-service.ts');
const media = await import(compileTs(path.join(ROOT, 'server', 'vite-plugin-media.ts')));
const asset = await import(compileTs(ASSET_SRC));

let storeMod = null;
let storeError = null;
try { storeMod = await import('../asset-store/index.mjs'); } catch (err) { storeError = err; }
function needStore() {
  if (storeError) throw new Error(`cannot load server/asset-store/index.mjs: ${storeError.message}`);
  return storeMod;
}
const CHUNK = 8 * 1024 * 1024;
const memoryStore = () => needStore().createBlobStore({ kind: 'memory', chunkSize: CHUNK });

/* ------------------------------------------------------------------ *
 * Server and requests
 * ------------------------------------------------------------------ */

let rootSeq = 0;
function freshRoot() {
  const root = path.join(OUT, `project-${++rootSeq}`);
  fs.mkdirSync(media.mediaDir(root), { recursive: true });
  return root;
}

/**
 * Start a server: asset service first, old routes after (same wiring as mediaPlugin).
 * If `remote` is given, set each request's socket.remoteAddress to it, simulating requests from
 * LAN (without needing to actually bind to a LAN network adapter).
 */
async function serve({ opts, remote } = {}) {
  const root = freshRoot();
  const a = opts === undefined ? asset.assetServiceMiddleware(root) : asset.assetServiceMiddleware(root, opts);
  const m = media.mediaMiddleware(root);
  const server = http.createServer((req, res) => {
    if (remote) Object.defineProperty(req.socket, 'remoteAddress', { value: remote, configurable: true });
    void a(req, res, () => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { root, origin, base: `${origin}/api/asset` };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out.writeUInt32LE(x >>> 0, i < size - 3 ? i : size - 4); }
  return out;
}
const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));
const sliceOf = (buf, n) => buf.subarray(n * CHUNK, Math.min(buf.length, (n + 1) * CHUNK));
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const put = (base, hash, n, body, headers = {}) => fetch(`${base}/media/${hash}/${n}`, {
  method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
});
const complete = (base, hash, headers = {}) => fetch(`${base}/media/${hash}/complete`, { method: 'POST', headers });

/** Send a chunk, abort connection after writing only a part: simulate network disconnection mid-upload */
function putAndDrop(base, hash, n, size, part) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/media/${hash}/${n}`);
    const len = n < chunkCount(size) - 1 ? CHUNK : size - CHUNK * (chunkCount(size) - 1);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: { 'Content-Length': String(len), 'X-Media-Size': String(size), 'X-Media-Ext': 'mp4' },
    });
    req.on('error', () => resolve());
    req.write(part, () => setTimeout(() => { req.destroy(); setTimeout(resolve, 250); }, 50));
  });
}

/** Response snapshot for comparison: status code, set of response headers, response body (JSON parsed; sha256 and length for binary) */
const HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control',
  'access-control-allow-origin', 'access-control-expose-headers', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-private-network', 'access-control-max-age',
];
async function snap(resPromise) {
  const r = await resPromise;
  const headers = {};
  for (const k of HEADERS) headers[k] = r.headers.get(k);
  headers['last-modified?'] = r.headers.get('last-modified') !== null;
  const buf = Buffer.from(await r.arrayBuffer());
  let body;
  if (String(r.headers.get('content-type') || '').startsWith('application/json')) {
    try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); }
  } else {
    body = { bytes: buf.length, sha256: buf.length ? sha256(buf) : null };
  }
  return { status: r.status, headers, body };
}

/**
 * H1 script: resumable upload, 409 validation, Range 206 / 416, HEAD, cross-origin headers. Run once
 * each for fs and memory, returning a list of [stepName, snapshot] to compare field by field.
 */
async function script(base) {
  const LAN = 'http://192.168.1.50:8080';
  const out = [];
  const step = async (name, p) => { out.push([name, await snap(p)]); };

  const size = CHUNK * 2 + 4321; // 3 chunks
  const buf = bytesOf(size, 101);
  const hash = sha256(buf);
  const h = { 'X-Media-Size': String(size), 'X-Media-Ext': 'mp4' };

  await step('preflight (LAN origin)', fetch(`${base}/media/${hash}/0`, {
    method: 'OPTIONS',
    headers: { Origin: LAN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-media-size, authorization', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('preflight (public network origin)', fetch(`${base}/media/${hash}/chunks`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('reconcile: never seen', fetch(`${base}/media/${hash}/chunks`, { headers: { Origin: LAN } }));
  await step('PUT chunk 0', put(base, hash, 0, sliceOf(buf, 0), { ...h, Origin: LAN }));
  await step('PUT chunk 2', put(base, hash, 2, sliceOf(buf, 2), h));
  await putAndDrop(base, hash, 1, size, sliceOf(buf, 1).subarray(0, 1024 * 1024));
  await step('reconcile: the chunk that was cut off does not count', fetch(`${base}/media/${hash}/chunks`));
  await step('finalize: missing chunk', complete(base, hash, { Origin: LAN }));
  await step('re-upload chunk 1', put(base, hash, 1, sliceOf(buf, 1), h));
  await step('finalize: all chunks present', complete(base, hash, { Origin: LAN }));
  await step('reconcile: already stored', fetch(`${base}/media/${hash}/chunks`));
  await step('re-upload after storing', put(base, hash, 0, sliceOf(buf, 0), h));
  await step('finalize again after storing', complete(base, hash));

  await step('GET whole file', fetch(`${base}/media/${hash}`, { headers: { Origin: LAN } }));
  await step('GET uppercase hash', fetch(`${base}/media/${hash.toUpperCase()}`));
  await step('Range 100-199', fetch(`${base}/media/${hash}`, { headers: { Range: 'bytes=100-199', Origin: LAN } }));
  await step('Range across chunks', fetch(`${base}/media/${hash}`, { headers: { Range: `bytes=${CHUNK - 10}-${CHUNK + 9}` } }));
  await step('Range last 10', fetch(`${base}/media/${hash}`, { headers: { Range: 'bytes=-10' } }));
  await step('Range open-ended', fetch(`${base}/media/${hash}`, { headers: { Range: `bytes=${size - 5}-` } }));
  await step('Range out of bounds 416', fetch(`${base}/media/${hash}`, { headers: { Range: `bytes=${size + 10}-${size + 20}` } }));
  await step('HEAD', fetch(`${base}/media/${hash}`, { method: 'HEAD' }));
  await step('HEAD with Range', fetch(`${base}/media/${hash}`, { method: 'HEAD', headers: { Range: 'bytes=0-9' } }));

  // 409: whole file hash mismatch
  const small = bytesOf(3000, 102);
  const claimed = sha256(Buffer.from('not the same bytes'));
  await step('PUT (content that does not match the hash)', put(base, claimed, 0, small, { 'X-Media-Size': '3000', 'X-Media-Type': 'image/png' }));
  await step('finalize: hash-mismatch', complete(base, claimed));
  await step('reconcile: after discard', fetch(`${base}/media/${claimed}/chunks`));
  await step('finalize: after discard it is never seen', complete(base, claimed));
  await step('GET not stored', fetch(`${base}/media/${claimed}`));

  // Chunk verification
  const s2 = CHUNK + 10;
  const b2 = bytesOf(s2, 103);
  const h2 = sha256(b2);
  const hh = { 'X-Media-Size': String(s2), 'X-Media-Ext': 'mp4' };
  await step('out of range 416', put(base, h2, 2, Buffer.alloc(10), hh));
  await step('wrong length 400', put(base, h2, 1, Buffer.alloc(11), hh));
  await step('missing size 400', put(base, h2, 1, Buffer.alloc(10)));
  await step('chunk number with leading zero 400', put(base, h2, '01', Buffer.alloc(10), hh));
  await step('PUT chunk 1', put(base, h2, 1, sliceOf(b2, 1), hh));
  await step('size mismatch 409', put(base, h2, 0, sliceOf(b2, 0), { 'X-Media-Size': String(s2 + 1) }));
  await step('reconcile: after validation', fetch(`${base}/media/${h2}/chunks`));
  await step('bad hash 400', fetch(`${base}/media/xyz/chunks`));
  await step('wrong method 405 (chunks)', fetch(`${base}/media/${h2}/chunks`, { method: 'POST' }));
  await step('wrong method 405 (complete)', fetch(`${base}/media/${h2}/complete`));
  await step('wrong method 405 (whole file)', fetch(`${base}/media/${h2}`, { method: 'DELETE' }));

  // Small files: extension is reverse-looked up from X-Media-Type
  const b3 = bytesOf(777, 104);
  const h3 = sha256(b3);
  await step('PUT (X-Media-Type reverse lookup)', put(base, h3, 0, b3, { 'X-Media-Size': '777', 'X-Media-Type': 'video/webm' }));
  await step('finalize (webm)', complete(base, h3));
  await step('GET (webm)', fetch(`${base}/media/${h3}`));
  return out;
}

/* ------------------------------------------------------------------ *
 * H1
 * ------------------------------------------------------------------ */

test('H1 with the memory implementation injected: resumable upload, 409 validation, Range 206 / 416, HEAD and CORS headers are identical to the fs implementation field by field', async () => {
  const fsSrv = await serve();
  const memSrv = await serve({ opts: { store: memoryStore() } });
  const a = await script(fsSrv.base);
  const b = await script(memSrv.base);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i][0], a[i][0]);
    assert.deepEqual(b[i][1], a[i][1], `step ${i + 1} "${a[i][0]}": response bodies differ between memory and fs`);
  }

  // Matching on both sides is not enough: verify key responses against step 5 contract,
  // to avoid both sides being wrong together
  const get = (name) => b.find(([n]) => n === name)[1];
  assert.deepEqual(get('reconcile: never seen').body, { size: null, chunkSize: CHUNK, received: [], complete: false });
  assert.deepEqual(get('reconcile: the chunk that was cut off does not count').body.received, [0, 2]);
  assert.deepEqual([get('finalize: missing chunk').status, get('finalize: missing chunk').body.missing], [400, [1]]);
  assert.equal(get('finalize: all chunks present').status, 200);
  assert.equal(get('finalize: all chunks present').body.url.startsWith('/@media/'), true);
  assert.equal(get('re-upload after storing').body.complete, true);
  assert.equal(get('GET whole file').status, 200);
  assert.equal(get('GET whole file').headers['content-type'], 'video/mp4');
  assert.equal(get('GET whole file').headers['access-control-allow-origin'], '*');
  assert.equal(get('GET whole file').headers['last-modified?'], true, 'memory\'s mtimeMs is the time it was stored, and Last-Modified must be sent');
  assert.equal(get('Range 100-199').status, 206);
  assert.equal(get('Range 100-199').headers['content-range'], `bytes 100-199/${CHUNK * 2 + 4321}`);
  assert.equal(get('Range out of bounds 416').status, 416);
  assert.equal(get('HEAD').headers['content-length'], String(CHUNK * 2 + 4321));
  assert.deepEqual([get('finalize: hash-mismatch').status, get('finalize: hash-mismatch').body.error], [409, 'hash-mismatch']);
  assert.equal(get('finalize: after discard it is never seen').status, 404);
  assert.deepEqual([get('GET not stored').status, get('GET not stored').body], [404, { ok: false, error: 'not-found' }]);
  assert.deepEqual([get('size mismatch 409').status, get('size mismatch 409').body], [409, { ok: false, error: 'size-mismatch', size: CHUNK + 10 }]);
  assert.deepEqual(get('reconcile: after validation').body.received, [1]);
  assert.equal(get('GET (webm)').headers['content-type'], 'video/webm');
  assert.equal(get('preflight (LAN origin)').headers['access-control-allow-private-network'], 'true');
  assert.equal(get('preflight (public network origin)').headers['access-control-allow-private-network'], null);
});

/* ------------------------------------------------------------------ *
 * H2
 * ------------------------------------------------------------------ */

test('H2 gatekeeper: asset-service.ts source has no file system references and no .chunks directory name', () => {
  const src = fs.readFileSync(ASSET_SRC, 'utf8');
  const banned = ['from "fs"', 'from "fs/promises"', 'from "node:fs"', 'createReadStream', 'createWriteStream'];
  for (const s of banned) assert.ok(!src.includes(s), `${s} must not appear`);
  // Directory name .chunks: only intercept directory names in strings (contract section 8, rule 2):
  // '.chunks', ".chunks", `.chunks`, path fragments /.chunks, \\.chunks;
  // method call store.chunks(...) does not count
  const dirName = src.split(/\r?\n/).filter((line) => /['"`]\.chunks['"`]|[/\\]\.chunks\b/.test(line));
  assert.deepEqual(dirName, [], '.chunks directory name must not appear');
  // Switching quotes or different notation does not work either
  assert.doesNotMatch(src, /\bfrom\s*["'](node:)?fs(\/promises)?["']/, 'static import of fs');
  assert.doesNotMatch(src, /\bimport\s*\(\s*["'](node:)?fs(\/promises)?["']\s*\)/, 'dynamic import of fs');
  assert.doesNotMatch(src, /\brequire\s*\(\s*["'](node:)?fs(\/promises)?["']\s*\)/, 'require fs');
});

/* ------------------------------------------------------------------ *
 * H4, H5: Local loopback criterion and preflight
 * ------------------------------------------------------------------ */

/** Small asset of one chunk */
function smallAsset(seed, size = 1500) {
  const buf = bytesOf(size, seed);
  return { buf, hash: sha256(buf), h: { 'X-Media-Size': String(size), 'X-Media-Ext': 'png' } };
}

async function expect401(p, what) {
  const r = await p;
  assert.equal(r.status, 401, what);
  assert.deepEqual(await r.json(), { ok: false, error: 'unauthorized' }, what);
  assert.equal(r.headers.get('access-control-allow-origin'), '*', `${what}: 401 also carries CORS headers`);
}

test('H4 tickets is null and not local: reads and writes are all 401; local works as usual; the default isTrusted accepts loopback only; the cluster token is no longer accepted', async () => {
  const store = memoryStore();
  const { buf, hash, h } = smallAsset(401);

  const remote = await serve({ opts: { store, tickets: null, isTrusted: () => false } });
  for (const hdr of [{}, bearer(randomToken()), { Authorization: 'Bearer null' }, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }]) {
    await expect401(put(remote.base, hash, 0, buf, { ...h, ...hdr }), `non-local PUT ${JSON.stringify(hdr).slice(0, 40)}`);
    await expect401(complete(remote.base, hash, hdr), `non-local complete ${JSON.stringify(hdr).slice(0, 40)}`);
  }
  await expect401(fetch(`${remote.base}/media/${hash}/chunks`), 'no verifier: reads are also 401');

  // Local (isTrusted is true): works as usual without ticket
  const local = await serve({ opts: { store, tickets: null, isTrusted: () => true } });
  assert.equal((await put(local.base, hash, 0, buf, h)).status, 200);
  assert.equal((await complete(local.base, hash)).status, 200);
  // Two services share one data layer: local can read
  assert.equal((await fetch(`${local.base}/media/${hash}`)).status, 200);

  // Default isTrusted: determines loopback based on socket.remoteAddress
  const cases = [
    ['127.0.0.1', true], ['127.8.9.10', true], ['::1', true], ['::ffff:127.0.0.1', true],
    ['192.168.1.50', false], ['10.0.0.7', false], ['::ffff:192.168.1.50', false], ['fe80::1', false], ['8.8.8.8', false],
  ];
  for (const [addr, trusted] of cases) {
    const s = await serve({ opts: { store: memoryStore(), tickets: null }, remote: addr });
    const x = smallAsset(410, 64);
    const r = await put(s.base, x.hash, 0, x.buf, x.h);
    assert.equal(r.status, trusted ? 200 : 401, `remoteAddress ${addr}`);
    await r.arrayBuffer();
  }

  // Cluster token is no longer used for asset service (C5 approach retired): returns 401 even when
  // env var is set and Bearer is present (previously tested "default token takes env var")
  const envToken = randomToken();
  process.env.PROMPTCUT_CLUSTER_TOKEN = envToken;
  let s;
  try { s = await serve({ opts: { store: memoryStore(), tickets: null, token: envToken, isTrusted: () => false } }); } finally { delete process.env.PROMPTCUT_CLUSTER_TOKEN; }
  const y = smallAsset(420, 80);
  await expect401(put(s.base, y.hash, 0, y.buf, { ...y.h, ...bearer(envToken) }), 'cluster token write');
  await expect401(fetch(`${s.base}/media/${y.hash}/chunks`, { headers: bearer(envToken) }), 'cluster token read');
});

test('H5 the Access-Control-Allow-Headers returned by preflight includes Authorization (both middlewares and the constant do)', async () => {
  const names = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase());
  assert.ok(names(asset.ASSET_ALLOW_HEADERS).includes('authorization'), `ASSET_ALLOW_HEADERS: ${asset.ASSET_ALLOW_HEADERS}`);
  for (const k of ['content-type', 'range', 'x-media-size', 'x-media-ext', 'x-media-type']) assert.ok(names(asset.ASSET_ALLOW_HEADERS).includes(k), k);

  const srv = await serve({ opts: { store: memoryStore(), tickets: null, isTrusted: () => false } });
  const h = 'ab'.repeat(32);
  for (const url of [`${srv.base}/media/${h}/0`, `${srv.base}/media/${h}/complete`, `${srv.base}/media/${h}/chunks`, `${srv.origin}/@media/${h}`]) {
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://192.168.1.50:8080', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, x-media-size' },
    });
    assert.equal(pre.status, 204, url);
    assert.ok(names(pre.headers.get('access-control-allow-headers')).includes('authorization'), `${url}: ${pre.headers.get('access-control-allow-headers')}`);
  }

  // Preflight middleware placed before vite cors
  const fn = asset.assetPreflightMiddleware();
  const res = await new Promise((resolve) => {
    const r = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end() { resolve(this); } };
    fn({ method: 'OPTIONS', url: `/api/asset/media/${h}/0`, headers: { origin: 'http://192.168.1.50:8080' } }, r, () => resolve('next'));
  });
  assert.notEqual(res, 'next');
  assert.equal(res.statusCode, 204);
  assert.ok(names(res.headers['access-control-allow-headers']).includes('authorization'));
});
