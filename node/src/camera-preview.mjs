const SAFE_STREAM_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
export const CAMERA_PREVIEW_MIME = 'application/x-shroom-camera';
export const MAX_CAMERA_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_CAMERA_PREVIEW_HEADER_BYTES = 4096;
const MAX_CLIENTS = 8;
const MAX_STREAM_CLIENTS = 4;

const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });

function packet(frame, streamId) {
  if (!frame || frame.stream_id !== streamId || !(frame.payload instanceof Uint8Array)
    || frame.payload.byteLength < 1 || frame.payload.byteLength > MAX_CAMERA_PREVIEW_BYTES
    || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0
    || !Number.isSafeInteger(frame.width) || frame.width < 1
    || !Number.isSafeInteger(frame.height) || frame.height < 1
    || !Number.isFinite(frame.timestamp_s) || frame.timestamp_s < 0) return null;
  const header = Buffer.from(JSON.stringify({ sequence: frame.sequence, width: frame.width, height: frame.height,
    timestamp_s: frame.timestamp_s, payload_bytes: frame.payload.byteLength }), 'utf8');
  if (header.byteLength > MAX_CAMERA_PREVIEW_HEADER_BYTES) return null;
  const prefix = Buffer.allocUnsafe(4 + header.byteLength);
  prefix.writeUInt32LE(header.byteLength); header.copy(prefix, 4);
  // The capture process owns these bytes. Keep a view, rather than copying a JPEG
  // into a new packet for every viewer; each response queues at most one packet.
  return { prefix, payload: Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength) };
}

/** Binary live preview only; recording and session control never depend on clients. */
export class CameraPreviewService {
  constructor({ capture }) {
    this.capture = capture;
    this.clients = new Set();
    this.closed = false;
  }

  open(request, response, streamId, requestedFps = 30) {
    if (this.closed) throw failure('摄像机预览正在退出。', 503);
    if (!SAFE_STREAM_ID.test(streamId)) throw failure('无效的摄像机流 ID。', 400);
    const fps = Number(requestedFps);
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw failure('预览帧率必须为 1–30 的整数。', 400);
    const device = this.capture.devices().find(item => item.id === streamId);
    if (!device) throw failure('摄像机流不存在。', 404);
    if (!device.connected) throw failure('摄像机尚未连接。', 409);
    if (device.mode !== 'sdk-plugin' || (device.kind !== 'camera' && device.modality !== 'camera')
      || (device.encoding ?? device.metadata?.encoding ?? device.metadata?.pixel_format) !== 'mjpeg') {
      throw failure('该数据流不支持 MJPEG 实时预览。', 415);
    }
    if (this.clients.size >= MAX_CLIENTS || [...this.clients].filter(client => client.streamId === streamId).length >= MAX_STREAM_CLIENTS) {
      throw failure('摄像机预览连接数已达上限。', 429);
    }

    const client = { streamId, pending: null, blocked: false, ended: false, unsubscribe: null, close: null };
    const cleanup = () => {
      if (client.ended) return;
      client.ended = true; client.pending = null;
      this.clients.delete(client);
      response.removeListener('drain', drain);
      response.removeListener('close', cleanup);
      response.removeListener('error', cleanup);
      request.removeListener('aborted', cleanup);
      request.removeListener('error', cleanup);
      client.unsubscribe?.(); client.unsubscribe = null;
    };
    client.close = () => { cleanup(); response.destroy(); };
    const write = value => {
      if (client.ended) return;
      try {
        response.cork();
        const prefixAccepted = response.write(value.prefix);
        const payloadAccepted = response.write(value.payload);
        client.blocked = !prefixAccepted || !payloadAccepted;
      } catch { client.close(); }
      finally { response.uncork(); }
    };
    const drain = () => {
      client.blocked = false;
      const pending = client.pending; client.pending = null;
      if (pending) write(pending);
    };
    const receive = frame => {
      if (client.ended) return;
      const value = packet(frame, streamId);
      if (!value) return;
      if (client.blocked) client.pending = value;
      else write(value);
    };

    this.clients.add(client);
    response.on('drain', drain);
    response.once('close', cleanup);
    response.once('error', cleanup);
    request.once('aborted', cleanup);
    request.once('error', cleanup);
    try {
      response.writeHead(200, { 'Content-Type': CAMERA_PREVIEW_MIME, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const unsubscribe = this.capture.subscribeCameraPreview(streamId, receive, fps);
      if (client.ended) unsubscribe();
      else client.unsubscribe = unsubscribe;
      response.flushHeaders();
    } catch (error) { client.close(); throw error; }
    return cleanup;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const client of [...this.clients]) client.close();
  }
}
