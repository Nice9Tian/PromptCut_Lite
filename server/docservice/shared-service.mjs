/**
 * Unified assembly entry point for the local document service.
 *
 * Mounts in the local `local` space:
 * - Service address registry (`endpoints`)
 * - Project versions and operation stream (`project`)
 * - Content store (`content`)
 * - Cost records (`costs`)
 * - Presence state (`presence`)
 * - Pending merge table (`merge` / `pending-merge`)
 * - Tool call events (`events`)
 * - Render task queue (`render-queue`)
 */
import path from 'node:path';
import { createDocService } from './service.mjs';
import { spacedModule, LOCAL_SPACE } from './spaces.mjs';
import { createFileStore, createMemoryStore } from './store/index.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { renderQueueModule } from './modules/render-queue.mjs';
import { projectModule } from './modules/project.mjs';
import { contentModule } from './modules/content.mjs';
import { costsModule } from './modules/costs.mjs';
import { eventsModule } from './modules/events.mjs';
import { presenceModule } from './modules/presence.mjs';
import { pendingMergeModule } from './modules/pending-merge.mjs';
import { endpointsModule } from './modules/endpoints.mjs';
import { createHandshakeAuth, isLoopbackAddress } from './auth.mjs';
import { isLocalOrigin, remoteTagOf } from '../http-guard.mjs';

export function createSharedDocService({
  dataDir = null,
  server,
  path: wsPath,
  isLoopback,
  remoteOf,
  now = Date.now,
  log,
  session,
  autoTick = true,
  sweepMs,
  queueDefaults,
} = {}) {
  const logger = typeof log === 'function'
    ? log
    : (event, fields) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);

  const loopbackOf = typeof isLoopback === 'function'
    ? isLoopback
    : (req) => isLocalOrigin(req) && isLoopbackAddress(req?.socket?.remoteAddress);
  const clientRemoteOf = typeof remoteOf === 'function' ? remoteOf : (req) => remoteTagOf(req);

  const auth = createHandshakeAuth({
    isLoopback: loopbackOf,
    remoteOf: clientRemoteOf,
    log: logger,
  });

  function spaceStore(space) {
    if (!dataDir) return createMemoryStore();
    const dir = space === LOCAL_SPACE ? dataDir : path.join(dataDir, 'spaces', space);
    return createFileStore({ dir, log: logger });
  }

  let docService = null;

  const queues = spacedModule({
    create: () => {
      const q = createRenderQueue({
        now,
        send: (connId, message) => docService?.send(connId, message),
        log: (event, fields) => logger(`queue.${event}`, fields),
        defaults: queueDefaults,
      });
      return renderQueueModule(q, sweepMs !== undefined ? { sweepMs } : {});
    },
    health: (list) => ({
      queue: true,
      publishers: list.reduce((n, [, h]) => n + (h.publishers ?? 0), 0),
      nodes: list.reduce((n, [, h]) => n + (h.nodes ?? 0), 0),
      spaces: list.length,
    }),
  });

  const bundles = new Map();
  function bundleForSpace(space) {
    let b = bundles.get(space);
    if (b) return b;
    const s = spaceStore(space);
    const project = projectModule({ store: s, now });
    const content = contentModule({ store: s, now });
    const costs = costsModule({ space, store: s, now });
    const presence = presenceModule({ project, now });
    const merge = pendingMergeModule({ store: s, now });
    const events = eventsModule({ project, content, now });
    b = { project, content, costs, presence, merge, events };
    bundles.set(space, b);
    return b;
  }

  const projects = spacedModule({ create: (space) => bundleForSpace(space).project });
  const contents = spacedModule({ create: (space) => bundleForSpace(space).content });
  const costs = spacedModule({ create: (space) => bundleForSpace(space).costs });
  const presences = spacedModule({ create: (space) => bundleForSpace(space).presence });
  const merges = spacedModule({ create: (space) => bundleForSpace(space).merge });
  const events = spacedModule({ create: (space) => bundleForSpace(space).events });
  const endpoints = endpointsModule();

  docService = createDocService({
    server,
    path: wsPath,
    log: logger,
    autoTick,
    session,
    authenticate: auth.authenticate,
    protocolFor: auth.protocolFor,
    modules: [endpoints, projects, contents, costs, presences, merges, events, queues],
  });

  return {
    service: docService,
    queues,
    projects,
    contents,
    costs,
    presences,
    merges,
    events,
    endpoints,
  };
}

export const createLocalDocService = createSharedDocService;
export default createSharedDocService;
