/** Preview decoding is independent of capture. Keep one decode and only the latest waiting frame. */
export interface JpegPreviewFrame {
  sequence: number;
  width: number;
  height: number;
  timestamp_s?: number;
  jpeg_base64?: string;
  jpeg_bytes?: Uint8Array<ArrayBuffer>;
}

export class LatestJpegDecoder<T extends { close(): void }> {
  private pending?: JpegPreviewFrame;
  private last?: JpegPreviewFrame;
  private active = false;
  private disposed = false;
  private generation = 0;
  private readonly decode: (frame: JpegPreviewFrame) => Promise<T>;
  private readonly receive: (image: T, frame: JpegPreviewFrame) => void;
  private readonly failure: (error: unknown, frame: JpegPreviewFrame) => void;

  constructor(decode: (frame: JpegPreviewFrame) => Promise<T>,
    receive: (image: T, frame: JpegPreviewFrame) => void,
    failure: (error: unknown, frame: JpegPreviewFrame) => void) {
    this.decode = decode; this.receive = receive; this.failure = failure;
  }

  offer(frame: JpegPreviewFrame) {
    if (this.disposed || (this.last?.sequence === frame.sequence &&
        this.last.jpeg_base64 === frame.jpeg_base64 && this.last.jpeg_bytes === frame.jpeg_bytes)) return;
    this.last = frame;
    this.pending = frame;
    void this.pump();
  }

  reset() {
    this.generation++;
    this.pending = undefined;
    this.last = undefined;
  }

  dispose() { this.disposed = true; this.reset(); }

  private async pump() {
    if (this.active || this.disposed) return;
    this.active = true;
    try {
      while (this.pending && !this.disposed) {
        const frame = this.pending, generation = this.generation;
        this.pending = undefined;
        let image: T | undefined;
        try {
          image = await this.decode(frame);
          if (!this.disposed && generation === this.generation) this.receive(image, frame);
        } catch (error) {
          if (!this.disposed && generation === this.generation) this.failure(error, frame);
        } finally { image?.close(); }
      }
    } finally { this.active = false; }
  }
}

export async function decodeJpegPreview(frame: JpegPreviewFrame): Promise<ImageBitmap> {
  // Matches the runtime's bounded preview channel, independently of recording payload limits.
  if ((frame.jpeg_bytes?.byteLength ?? 0) > 2 * 1024 * 1024 ||
      (frame.jpeg_base64?.length ?? 0) > Math.ceil(2 * 1024 * 1024 / 3) * 4 || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) ||
      frame.width < 1 || frame.height < 1 || frame.width * frame.height * 3 > 32 * 1024 * 1024) throw new Error("JPEG 预览尺寸超出限制");
  let bytes = frame.jpeg_bytes;
  if (!bytes) {
    if (!frame.jpeg_base64) throw new Error("JPEG 预览没有图像数据");
    const binary = atob(frame.jpeg_base64);
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) throw new Error("JPEG 预览尺寸超出限制");
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  if (bitmap.width !== frame.width || bitmap.height !== frame.height) {
    bitmap.close();
    throw new Error("JPEG 实际尺寸与声明不一致");
  }
  return bitmap;
}
