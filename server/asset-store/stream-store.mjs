/** 素材流库与HTTP读口：从frame-stream纯移动，独立asset入口不加载渲染器。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { STREAM_SEGMENT_FRAMES as SEGMENT_FRAMES } from '../bakery/ffmpeg.mjs';
import { atomic } from './atomic.mjs';
import { mergeRanges } from './ranges.mjs';
const KEY_RE = /^[a-f0-9]{64}$/;

/** 清单里就绪的分段号(区间,C3 的 `stream` 表单位是分段号) */
export function readySegmentRanges(manifest) {
  return mergeRanges(Object.keys(manifest?.segments ?? {}).map(Number).filter(Number.isInteger));
}

export class StreamStore {
  constructor(root, { io = fs } = {}) {
    this.io = io;
    this.root = root;
    this.manifests = new Map();
  }
  dir(key) { return path.join(this.root, key); }
  async load(key) {
    if (this.manifests.has(key)) return this.manifests.get(key);
    let manifest = null;
    try { const file = path.join(this.dir(key), 'stream.json'); manifest = JSON.parse((await this.io.readFile(file)).toString('utf8')); } catch {}
    if (!manifest || manifest.streamKey !== key) manifest = null;
    this.manifests.set(key, manifest);
    return manifest;
  }
  async save(manifest) {
    await this.writeFile(path.join(this.dir(manifest.streamKey), 'stream.json'), JSON.stringify(manifest), { replace: true });
    this.manifests.set(manifest.streamKey, manifest);
  }
  async writeFile(target, bytes) {
    await atomic(target, bytes);
  }
  /** 扫盘(F5):每条流的「键 → 就绪分段」 */
  async scan() {
    const out = [];
    let items = [];
    try { items = await fs.readdir(this.root, { withFileTypes: true }); } catch { return out; }
    for (const item of items) {
      if (!item.isDirectory() || !KEY_RE.test(item.name)) continue;
      this.manifests.delete(item.name);
      const manifest = await this.load(item.name);
      if (!manifest) continue;
      const ranges = readySegmentRanges(manifest);
      if (ranges.length) out.push({ key: item.name, ranges, manifest });
    }
    return out;
  }
  initFile(key, id) { return path.join(this.dir(key), `init-${id}.mp4`); }
  segFile(key, file) { return path.join(this.dir(key), file); }
}

/**
 * 页面要的清单形状(不带签名等内部字段)。`originFrame`:清单里记的这条流的第一帧(项目帧号,分段从它起每 15 帧一段);
 * 改分段规则之前落盘的清单没有这一项,这里回 null。
 */
export function publicManifest(manifest) {
  if (!manifest) return null;
  const segments = {};
  for (const [n, s] of Object.entries(manifest.segments ?? {})) segments[n] = { init: s.init, file: s.file, stride: s.stride, samples: s.samples, ...(s.box !== undefined ? { box: s.box } : {}) };
  const inits = {};
  for (const [id, i] of Object.entries(manifest.inits ?? {})) inits[id] = { codec: i.codec, width: i.width, height: i.height, rect: i.rect };
  return { streamKey: manifest.streamKey, kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps,
    segmentFrames: SEGMENT_FRAMES, originFrame: Number.isInteger(manifest.originFrame) && manifest.originFrame >= 0 ? manifest.originFrame : null, bound: manifest.bound, tight: manifest.tight ?? null, inits, segments };
}

/**
 * 分段字节的读口(C3 的快照字节同源,页面直连预渲染进程):
 *
 *   GET /stream/<streamKey>/manifest            清单(`no-store`:分段会被替换)
 *   GET /stream/<streamKey>/init/<initId>       init.mp4(内容寻址,immutable)
 *   GET /stream/<streamKey>/seg/<n>-<hash>.m4s  分段(内容寻址,immutable)
 *
 * `pathname` 是 `/api/frames` 之后那一段。认得就回 true(已经答了),不认得回 false。
 */
export function handleStreamRequest(store, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = /^\/stream\/([a-f0-9]{64})\/(manifest|init\/([a-f0-9]{16})|seg\/(\d{1,7}-[a-f0-9]{16}\.m4s))$/.exec(pathname);
  if (!m) return false;
  const key = m[1];
  const fail = (status, error) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify({ error })); };
  if (m[2] === 'manifest') {
    store.manifests.delete(key);
    void store.load(key).then(manifest => {
      if (res.destroyed) return;
      if (!manifest) return fail(404, 'Stream is not ready');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(publicManifest(manifest)));
    }, () => fail(404, 'Stream is not ready'));
    return true;
  }
  const file = m[3] ? store.initFile(key, m[3]) : store.segFile(key, m[4]);
  void store.io.readFile(file).then(buf => {
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Length', buf.length);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }, () => fail(404, 'Stream file is not ready'));
  return true;
}
