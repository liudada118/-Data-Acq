import { API_BASE } from "./api";
import type { JpegPreviewFrame } from "./jpeg-preview";

const MAX_HEADER_BYTES = 4096;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;

export interface CameraPreviewFrame extends JpegPreviewFrame {
  timestamp_s: number;
  jpeg_bytes: Uint8Array<ArrayBuffer>;
}

/** Read bounded packets without retaining a history of frames or network chunks. */
export async function readCameraPreviewStream(
  response: Response,
  signal: AbortSignal,
  receive: (frame: CameraPreviewFrame) => void,
): Promise<void> {
  if (!response.body) throw new Error("摄像机预览响应没有数据流");
  const reader = response.body.getReader();
  let chunk: Uint8Array = new Uint8Array(), offset = 0;
  const aborted = () => new DOMException("Camera preview cancelled", "AbortError");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });

  async function readExactly(length: number, boundary = false): Promise<Uint8Array<ArrayBuffer> | null> {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (signal.aborted) throw aborted();
      if (offset === chunk.length) {
        const next = await reader.read();
        if (signal.aborted) throw aborted();
        if (next.done) {
          if (boundary && written === 0) return null;
          throw new Error("摄像机预览数据包不完整");
        }
        chunk = next.value;
        offset = 0;
        if (!chunk.length) continue;
      }
      const count = Math.min(length - written, chunk.length - offset);
      result.set(chunk.subarray(offset, offset + count), written);
      offset += count;
      written += count;
    }
    return result;
  }

  try {
    if (signal.aborted) throw aborted();
    if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-shroom-camera")
      throw new Error("摄像机预览暂时不可用");
    while (!signal.aborted) {
      const prefix = await readExactly(4, true);
      if (!prefix) return;
      const length = new DataView(prefix.buffer).getUint32(0, true);
      if (length < 2 || length > MAX_HEADER_BYTES) throw new Error("摄像机预览包头超出限制");
      const encoded = await readExactly(length);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded!));
      if (!value || typeof value !== "object") throw new Error("摄像机预览包头无效");
      const header = value as Record<string, unknown>;
      const { sequence, width, height, timestamp_s, payload_bytes } = header;
      if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 ||
          typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
          typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 || width * height * 3 > 32 * 1024 * 1024 ||
          typeof timestamp_s !== "number" || !Number.isFinite(timestamp_s) || timestamp_s < 0 ||
          typeof payload_bytes !== "number" || !Number.isSafeInteger(payload_bytes) || payload_bytes < 1 || payload_bytes > MAX_JPEG_BYTES)
        throw new Error("摄像机预览尺寸或帧信息无效");
      const bytes = await readExactly(payload_bytes);
      if (signal.aborted) throw aborted();
      receive({ sequence, width, height, timestamp_s, jpeg_bytes: bytes! });
    }
    throw aborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A disconnected preview retries with bounded delays; capture has its own lifecycle. */
export function subscribeCameraPreview(
  streamId: string,
  receive: (frame: CameraPreviewFrame) => void,
  failure: (retrying: boolean) => void,
  retryDelaysMs: readonly number[] = [1000, 2000, 4000],
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry = 0;
  async function connect() {
    try {
      const response = await fetch(`${API_BASE}/api/preview/cameras/${encodeURIComponent(streamId)}?fps=30`, {
        signal: controller.signal, cache: "no-store",
      });
      await readCameraPreviewStream(response, controller.signal, frame => {
        retry = 0;
        receive(frame);
      });
      if (!controller.signal.aborted) throw new Error("Camera preview stream ended");
    } catch {
      if (controller.signal.aborted) return;
      const delay = retryDelaysMs[retry++];
      failure(delay !== undefined);
      if (delay !== undefined) timer = setTimeout(() => { void connect(); }, Math.max(1, delay));
    }
  }
  void connect();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
