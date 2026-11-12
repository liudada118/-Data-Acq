export type PressureRangeMode = "auto" | "fixed";

export interface PressureRangeSettings {
  mode: PressureRangeMode;
  /** Display-only upper bound; never applied to recorded samples. */
  maximum?: number;
}

export function isPressureMaximum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function defaultPressureMaximum(fullScale: unknown, dtype?: string): number {
  if (isPressureMaximum(fullScale)) return fullScale;
  return dtype === "uint16" ? 65535 : 255;
}

export function resolvePressureRange(settings: PressureRangeSettings | undefined, values: readonly number[], fallback = 255) {
  const fixed = settings?.mode === "fixed";
  const peak = values.reduce((maximum, value) => Number.isFinite(value) ? Math.max(maximum, value) : maximum, 1);
  const maximum = fixed
    ? isPressureMaximum(settings.maximum) ? settings.maximum : isPressureMaximum(fallback) ? fallback : 255
    : peak;
  return {
    maximum,
    above: values.filter(value => Number.isFinite(value) && value > maximum).length,
    below: values.filter(value => Number.isFinite(value) && value < 0).length,
  };
}

export function formatPressureMaximum(maximum: number): string {
  return String(maximum);
}
