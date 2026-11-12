/** Remove Electron's IPC envelope without changing the underlying SDK error. */
export function agentErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return "操作失败，请重试。";
  return cause.message.replace(/^Error invoking remote method (['"])integration:[^'"\r\n]+\1:\s*(?:Error:\s*)?/, "") || "操作失败，请重试。";
}
