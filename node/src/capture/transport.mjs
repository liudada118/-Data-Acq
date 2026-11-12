/** Child-process IPC only. SDK/native bindings execute in this process's main isolate. */
if (!process.send) throw new Error('Capture runtime must be started by the application');

let disconnected = false;
let disconnectHandler = () => process.exit(0);
let snapshotPending = false;
const cameraPreviews = new Map();
let cameraPreviewStreams = new Set();
process.on('disconnect', () => {
  disconnected = true;
  cameraPreviews.clear();
  disconnectHandler();
});

export const configuration = await new Promise(resolve => {
  process.once('message', message => {
    if (!message?.initialize || typeof message.initialize.dataDir !== 'string') process.exit(1);
    resolve(message.initialize);
  });
});

export function send(message, snapshotOnly = false) {
  if (!process.connected || disconnected || (snapshotOnly && snapshotPending)) return;
  if (snapshotOnly) snapshotPending = true;
  process.send(message, error => {
    if (snapshotOnly) snapshotPending = false;
    if (error && !disconnected) {
      disconnected = true;
      cameraPreviews.clear();
      disconnectHandler();
    }
  });
}

/** At most one sent and one latest waiting frame per stream, independent of recording. */
export function sendCameraPreview(frame) {
  if (!process.connected || disconnected || !cameraPreviewStreams.has(frame.stream_id)) return;
  const state = cameraPreviews.get(frame.stream_id);
  if (state) { state.latest = frame; return; }
  cameraPreviews.set(frame.stream_id, { latest: null });
  send({ camera_preview: frame });
}
process.on('message', message => {
  const streamId = message?.camera_preview_ack;
  const state = cameraPreviews.get(streamId);
  if (!state) return;
  cameraPreviews.delete(streamId);
  if (state.latest) sendCameraPreview(state.latest);
});

export function setCameraPreviewStreams(streamIds) {
  cameraPreviewStreams = new Set(streamIds);
  // Keep the in-flight marker until its ACK, but release obsolete queued bytes.
  for (const [streamId, state] of cameraPreviews) if (!cameraPreviewStreams.has(streamId)) state.latest = null;
}

export function onCameraPreviewSubscriptions(handler) {
  process.on('message', message => {
    if (Array.isArray(message?.camera_preview_subscriptions)) handler(message.camera_preview_subscriptions);
  });
}

export function onCommand(handler) {
  process.on('message', message => {
    if (message?.id && typeof message.action === 'string') handler(message);
  });
}

export function onParentDisconnect(handler) {
  disconnectHandler = handler;
  if (disconnected) handler();
}
