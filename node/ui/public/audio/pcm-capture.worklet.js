/* No browser UI or network work runs on the audio rendering thread. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkFrames = Math.max(1, Math.round(sampleRate / 4));
    this.buffer = new ArrayBuffer(this.chunkFrames * 2);
    this.view = new DataView(this.buffer);
    this.frames = 0;
    this.index = 0;
    this.captureId = null;
    this.running = false;
    this.failed = false;
    this.disposed = false;
    this.pending = new Set();
    this.missingFrames = 0;
    this.port.onmessage = event => {
      const message = event.data;
      if (message?.type === 'dispose') { this.running = false; this.disposed = true; return; }
      if (message?.type === 'start' && typeof message.capture_id === 'string' && this.captureId === null) {
        this.captureId = message.capture_id;
        this.running = true;
        this.port.postMessage({ type: 'started', capture_id: this.captureId });
      } else if (message?.capture_id === this.captureId && message.type === 'ack') {
        this.pending.delete(message.index);
      } else if (message?.capture_id === this.captureId && message.type === 'stop') {
        this.running = false;
        if (!this.failed) this.flush();
        this.port.postMessage({ type: 'stopped', capture_id: this.captureId });
      }
    };
  }
  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.running = false;
    this.frames = 0;
    this.port.postMessage({ type: 'error', capture_id: this.captureId, error });
  }
  flush() {
    if (!this.frames || this.failed) return;
    // This also bounds messages waiting while the main thread is blocked.
    if (this.pending.size >= 32) { this.fail('麦克风上传缓冲已满，录制已中止。'); return; }
    const buffer = this.frames === this.chunkFrames ? this.buffer : this.buffer.slice(0, this.frames * 2);
    const index = this.index++;
    this.pending.add(index);
    this.port.postMessage({ type: 'chunk', capture_id: this.captureId, index, buffer }, [buffer]);
    this.buffer = new ArrayBuffer(this.chunkFrames * 2);
    this.view = new DataView(this.buffer);
    this.frames = 0;
  }
  process(inputs, outputs) {
    // The processing branch is silent, even if its downstream gain is changed.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.disposed) return false;
    if (!this.running || this.failed) return true;
    const channels = inputs[0];
    const length = channels?.[0]?.length ?? 0;
    if (!length) {
      this.missingFrames += outputs[0]?.[0]?.length ?? 0;
      if (this.missingFrames >= sampleRate) this.fail('麦克风没有持续提供音频数据，请检查设备连接。');
      return true;
    }
    this.missingFrames = 0;
    for (let frame = 0; frame < length && this.running; frame++) {
      let value = 0;
      for (const channel of channels) value += Number.isFinite(channel[frame]) ? channel[frame] : 0;
      value = Math.max(-1, Math.min(1, value / channels.length));
      const pcm = Math.round(value < 0 ? value * 32768 : value * 32767);
      this.view.setInt16(this.frames++ * 2, pcm, true);
      if (this.frames === this.chunkFrames) this.flush();
    }
    return true;
  }
}
registerProcessor('synapse-pcm-capture', PcmCaptureProcessor);
