import { workspaceViewportLayout } from "./viewport-layout";

/** Defaults fit the viewport; saved card dimensions are independent of these defaults. */
export function independentBoardDefaults(width: number, height: number, cameras: number, microphones: number, sensors: number, stackedSensors = false, replay = false) {
  const safeWidth = Math.max(1, width), safeHeight = Math.max(1, height);
  const hasMedia = cameras + microphones > 0, split = hasMedia && sensors > 0 && safeWidth >= 760;
  const maxMediaWidth = Math.max(1, safeWidth - (split ? 350 : 18));
  const mediaWidth = split ? Math.min(maxMediaWidth, Math.max(240, safeWidth * .38)) : maxMediaWidth;
  const sensorWidth = Math.max(1, safeWidth - (split ? mediaWidth + 28 : 0) - 18);
  const layout = workspaceViewportLayout(sensorWidth, safeHeight - 4, sensors, stackedSensors, replay ? sensorWidth < 620 ? 220 : 200 : undefined);
  const microphoneHeight = 160;
  const cameraHeight = Math.max(260, (safeHeight - 4 - microphones * microphoneHeight - Math.max(0, cameras + microphones - 1) * 10) / Math.max(1, cameras));
  return { split, maxMediaWidth, mediaWidth, cameraHeight, microphoneHeight, layout,
    sensorWidth: Math.max(1, (sensorWidth - Math.max(0, layout.columns - 1) * 10) / layout.columns),
    sensorHeight: Math.max(200, (safeHeight - 4 - Math.max(0, layout.rows - 1) * 10) / layout.rows) };
}
