import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SdkInstanceInfo, SdkReceiveHealth } from "./sdk-types";

export type ReceiveHealthState = "offline" | "disconnected" | "waiting" | "observing" | "normal" | "interrupted" | "unknown" | "error";
interface ReceiveHealthView {
  state: ReceiveHealthState;
  label: string;
  detail: string;
  ageMs: number | null;
  rateHz: number | null;
  windowMs: number | null;
}
const finiteNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function validTelemetry(value: SdkReceiveHealth): boolean {
  return finiteNonnegative(value.sampled_at_monotonic_ms) && finiteNonnegative(value.observed_ms) && finiteNonnegative(value.rate_window_ms) &&
    finiteNonnegative(value.frames_in_window) &&
    (value.last_frame_age_ms === null || finiteNonnegative(value.last_frame_age_ms)) &&
    (value.receive_rate_hz === null || finiteNonnegative(value.receive_rate_hz)) &&
    (value.interruption_threshold_ms === null || finiteNonnegative(value.interruption_threshold_ms) && value.interruption_threshold_ms > 0);
}

/** Interpret receive diagnostics, never recording validity or physical signal quality. */
export function sdkReceiveHealth(instance: SdkInstanceInfo | undefined, online: boolean,
  snapshotAgeMs: number, serviceError = ""): ReceiveHealthView {
  const empty = { ageMs: null, rateHz: null, windowMs: null };
  if (!online) return { ...empty, state: "offline", label: "服务不可用", detail: "无法确认设备当前是否仍在出帧，请恢复采集服务连接。" };
  if (serviceError) return { ...empty, state: "unknown", label: "接收状态未知", detail: "SDK 状态读取失败，请等待状态恢复；旧快照不能证明设备已停发。" };
  if (instance?.error) return { ...empty, state: "error", label: "设备连接异常", detail: "请查看本卡片的连接错误。" };
  if (instance?.connecting) return { ...empty, state: "waiting", label: "正在连接", detail: "连接完成后等待有效数据帧。" };
  if (!instance?.connected) return { ...empty, state: "disconnected", label: "未连接", detail: "请先连接此传感器。" };
  const telemetry = instance.receive_health;
  if (!telemetry || !validTelemetry(telemetry) || !finiteNonnegative(snapshotAgeMs) || snapshotAgeMs >= 10000)
    return { ...empty, state: "unknown", label: "接收状态未知", detail: "缺少可用的最新接收遥测，请等待状态刷新；不按旧快照判定设备中断。" };
  const ageMs = telemetry.last_frame_age_ms === null ? null : telemetry.last_frame_age_ms + snapshotAgeMs;
  // A delayed polling response cannot supply a current receive-rate window.
  const data = { ageMs, rateHz: snapshotAgeMs < 4000 ? telemetry.receive_rate_hz : null, windowMs: telemetry.rate_window_ms };
  if (ageMs === null) return { ...data, state: "waiting", label: "等待有效数据", detail: "串口连接成功后尚未收到有效帧，请检查设备是否正在发送数据。" };
  if (telemetry.interruption_threshold_ms === null) return { ...data, state: ageMs >= 30000 ? "unknown" : "observing",
    label: ageMs >= 30000 ? "较久未收新帧 · 频率未知" : "接收中 · 频率待观察",
    detail: "尚未建立接收间隔基线；设备可能低频或按需出帧，请结合最后有效帧时间判断。" };
  if (ageMs >= telemetry.interruption_threshold_ms) return { ...data, state: "interrupted", label: "数据中断 · 检查设备",
    detail: `已超过 ${Math.round(telemetry.interruption_threshold_ms / 1000)} 秒未收有效帧。阈值取至少 10 秒、最近接收间隔中位数的 4 倍；不会自动停止录制。` };
  return { ...data, state: "normal", label: "接收正常", detail: "有效帧在持续接收。此状态不代表信号已标定、无丢包或数据质量合格。" };
}

function ageLabel(ageMs: number | null, state: ReceiveHealthState): string {
  if (ageMs === null) return state === "waiting" ? "最近有效帧：尚未收到" : "最近有效帧：—";
  if (ageMs < 1000) return "最近有效帧：不到 1 秒";
  const seconds = Math.floor(ageMs / 1000);
  return `最近有效帧：${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}前`;
}

export function SdkReceiveHealthStatus({ instance, online, serviceError = "", children }: {
  instance?: SdkInstanceInfo; online: boolean; serviceError?: string; children?: ReactNode;
}) {
  const [, tick] = useState(0);
  const marker = instance?.receive_health?.sampled_at_monotonic_ms;
  const sample = useRef({ id: instance?.instance_id, marker, receivedAt: performance.now() });
  // HTTP can repeatedly return the same cached capture-process snapshot. Only a
  // genuinely newer monotonic sample may reset the freshness baseline.
  if (sample.current.id !== instance?.instance_id || sample.current.marker !== marker)
    sample.current = { id: instance?.instance_id, marker, receivedAt: performance.now() };
  useEffect(() => {
    // Independent of preview drawing, visibility, focus mode, and preview pause.
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const view = sdkReceiveHealth(instance, online, Math.max(0, performance.now() - sample.current.receivedAt), serviceError);
  const rate = view.rateHz === null ? "—" : `${view.rateHz.toFixed(1)} Hz`;
  return <div className="sdk-receive-health" data-health={view.state} aria-label="传感器接收状态">
    <span className="sdk-health-state" role="status" title={view.detail}>{view.label}</span>
    <span className="sdk-health-age" title="根据采集进程单调时钟计算；状态定时刷新。">{ageLabel(view.ageMs, view.state)}</span>
    <span className="sdk-health-rate" title={`按主机收到的有效帧计数${view.windowMs === null ? "" : `，本次窗口 ${(view.windowMs / 1000).toFixed(1)} 秒`}；不是设备标称采样率或丢包率。`}>窗口接收率：{rate}</span>
    {children}
  </div>;
}
