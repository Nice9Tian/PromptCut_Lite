/**
 * 文档服务的本机回环鉴权与子协议解析。
 *
 * - 回环来源什么都不带（或只带 `promptcut.v1`）→ 本机页面身份 `LOCAL_PRINCIPAL`；
 * - 回环来源带 `promptcut.v1` + `promptcut.role.agent.<对话号>` → 本机 Agent 身份；
 * - 非回环来源或其它未授权子协议组合一律拒绝（401）。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const PROTOCOL = 'promptcut.v1';
export const TOKEN_PREFIX = 'promptcut.token.';
export const ROLE_PREFIX = 'promptcut.role.';

export const LOCAL_PRINCIPAL = Object.freeze({ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' });
export const ADMIN_PRINCIPAL = Object.freeze({ userId: 'admin', tenantId: null, scope: 'admin' });

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** 集群令牌格式：base64url 字符，32～256 个 */
export const checkTokenFormat = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** 握手请求里客户端给的子协议列表（多个头、逗号分隔都拆开） */
export function offeredProtocols(req) {
  const raw = req?.headers?.['sec-websocket-protocol'];
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * 监听地址是不是本机回环。只认 `127.0.0.1`、`::1`、`localhost`（大小写不敏感）。
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/** 回环地址（含 IPv4 映射的 IPv6） */
export function isLoopbackAddress(address) {
  const a = String(address ?? '').toLowerCase();
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest();
}

/**
 * 本机回环握手鉴权（兼容 `createHandshakeAuth` 的回环行为）。
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
 * 构造给 `createDocService` 用的 `authenticate(req)`（测试与独立服务兼容）。
 */
export function createTokenAuth({ token, allowAnonymous = false, log = () => {} } = {}) {
  const hasToken = token !== undefined && token !== null && token !== '';
  if (!hasToken && !allowAnonymous) {
    throw new Error('createTokenAuth: 必须给 token，或显式设 allowAnonymous: true（仅本机回环）');
  }
  if (hasToken && !checkTokenFormat(token)) {
    throw new TypeError('createTokenAuth: 令牌格式不对（要 32～256 个 base64url 字符）');
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
