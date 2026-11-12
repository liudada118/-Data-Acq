import { pathToFileURL } from 'node:url';
import { inspectPackage, validateConfig, validFramePayload } from './contract.mjs';
import { createManagedMedia } from './media.mjs';
import { createManagedNative } from './native.mjs';
import { PLUGIN_STOP_TIMEOUT_MS } from './lifecycle.mjs';

if (!process.send) throw new Error('Plugin host requires application IPC');
let adapter, manifest, media, native, started = false, closing = false, failed = false;
let pendingBytes = 0, pendingCount = 0, serial = 0;
const pending = new Map();
const lastCameraFrames = new Map();
let cameraWatchdog, runtimeTelemetry;
const send = value => new Promise(resolve => {
  if (!process.connected) { resolve(); return; }
  process.send(value, error => { resolve(); if (error) process.exit(1); });
});
function fail(error) {
  if (failed || closing) return;
  failed = true;
  void send({ error: String(error?.message ?? error).slice(0, 1000) }).then(finish);
}
async function finish() {
  if (closing) return;
  closing = true;
  clearInterval(cameraWatchdog);
  clearInterval(runtimeTelemetry);
  const deadline = setTimeout(() => {
    void media?.close();
    void send({ shutdown_error: 'SDK stop timed out' }).then(() => process.exit(1));
  }, PLUGIN_STOP_TIMEOUT_MS);
  let exitCode = 0;
  try { await adapter?.stop(); }
  catch (error) { exitCode = 1; await send({ shutdown_error: `SDK stop failed: ${String(error?.message ?? error).slice(0, 800)}` }); }
  finally { await media?.close(); native?.close(); clearTimeout(deadline); process.exit(exitCode); }
}
function emit(frame) {
  if (!started || closing || failed) return false;
  try {
    const stream = manifest.streams.find(item => item.id === frame?.stream_id);
    if (!stream || !(frame.payload instanceof Uint8Array)) throw new Error('Adapter emitted unknown stream or non-binary payload');
    const samples = frame.sample_count ?? 1;
    if (!validFramePayload(stream, frame.payload, samples)) throw new Error('Adapter payload length does not match declared stream');
    const exactInteger = value => {
      if (typeof value === 'number' && !Number.isSafeInteger(value) || !['number', 'string', 'bigint'].includes(typeof value) || typeof value === 'string' && !/^-?\d+$/.test(value)) throw new Error('SDK timestamps and sequence must be exact integers');
      return BigInt(value).toString();
    };
    const timestamp = frame.device_time_ns === undefined ? undefined : exactInteger(frame.device_time_ns);
    const sequence = frame.sequence === undefined ? undefined : exactInteger(frame.sequence);
    if (timestamp?.length > 24 || sequence?.length > 24) throw new Error('Adapter timestamp or sequence exceeds supported range');
    if (pendingBytes + frame.payload.byteLength > 64 * 1024 * 1024 || pendingCount >= 32) throw new Error('Plugin IPC queue overflow; recording integrity cannot be guaranteed');
    const id = ++serial, bytes = frame.payload.byteLength;
    if (stream.kind === 'camera') lastCameraFrames.set(stream.id, performance.now());
    pending.set(id, bytes); pendingBytes += bytes; pendingCount++;
    // Advanced IPC serializes synchronously inside process.send(), before emit
    // returns to the driver. The serialization already snapshots reused buffers;
    // do not add another full RGB/JPEG copy or defer this send to a later task.
    const payload = Buffer.isBuffer(frame.payload) ? frame.payload : Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    send({ frame: { id, stream_id: stream.id, payload, sample_count: samples,
      device_time_ns: timestamp, source_sequence: sequence, host_time_ns: process.hrtime.bigint() } });
    return true;
  } catch (error) { fail(error); return false; }
}
process.on('message', async message => {
  if (message.ack && pending.has(message.ack)) { pendingBytes -= pending.get(message.ack); pendingCount--; pending.delete(message.ack); return; }
  if (message.stop) { await finish(); return; }
  if (!message.initialize || adapter || manifest) return;
  try {
    const details = await inspectPackage(message.initialize.directory);
    manifest = details.manifest;
    const config = validateConfig(manifest, message.initialize.config);
    const module = await import(pathToFileURL(details.entry).href);
    if (typeof module.createAdapter !== 'function') throw new Error('Adapter must export createAdapter');
    media = createManagedMedia({ manifest, emit, error: fail, probeOnly: message.initialize.probe === true });
    native = createManagedNative({ directory: details.directory });
    adapter = await module.createAdapter({ config, emit, error: fail, media: media.api, native: native.api });
    if (!adapter || typeof adapter.start !== 'function' || typeof adapter.stop !== 'function') throw new Error('Adapter must provide start and stop methods');
    if (message.initialize.probe) {
      const details = typeof adapter.probe === 'function' ? await adapter.probe() : { note: 'Module loaded; no probe supplied' };
      if (details?.ok === false || details?.passed === false) throw new Error(String(details.error ?? details.message ?? 'SDK dependency probe failed'));
      // A probe verifies loading, not physical acquisition; it never invokes start().
      const serialized = JSON.stringify(details ?? null);
      if (serialized.length > 16000) throw new Error('SDK probe result exceeds 16 KiB');
      await send({ ready: true, probe: { passed: true, module_loaded: true, probe_ran: typeof adapter.probe === 'function', hardware_verified: false,
        details: JSON.parse(serialized) } });
      await finish();
    } else {
      started = true;
      const reportRuntime = () => {
        const memory = process.memoryUsage();
        void send({ runtime_metrics: { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, external_bytes: memory.external,
          pending_frames: pendingCount, pending_bytes: pendingBytes } });
      };
      runtimeTelemetry = setInterval(reportRuntime, 5000).unref();
      reportRuntime();
      await adapter.start();
      if (!failed && !closing) {
        const connectedAt = performance.now();
        // Periodic cameras must not remain "connected" indefinitely if a
        // native wait API keeps returning null without reporting disconnection.
        const periodicCameras = manifest.streams.filter(stream => stream.kind === 'camera' && stream.sample_rate >= 1);
        if (periodicCameras.length) cameraWatchdog = setInterval(() => {
          for (const stream of periodicCameras) {
            if (performance.now() - (lastCameraFrames.get(stream.id) ?? connectedAt) >= 10000) {
              fail(new Error(`SDK camera stream ${stream.name} 连续 10 秒未收到有效帧，请检查相机连接。`));
              return;
            }
          }
        }, 500).unref();
        send({ ready: true });
      }
    }
  } catch (error) { fail(error); }
});
process.on('disconnect', () => void finish());
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
