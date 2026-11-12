/** Adapter registry: replace or add factories here to integrate real drivers.
 * A driver exposes descriptor, start(onBatch, onError), stop(), preview().
 * Each batch contains sequence, deviceTimeNs, hostTimeNs, sampleCount and Buffer payload.
 * Drivers own their clocks; they must never label host receipt time as hardware time.
 */
export const descriptors = [
  { id: 'sim-camera', kind: 'camera', name: '模拟摄像头', sample_rate: 15, batch_rate_hz: 15, batch_samples: 1, dtype: 'uint8', shape: [90, 160, 3], channels: 3, channel_names: [], units: [], unit: 'RGB8', width: 160, height: 90, metadata: { pixel_format: 'rgb8', width: 160, height: 90 } },
  { id: 'sim-audio', kind: 'audio', name: '模拟麦克风', sample_rate: 48000, batch_rate_hz: 100, batch_samples: 480, dtype: 'float32', shape: [1], channels: 1, channel_names: ['mono'], units: ['normalized'], unit: 'normalized', metadata: { encoding: 'pcm_f32le', channels: 1 } },
  { id: 'sim-pressure', kind: 'pressure', name: '模拟压力阵列', sample_rate: 100, batch_rate_hz: 100, batch_samples: 1, dtype: 'float32', shape: [16, 16], channels: 256, channel_names: [], units: ['kPa'], unit: 'kPa', rows: 16, cols: 16, metadata: { calibration: 'simulation-only', rows: 16, cols: 16 } },
  { id: 'sim-imu', kind: 'imu', name: '模拟六轴 IMU', sample_rate: 200, batch_rate_hz: 200, batch_samples: 1, dtype: 'float32', shape: [6], channels: 6, channel_names: ['ax', 'ay', 'az', 'gx', 'gy', 'gz'], units: ['m/s2', 'm/s2', 'm/s2', 'rad/s', 'rad/s', 'rad/s'], unit: 'm/s2', metadata: { coordinate_frame: 'simulated-right-handed' } },
].map(d => ({ ...d, device_id: d.id, modality: d.kind, sample_rate_hz: d.sample_rate, simulated: true, mode: 'simulated', connected: true, transport: 'Simulation', clock_id: 'node-simulation-monotonic', adapter: 'simulation', status: 'ready' }));

function floats(values) {
  const payload = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i++) payload.writeFloatLE(values[i], i * 4);
  return payload;
}

export class SimulatedAdapter {
  constructor(descriptor, origin) {
    this.descriptor = descriptor;
    this.origin = origin;
    this.sequence = 0n;
    this.latest = {};
    this.timer = null;
    this.overruns = 0;
  }
  start(onBatch, onError) {
    if (this.timer) throw new Error('Adapter already started');
    const period = BigInt(Math.round(1e9 / this.descriptor.batch_rate_hz));
    let due = process.hrtime.bigint() - this.origin;
    const tick = () => {
      try {
        const now = process.hrtime.bigint() - this.origin;
        let generated = 0;
        while (due <= now && generated++ < 32) {
          const batch = this.generate(this.sequence++, due, process.hrtime.bigint());
          due += period;
          onBatch(batch);
        }
        // Scheduled timestamps remain continuous. Lag is explicit in diagnostics.
        if (due <= now) this.overruns++;
      } catch (error) { onError(error); }
    };
    this.timer = setInterval(tick, 5);
    tick();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  preview() { return this.latest; }
  generate(sequence, deviceTimeNs, hostTimeNs) {
    const d = this.descriptor, t = Number(deviceTimeNs) / 1e9;
    let payload;
    if (d.kind === 'camera') {
      payload = Buffer.allocUnsafe(d.width * d.height * 3);
      const cx = 80 + 45 * Math.sin(t), cy = 45 + 22 * Math.cos(t * .8);
      for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) {
        const ball = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 140), p = (y * 160 + x) * 3;
        payload[p] = 20 + 30 * x / 160 + 130 * ball;
        payload[p + 1] = 35 + 50 * y / 90 + 150 * ball;
        payload[p + 2] = 48 + 90 * ball;
      }
      this.latest = { width: 160, height: 90, rgb_base64: payload.toString('base64'), sequence: Number(sequence) };
    } else if (d.kind === 'audio') {
      const values = Array.from({ length: 480 }, (_, i) => {
        const st = t + i / 48000;
        return .2 * Math.sin(2 * Math.PI * 220 * st) * (.6 + .4 * Math.sin(st * 2)) + .04 * Math.sin(2 * Math.PI * 440 * st);
      });
      payload = floats(values);
      this.latest = { waveform: values.filter((_, i) => i % 8 === 0), rms: Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length) };
    } else if (d.kind === 'pressure') {
      const values = Array.from({ length: 256 }, (_, i) => {
        const x = i % 16, y = Math.floor(i / 16), dx = x - 7.5 - 4 * Math.sin(t * .8), dy = y - 7.5 - 4 * Math.cos(t * .65);
        return 85 * Math.exp(-(dx * dx + dy * dy) / 9) + 3 * (1 + Math.sin(t * 2 + x * .4 + y * .3));
      });
      payload = floats(values);
      this.latest = { rows: 16, cols: 16, values };
    } else {
      const values = [.5 * Math.sin(t * 1.8), .3 * Math.cos(t * 1.3), 9.81 + .12 * Math.sin(t), .08 * Math.sin(t * 1.2), .1 * Math.cos(t), .05 * Math.sin(t * .7)];
      payload = floats(values);
      this.latest = { values };
    }
    return { streamId: d.id, sequence, deviceTimeNs, hostTimeNs, sampleCount: d.batch_samples, payload };
  }
}

export function createAdapters(origin) { return descriptors.map(d => new SimulatedAdapter(d, origin)); }
