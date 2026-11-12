/**
 * Write identity (`actor`): recorded by both project version log and content store
 * (semantics `docs/semantics/product/document-service.md` "Versions and Identities":
 * which page, or which chat of which Agent).
 *
 * Records `{ userId, deviceId, role, conversation, session }`, all taken from connection principal;
 * self-reported values in messages are never accepted; `session` is the page-reported session
 * identifier, kept for logging only.
 * Legacy principals without a connection role (test-injected `authenticate`) record only
 * `{ userId, session }`.
 */
export function actorOf(principal, session) {
  const userId = principal?.userId ?? null;
  if (principal?.role === undefined) return { userId, session };
  return {
    userId,
    deviceId: principal.deviceId ?? null,
    role: principal.role,
    conversation: principal.conversation ?? null,
    session,
  };
}
