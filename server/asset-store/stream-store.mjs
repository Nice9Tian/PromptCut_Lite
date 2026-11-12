/**
 * Asset stream store and HTTP read endpoint: pure move from frame-stream; standalone asset entry
 * point does not load the renderer.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { STREAM_SEGMENT_FRAMES as SEGMENT_FRAMES } from '../bakery/ffmpeg.mjs';
import { atomic } from './atomic.mjs';
import { mergeRanges } from './ranges.mjs';
const KEY_RE = /^[a-f0-9]{64}$/;

/** Ready segment numbers in the manifest (range, C3's `stream` table unit is segment numbers) */
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
  /** Disk scan (F5): each stream's "key → ready segments" */
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
 * Manifest shape requested by the page (without internal fields like signatures). `originFrame`:
 * the first frame of this stream recorded in the manifest (project frame number, segments are 15
 * frames each starting from it); manifests written to disk before changing the segmentation rule
 * do not have this entry, returning null here.
 */
export function publicManifest(manifest) {
  if (!manifest) return null;
  const segments = {};
  // `stride`: 1 = full density, > 1 = sparse (only the first frame of the segment was captured,
  // remaining samples duplicate it). `box`: position rectangle of this segment (plane coordinates,
  // in the same coordinate system as `bound`; bounding box of opaque pixels in the frame measured
  // when producing the sparse version, `null` = that frame is fully transparent; unmeasured segments
  // do not have this entry)
  for (const [n, s] of Object.entries(manifest.segments ?? {})) segments[n] = { init: s.init, file: s.file, stride: s.stride, samples: s.samples, ...(s.box !== undefined ? { box: s.box } : {}) };
  const inits = {};
  for (const [id, i] of Object.entries(manifest.inits ?? {})) inits[id] = { codec: i.codec, width: i.width, height: i.height, rect: i.rect };
  return { streamKey: manifest.streamKey, kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps,
    segmentFrames: SEGMENT_FRAMES, originFrame: Number.isInteger(manifest.originFrame) && manifest.originFrame >= 0 ? manifest.originFrame : null, bound: manifest.bound, tight: manifest.tight ?? null, inits, segments };
}

/**
 * Read endpoint for segment bytes (same origin as C3 snapshot bytes, page connects directly to
 * the prerender process):
 *
 *   GET /stream/<streamKey>/manifest            manifest (`no-store`: segments will be replaced)
 *   GET /stream/<streamKey>/init/<initId>       init.mp4 (content-addressed, immutable)
 *   GET /stream/<streamKey>/seg/<n>-<hash>.m4s  segment (content-addressed, immutable)
 *
 * `pathname` is the part after `/api/frames`. Returns true if recognized (already responded),
 * false if not recognized.
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
