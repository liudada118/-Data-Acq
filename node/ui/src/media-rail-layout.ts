export const MEDIA_LAYOUT_STORAGE_KEY = "shroom:media-layout:v2:live";
export const mediaLayoutStorageKey = (scope = "live") => `shroom:media-layout:v2:${encodeURIComponent(scope)}`;
export const DEFAULT_MEDIA_LAYOUT = Object.freeze({ widthRatio: .38, cameraRatio: .78 });
export type MediaLayoutPreferences = { widthRatio: number; cameraRatio: number };
export type MediaLayoutAxis = "width" | "camera";
export type MediaLayoutViewport = { width: number; height: number; cameraCount: number; audioCount: number; sensorCount: number; focused?: boolean };
export const clampRatio = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Keep preferences separate from viewport clamps so a narrow window does not erase them. */
export function normalizeMediaLayout(value: unknown): MediaLayoutPreferences {
  const candidate = value && typeof value === "object" ? value as Partial<MediaLayoutPreferences> : {};
  return {
    widthRatio: typeof candidate.widthRatio === "number" && Number.isFinite(candidate.widthRatio)
      ? clampRatio(candidate.widthRatio, .2, .6) : DEFAULT_MEDIA_LAYOUT.widthRatio,
    cameraRatio: typeof candidate.cameraRatio === "number" && Number.isFinite(candidate.cameraRatio)
      ? clampRatio(candidate.cameraRatio, .35, .92) : DEFAULT_MEDIA_LAYOUT.cameraRatio,
  };
}

export function mediaLayoutMetrics(viewport: MediaLayoutViewport, preferences: MediaLayoutPreferences) {
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height);
  const { cameraCount, audioCount, sensorCount, focused = false } = viewport;
  const hasMedia = cameraCount + audioCount > 0, hasSensors = sensorCount > 0, stacked = width < 760;
  const splitWidth = hasMedia && hasSensors && !stacked && !focused;
  const widthMin = splitWidth ? Math.max(.2, 240 / width) : .2;
  const widthMax = splitWidth ? Math.max(widthMin, Math.min(.6, (width - 332) / width)) : .6;
  const widthRatio = clampRatio(preferences.widthRatio, widthMin, widthMax);
  const railWidth = splitWidth ? width * widthRatio : width;
  const railHeight = stacked && hasMedia && hasSensors && !focused ? Math.max(1, (height - 10) * .56) : height;
  const splitHeight = cameraCount > 0 && audioCount > 0 && !focused;
  const items = cameraCount + audioCount + (splitHeight ? 1 : 0);
  const gap = Math.min(8, railHeight / Math.max(1, items * 4));
  const separatorHeight = splitHeight ? Math.min(12, railHeight / 4) : 0;
  const overhead = Math.max(0, items - 1) * gap + separatorHeight;
  const availableHeight = Math.max(0, railHeight - overhead);
  // Minimums become proportional on short viewports; they must never enlarge the rail.
  const minimumScale = Math.min(1, availableHeight / Math.max(1, cameraCount * 160 + audioCount * 128));
  const minCamera = cameraCount * 160 * minimumScale, minAudio = audioCount * 128 * minimumScale;
  const physicalMin = minCamera / Math.max(1, availableHeight), physicalMax = 1 - minAudio / Math.max(1, availableHeight);
  const cameraMin = splitHeight ? Math.min(physicalMax, Math.max(.35, physicalMin)) : .35;
  const cameraMax = splitHeight ? Math.max(cameraMin, Math.min(.92, physicalMax)) : .92;
  const cameraRatio = clampRatio(preferences.cameraRatio, cameraMin, cameraMax);
  return {
    stacked, splitWidth, splitHeight, widthMin, widthMax, widthRatio, cameraMin, cameraMax, cameraRatio,
    width, railWidth, railHeight, availableHeight, gap, separatorHeight,
    canResizeWidth: splitWidth && widthMax - widthMin > .005,
    canResizeCamera: splitHeight && cameraMax - cameraMin > .005,
    cameraHeight: cameraCount ? (audioCount ? availableHeight * cameraRatio : availableHeight) / cameraCount : 0,
    audioHeight: audioCount ? (cameraCount ? availableHeight * (1 - cameraRatio) : availableHeight) / audioCount : 0,
    sensorViewport: !hasMedia || !hasSensors || focused ? { width, height }
      : stacked ? { width, height: Math.max(1, (height - 10) * .44) } : { width: Math.max(1, width - railWidth - 12), height },
  };
}

/** Media never join sensor pages; pagination uses the same width as the CSS grid. */
export function sensorViewport(width: number, height: number, hasMedia: boolean, hasSensors: boolean, sensorFocused = false, widthRatio = DEFAULT_MEDIA_LAYOUT.widthRatio) {
  return mediaLayoutMetrics({ width, height, cameraCount: Number(hasMedia), audioCount: 0, sensorCount: Number(hasSensors), focused: sensorFocused }, { ...DEFAULT_MEDIA_LAYOUT, widthRatio }).sensorViewport;
}
