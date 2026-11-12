/** Translate connection failures without claiming that access denial proves port ownership. */
export function sdkConnectionErrorMessage(cause: unknown, path?: string): string {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "连接失败，请重试。";
  const port = path?.trim() ? `串口 ${path.trim()}` : "串口";
  // License failures can also mention permissions; keep their specific diagnosis.
  if (/^LICENSE_[A-Z_]+\b/.test(message)) return message;
  if (/^PORT_BUSY\b|\bEBUSY\b|resource busy|port.*(?:busy|in use)|cannot lock/i.test(message))
    return `${port}已被占用。请关闭占用它的串口助手、其他采集软件或另一个工作台连接，再重试。`;
  if (/^PERMISSION_DENIED\b|\b(?:EACCES|EPERM)\b|permission denied|access (?:is )?denied/i.test(message))
    return `无法打开${port}：可能被其他程序占用，或没有访问权限。请关闭占用程序并确认串口权限后重试。`;
  if (/^PORT_NOT_FOUND\b|\bENOENT\b|no such file|port.*not found/i.test(message))
    return `找不到${port}。请检查设备供电和 USB 连接，刷新串口列表后重新选择。`;
  if ((cause instanceof Error && cause.name === "TimeoutError") || /^REQUEST_TIMEOUT\b|timed?\s*out|timeout/i.test(message))
    return `${port}连接请求超时，尚未确认是否连接成功。请查看卡片连接状态，确认设备和采集服务正常后再重试。`;
  if (/failed to fetch|networkerror|network request failed|fetch failed/i.test(message))
    return "无法联系采集服务，连接结果尚未确认。请确认本地采集服务正在运行，恢复连接后再查看设备状态。";
  return message;
}
