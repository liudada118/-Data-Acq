import type { Device } from "./types";

/** Presentation only: recorded source names and device identities stay intact. */
export function sensorDisplayName(name: string): string {
  return name.trim().replace(/^shroom(?:[\s·:_-]+|(?=[\u3400-\u9fff])|$)/i, "").trim() || "传感器";
}

export function isSimulatedDevice(device: Device) {
  return device.mode === "simulated" || device.mode === "sdk-mock";
}

export function deviceModeLabel(device: Device) {
  if (device.mode === "browser-camera") return "系统摄像头";
  if (device.mode === "sdk-mock") return "SDK 模拟";
  return isSimulatedDevice(device) ? "模拟" : "SDK 硬件";
}

export function deviceSampleRate(device: Device) {
  if (device.sample_rate_known === false || device.sample_rate <= 0)
    return "按帧 · 频率未知";
  return device.kind === "audio"
    ? `${device.sample_rate / 1000} kHz`
    : `${device.sample_rate} ${device.kind === "camera" ? "fps" : "Hz"}`;
}
