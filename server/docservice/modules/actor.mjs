/**
 * 写入身份（`actor`）：项目版本日志、内容库都记它（语义 `docs/semantics/product/document-service.md`
 * 「版本与身份」：哪个页面，或哪个 Agent 的哪个对话）。
 *
 * 记 `{ userId, deviceId, role, conversation, session }`，全部取自连接的
 * principal，消息里自报的一律不认；`session` 是页面自报的会话标识，只作记录。
 * 不带连接角色的旧式 principal（测试注入的 `authenticate`）只记 `{ userId, session }`。
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
