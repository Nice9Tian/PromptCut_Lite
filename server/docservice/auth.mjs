/**
 * Local loopback authentication and subprotocol parsing for the document service.
 *
 * - Loopback origin with nothing (or only `promptcut.v1`) -> local page principal `LOCAL_PRINCIPAL`;
 * - Loopback origin with `promptcut.v1` + `promptcut.role.agent.<conversationId>` -> local Agent principal;
 * - Non-loopback origins or other unauthorized subprotocol combinations are rejected (401).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const PROTOCOL = 'promptcut.v1';
export const TOKEN_PREFIX = 'promptcut.token.';
export const ROLE_PREFIX = 'promptcut.role.';

export const LOCAL_PRINCIPAL = Object.freeze({ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' });
export const ADMIN_PRINCIPAL = Object.freeze({ userId: 'admin', tenantId: null, scope: 'admin' });

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** Cluster token format: 32-256 base64url characters */
export const checkTokenFormat = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** Client-offered subprotocol list from handshake request (splits multiple headers and comma-separated entries) */
export function offeredProtocols(req) {
  const raw = req?.headers?.['sec-websocket-protocol'];
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Whether listen host is local loopback. Recognizes only `127.0.0.1`, `::1`, and `localhost` (case-insensitive).
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/** Loopback address (including IPv4-mapped IPv6) */
export function isLoopbackAddress(address) {
  const a = String(address ?? '').toLowerCase();
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest();
}

/**
 * Local loopback handshake authentication (compatible with loopback behavior of `createHandshakeAuth`).
 */
export function createHandshakeAuth({
  isLoopback = (req) => isLoopbackAddress(req?.socket?.remoteAddress),
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  log = () => {},
} = {}) {
  function authenticate(req) {
    const remote = remoteOf(req);
    const reject = (reason) => {
      log('auth.reject', { remote, reason });
      return null;
    };
    let loopback = false;
    try {
      loopback = !!isLoopback(req);
    } catch {
      loopback = false;
    }
    const offered = offeredProtocols(req);
    const items = offered.filter((p) => p !== PROTOCOL && !p.startsWith('promptcut.session.'));
    const roleItems = items.filter((p) => p.startsWith(ROLE_PREFIX));
    const otherItems = items.filter((p) => !p.startsWith(ROLE_PREFIX));

    if (otherItems.length > 1) return reject('multiple');
    if (otherItems.length > 0) return reject('no-credential');

    if (roleItems.length > 0) {
      if (!loopback) return reject('bad-format');
      if (roleItems.length > 1) return reject('multiple');
      if (!offered.includes(PROTOCOL)) return reject('bad-format');
      const m = /^agent\.([1-9][0-9]{0,14})$/.exec(roleItems[0].slice(ROLE_PREFIX.length));
      if (!m) return reject('bad-format');
      return { ...LOCAL_PRINCIPAL, role: 'agent', conversation: Number(m[1]) };
    }
    return loopback ? { ...LOCAL_PRINCIPAL } : reject('no-credential');
  }

  return {
    authenticate,
    protocolFor(req) {
      return offeredProtocols(req).includes(PROTOCOL) ? PROTOCOL : null;
    },
  };
}

export const createLocalLoopbackAuth = createHandshakeAuth;

/**
 * Builds `authenticate(req)` for `createDocService` (compatible with tests and standalone service).
 */
export function createTokenAuth({ token, allowAnonymous = false, log = () => {} } = {}) {
  const hasToken = token !== undefined && token !== null && token !== '';
  if (!hasToken && !allowAnonymous) {
    throw new Error('createTokenAuth: must provide token or explicitly set allowAnonymous: true (local loopback only)');
  }
  if (hasToken && !checkTokenFormat(token)) {
    throw new TypeError('createTokenAuth: invalid token format (expected 32-256 base64url characters)');
  }
  const expectedDigest = hasToken ? sha256(token) : null;

  return function authenticate(req) {
    const remote = req?.socket?.remoteAddress ?? null;
    const offered = offeredProtocols(req);
    const tokens = offered.filter((p) => p.startsWith(TOKEN_PREFIX));
    if (tokens.length > 1) {
      log('auth.reject', { remote, reason: 'multiple-tokens' });
      return null;
    }
    if (!hasToken) {
      return { ...ADMIN_PRINCIPAL };
    }
    if (!offered.includes(PROTOCOL) || tokens.length === 0) {
      log('auth.reject', { remote, reason: 'missing-token' });
      return null;
    }
    const given = tokens[0].slice(TOKEN_PREFIX.length);
    if (!checkTokenFormat(given)) {
      log('auth.reject', { remote, reason: 'bad-token-format' });
      return null;
    }
    const ok = timingSafeEqual(sha256(given), expectedDigest);
    if (!ok) {
      log('auth.reject', { remote, reason: 'bad-token' });
      return null;
    }
    return { ...ADMIN_PRINCIPAL };
  };
}
