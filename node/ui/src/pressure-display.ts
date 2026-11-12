import { isPressureMaximum } from "./pressure-range";
import type { PressureRangeSettings } from "./pressure-range";

export type PressureDisplayMode = "heatmap" | "numbers";
export const PRESSURE_DISPLAY_KEY = "synapse-node.pressure-display.v1";
export const PRESSURE_RANGE_KEY = "synapse-node.pressure-range.v1";

function readModes(): Record<string, PressureDisplayMode> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PRESSURE_DISPLAY_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, mode]) => key.length <= 200 && (mode === "heatmap" || mode === "numbers")).slice(-64));
  } catch { return {}; }
}

export function readPressureDisplay(deviceId: string, fallback: PressureDisplayMode = "heatmap"): PressureDisplayMode {
  const mode = readModes()[deviceId];
  return mode === "numbers" || mode === "heatmap" ? mode : fallback;
}

export function savePressureDisplay(deviceId: string, mode: PressureDisplayMode) {
  try {
    const entries = Object.entries(readModes()).filter(([key]) => key !== deviceId).slice(-63);
    window.localStorage.setItem(PRESSURE_DISPLAY_KEY, JSON.stringify(Object.fromEntries([...entries, [deviceId, mode]])));
  } catch { /* Rendering remains available when browser storage is disabled. */ }
}

function readRanges(): Record<string, PressureRangeSettings> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PRESSURE_RANGE_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const ranges: [string, PressureRangeSettings][] = [];
    for (const [key, candidate] of Object.entries(value)) {
      if (!key || key.length > 200 || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const range = candidate as Partial<PressureRangeSettings>;
      if (range.mode !== "auto" && range.mode !== "fixed") continue;
      if (range.mode === "fixed" && !isPressureMaximum(range.maximum)) continue;
      ranges.push([key, { mode: range.mode, ...(isPressureMaximum(range.maximum) ? { maximum: range.maximum } : {}) }]);
    }
    return Object.fromEntries(ranges.slice(-64));
  } catch { return {}; }
}

export function readPressureRange(deviceId: string): PressureRangeSettings {
  const ranges = readRanges();
  return Object.hasOwn(ranges, deviceId) ? ranges[deviceId] : { mode: "auto" };
}

export function savePressureRange(deviceId: string, settings: PressureRangeSettings) {
  if (!deviceId || deviceId.length > 200 ||
    (settings.mode !== "auto" && settings.mode !== "fixed") ||
    (settings.mode === "fixed" && !isPressureMaximum(settings.maximum))) return;
  try {
    const range = { mode: settings.mode, ...(isPressureMaximum(settings.maximum) ? { maximum: settings.maximum } : {}) };
    const entries = Object.entries(readRanges()).filter(([key]) => key !== deviceId).slice(-63);
    window.localStorage.setItem(PRESSURE_RANGE_KEY, JSON.stringify(Object.fromEntries([...entries, [deviceId, range]])));
  } catch { /* Display settings must work without local storage. */ }
}
