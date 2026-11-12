import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { activateSdkLicense } from './license.mjs';
import { captureGloveLayout } from '../glove-layout.mjs';
import { ReceiveTelemetry } from './receive-telemetry.mjs';

const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const INSOLE_BAUD_RATES = new Set([921600, 1500000, 3000000, 460800, 256000, 115200, 9600]);
const BODY_REGIONS = new Set(['back', 'chest', 'rightArm', 'rightShoulder', 'leftArm', 'leftShoulder',
  'backPantsRight', 'backPantsLeft', 'frontPantsLeft', 'frontPantsRight']);
function invariant(condition, message) { if (!condition) throw new Error(message); }
function indices(source, count, limit, saved) {
  invariant((ArrayBuffer.isView(source) || Array.isArray(source)) && source.length === count, 'SDK mapped source indices have an invalid length');
  if (saved) {
    invariant(saved.length === count && saved.every((value, index) => source[index] === value), 'SDK mapped ADC source indices changed during the connection');
    return saved;
  }
  const result = Array.from(source);
  invariant(result.every(value => Number.isSafeInteger(value) && value >= 0 && value < limit) && new Set(result).size === count,
    'SDK mapped source indices must be unique valid ADC channels');
  return result;
}
function mappedValues(source, adc, mapping) {
  invariant((ArrayBuffer.isView(source) || Array.isArray(source)) && source.length === mapping.length, 'SDK mapped ADC values have an invalid length');
  const values = Array.from(source);
  invariant(values.every((value, index) => value === adc[mapping[index]]), 'SDK mapped ADC values do not match raw channels');
  return values;
}
function bodyPreview(frame, adc, saved) {
  invariant(frame.product === 'humanBody' && frame.regions && Object.keys(frame.regions).length === 10, 'SDK body frame must contain ten physical regions');
  const regions = [], layouts = [], allIndices = [];
  for (const [id, region] of Object.entries(frame.regions)) {
    invariant(BODY_REGIONS.has(id) && region && Number.isInteger(region.rows) && Number.isInteger(region.cols) &&
      region.rows > 0 && region.cols > 0 && region.rows * region.cols <= 400 && typeof region.name === 'string' && region.name.length > 0 && region.name.length <= 80,
    'SDK body region shape is invalid');
    const prior = saved?.regions.find(item => item.id === id);
    if (saved) invariant(prior && prior.name === region.name && prior.rows === region.rows && prior.cols === region.cols, 'SDK body region layout changed during the connection');
    const mapping = indices(region.sourceIndices, region.rows * region.cols, 1024, prior?.source_indices);
    const values = mappedValues(region.raw, adc, mapping);
    regions.push({ id, name: region.name, rows: region.rows, cols: region.cols, values });
    if (!saved) {
      layouts.push({ id, name: region.name, rows: region.rows, cols: region.cols, source_indices: mapping });
      allIndices.push(...mapping);
    }
  }
  if (!saved) invariant(allIndices.length === 400 && new Set(allIndices).size === 400, 'SDK body regions must contain 400 distinct physical channels');
  return { extra: { regions }, layout: saved ?? { type: 'regions', regions: layouts } };
}
function insolePreview(frame, adc, state, saved) {
  invariant(frame.product === 'jqInsole' && frame.side === state.side && frame.protocol === state.protocol &&
    frame.bitDepth === (state.protocol === '12bit' ? 12 : 8) && frame.fullScale === (state.protocol === '12bit' ? 4095 : 255),
  'SDK insole frame does not match the selected foot or protocol');
  const sensors = frame.sensors;
  invariant(sensors?.rows === 14 && sensors?.cols === 8 && Array.isArray(sensors.positions) && sensors.positions.length === 112,
    'SDK insole frame must contain 112 physical sensor positions');
  const mapping = indices(sensors.sourceIndices, 112, 256, saved?.source_indices), values = mappedValues(sensors.raw, adc, mapping);
  const positions = sensors.positions.map((point, index) => {
    invariant(point && point.row === Math.floor(index / 8) && point.col === index % 8 &&
      Number.isFinite(point.xMm) && Number.isFinite(point.yMm) && Math.abs(point.xMm) <= 10000 && Math.abs(point.yMm) <= 10000,
    'SDK insole sensor coordinates are invalid');
    if (saved) {
      const prior = saved.positions[index];
      invariant(prior.x_mm === point.xMm && prior.y_mm === point.yMm, 'SDK insole coordinates changed during the connection');
      return prior;
    }
    return { row: point.row, col: point.col, x_mm: point.xMm, y_mm: point.yMm };
  });
  return { extra: { points: positions.map((point, index) => ({ ...point, value: values[index] })) },
    layout: saved ?? { type: 'points', source_indices: mapping, positions } };
}
/** Optional user-supplied Shroom SDK. Importing does not activate a license or open a port. */
export class SdkController {
  constructor({ sdkPath, origin, onBatch, onError, instanceId = 'default', ensureLicense }) {
    this.instanceId = instanceId;
    this.pressureId = instanceId === 'default' ? 'sdk-pressure' : `sdk-${instanceId}-pressure`;
    this.imuId = instanceId === 'default' ? 'sdk-imu-raw' : `sdk-${instanceId}-imu-raw`;
    this.ensureLicense = ensureLicense ?? activateSdkLicense;
    this.disabled = sdkPath === false;
    this.root = sdkPath ? path.resolve(sdkPath) : null;
    this.origin = origin;
    this.onBatch = onBatch;
    this.onError = onError;
    this.module = null;
    this.device = null;
    this.disconnecting = false;
    this.generation = 0;
    this.schemas = [];
    this.previews = {};
    this.receiveTelemetry = new ReceiveTelemetry(Number(process.hrtime.bigint() / 1000000n));
    this.state = { loaded: false, root: this.root, version: null, connected: false, connecting: false, device_id: null, product: null, path: null, frames: 0, last_frame_at: null, error: null, license_configured: Boolean(process.env.SHROOM_LICENSE_KEY || process.env.SHROOM_LICENSE_FILE) };
  }
  async init() {
    if (this.disabled) { this.state.error = 'SDK 已禁用'; return; }
    try {
      const entry = this.root ? pathToFileURL(path.join(this.root, 'node', 'index.js')).href : import.meta.resolve('shroom-sdk/node');
      this.state.source = this.root ? 'local' : 'npm';
      if (!this.root) this.root = fileURLToPath(new URL('../../', entry));
      this.state.root = this.root;
      this.module = await import(entry);
      if (!this.module.Shroom?.mock || !this.module.Shroom?.listPorts) throw new Error('SDK entry does not expose expected Shroom API');
      this.state.loaded = true;
      this.state.version = this.module.Shroom.version ?? null;
      this.state.error = null;
    } catch (error) { this.state.error = `SDK 加载失败：${error.code ?? error.message}`; }
  }
  info() { return { ...structuredClone(this.state), receive_health: this.receiveTelemetry.snapshot(Number(process.hrtime.bigint() / 1000000n)),
    instance_id: this.instanceId, stream_ids: this.schemas.map(schema => schema.id), has_device: Boolean(this.device) }; }
  descriptors() { return this.schemas.map(schema => ({ ...structuredClone(schema), connected: this.state.connected && this.state.ready !== false && !this.state.error })); }
  async ports() {
    if (!this.state.loaded) throw problem(this.state.error, 503);
    return this.module.Shroom.listPorts();
  }
  async connect(options) {
    if (!this.state.loaded) throw problem(this.state.error, 503);
    if (this.device) throw problem('SDK 设备已经连接，请先断开', 409);
    const requested = options?.mode === 'mock' ? 'mock' : options?.product;
    const product = ({ hand: 'hand-pad', pad: 'hand-pad', handGloveFullPacket: 'glove', handGloveSegmented: 'glove', humanBody: 'body', jqInsole: 'insole' })[requested] ?? requested;
    if (!['mock', 'hand-pad', 'glove', 'body', 'insole'].includes(product)) throw problem('请选择 hand-pad、glove、body、insole 或 mock');
    if (product !== 'mock' && (typeof options.path !== 'string' || !options.path.trim())) throw problem('真实设备必须选择串口');
    if (product === 'glove' && !['left', 'right'].includes(options.side)) throw problem('手套必须选择 left 或 right');
    if (product === 'insole' && !['left', 'right'].includes(options.side)) throw problem('鞋垫必须选择 left 或 right');
    if (product === 'body' && options.side !== undefined) throw problem('人体全身传感器不接受 side 参数');
    if (product !== 'insole' && (options.protocol !== undefined || options.baudRate !== undefined)) throw problem('protocol 和 baudRate 仅适用于鞋垫');
    if (product !== 'glove' && options.gloveProtocol !== undefined) throw problem('gloveProtocol 仅适用于手套');
    const simulated = product === 'mock', glove = product === 'glove', insole = product === 'insole', body = product === 'body';
    const explicitGloveProtocol = requested === 'handGloveFullPacket' ? 'full-packet' : requested === 'handGloveSegmented' ? 'segmented' : null;
    const gloveProtocol = glove ? options.gloveProtocol ?? explicitGloveProtocol ?? 'segmented' : null;
    if (glove && !['segmented', 'full-packet'].includes(gloveProtocol)) throw problem('手套 gloveProtocol 必须为 segmented 或 full-packet');
    if (explicitGloveProtocol && explicitGloveProtocol !== gloveProtocol) throw problem('手套产品与所选协议不一致');
    const protocol = insole ? options.protocol ?? '12bit' : gloveProtocol;
    const baudRate = insole ? options.baudRate ?? 921600 : glove ? 921600 : null;
    if (insole && !['12bit', '8bit'].includes(protocol)) throw problem('鞋垫 protocol 必须为 12bit 或 8bit');
    if (insole && !INSOLE_BAUD_RATES.has(baudRate)) throw problem('鞋垫波特率不受支持');
    const points = glove || insole ? 256 : 1024, fullScale = insole && protocol === '12bit' ? 4095 : 255;
    const imuBytes = glove ? 16 : insole ? protocol === '12bit' ? 40 : 16 : 0;
    const generation = ++this.generation;
    this.receiveTelemetry.reset(Number(process.hrtime.bigint() / 1000000n));
    this.state = { ...this.state, connected: false, connecting: true, ready: !body && !insole && !glove, connection_state: null, device_id: this.pressureId, product,
      path: simulated ? null : options.path, side: glove || insole ? options.side : null, protocol, gloveProtocol, baudRate,
      frames: 0, last_frame_at: null, error: null, mode: simulated ? 'sdk-mock' : 'hardware' };
    this.schemas = [{
      id: this.pressureId, device_id: this.pressureId, kind: 'pressure', modality: 'pressure',
      name: simulated ? 'Shroom SDK 模拟矩阵' : glove ? 'Shroom 手套原始压力' : body ? 'Shroom 人体全身' : insole ? `Shroom A版鞋垫（${options.side === 'left' ? '左脚' : '右脚'}）` : 'Shroom 手部检测垫',
      dtype: fullScale === 4095 ? 'uint16' : 'uint8', shape: [points], channels: points, channel_names: [], units: ['ADC'], unit: 'ADC',
      rows: glove ? 13 : insole ? 16 : 32, cols: glove ? 15 : insole ? 16 : 32,
      // Zero means unknown: each hardware frame carries its actual host receipt timestamp.
      sample_rate: simulated ? 20 : 0, sample_rate_hz: simulated ? 20 : 0, batch_samples: 1,
      sample_rate_known: simulated, irregular_timestamps: !simulated,
      mode: simulated ? 'sdk-mock' : 'hardware', simulated, connected: true,
      transport: simulated ? 'SDK mock' : 'Serial', adapter: 'shroom-sdk', clock_id: 'host-receive-monotonic',
      metadata: { instance_id: this.instanceId, product, side: this.state.side, protocol, baud_rate: baudRate, full_scale: fullScale,
        ...(product === 'hand-pad' ? { pressure_layout: { type: 'matrix', layout: 'mat32' } } : {}),
        port: simulated ? null : options.path, raw_order: 'SDK raw ADC scan order', preview_order: body ? 'SDK physical regions' : insole ? 'SDK physical sensor coordinates' : 'SDK mapped matrix', calibration: 'unscaled ADC; not physical pressure', sample_rate_note: simulated ? 'Configured SDK mock frame rate' : 'Unknown device rate; use per-frame receive timestamps', sdk_version: this.state.version },
    }];
    if (imuBytes) this.schemas.push({
      id: this.imuId, device_id: this.imuId, kind: 'imu', modality: 'imu', name: `${insole ? '鞋垫' : '手套'} IMU 原字节（未解析）`,
      dtype: 'uint8', shape: [imuBytes], channels: imuBytes, channel_names: [], units: ['raw-byte'], unit: 'raw-byte',
      sample_rate: 0, sample_rate_hz: 0, batch_samples: 1, sample_rate_known: false, irregular_timestamps: true,
      mode: 'hardware', simulated: false, connected: true, transport: 'Serial', adapter: 'shroom-sdk', clock_id: 'host-receive-monotonic',
      preview_supported: false, metadata: { instance_id: this.instanceId, product, side: options.side, protocol, baud_rate: baudRate, parsed: false, encoding: 'unparsed-imu-bytes', sample_rate_note: 'Unknown device rate; use per-frame receive timestamps' },
    });
    this.previews = {};
    const onData = frame => {
      if (generation !== this.generation || this.state.error || this.disconnecting) return;
      try { this.frame(frame, product); } catch (error) { this.error(error); }
    };
    const onError = error => { if (generation === this.generation) this.error(error); };
    const onStateChange = change => { if (generation === this.generation) this.connectionState(change); };
    try {
      if (simulated) {
        this.device = this.module.Shroom.mock({ rows: 32, cols: 32, fps: 20 });
        this.device.onFrame(onData);
        this.device.onError(onError);
      } else {
        await this.ensureLicense(this.module.Shroom);
        // SDK 0.2 enables product reconnection by default. A recording must not silently
        // join data from a new connection; this app retains explicit reconnect/start.
        const connection = { path: options.path, reconnect: false, onData, onError, onStateChange };
        if (glove && gloveProtocol === 'full-packet') {
          if (typeof this.module.Shroom.connectProduct !== 'function') throw new Error('当前 SDK 不支持显式整包手套，请安装 shroom-sdk 0.4.0 或更新版本');
          this.device = await this.module.Shroom.connectProduct({ ...connection, product: 'handGloveFullPacket', side: options.side });
        } else if (body || insole) {
          if (typeof this.module.Shroom.connectProduct !== 'function') throw new Error('当前 SDK 不支持新传感器，请安装 shroom-sdk 0.3.0 或更新版本');
          this.device = await this.module.Shroom.connectProduct({ ...connection, product,
            ...(insole ? { side: options.side, protocol, baudRate } : {}) });
        } else this.device = await (glove ? this.module.Shroom.connectGlove({ ...connection, side: options.side }) : this.module.Shroom.connectHandPad(connection));
      }
      if (this.state.error || this.device?.state === 'error' || this.device?.state === 'closed') throw new Error(this.state.error ?? 'SDK device closed while connecting');
      this.state.connected = true;
      this.state.connecting = false;
      return this.info();
    } catch (error) {
      if (this.device) {
        this.disconnecting = true;
        try { await this.device.close(); this.device = null; }
        catch { /* Keep ownership so a failed cleanup can be retried via disconnect. */ }
        finally { this.disconnecting = false; }
      }
      this.state.connected = false;
      this.schemas = [];
      this.error(error);
      throw problem(this.state.error, 422);
    } finally { this.state.connecting = false; }
  }
  connectionState(change) {
    const state = change?.state;
    if (!['open', 'closed', 'error', 'reconnecting'].includes(state)) return;
    // Only a successful explicit connect() clears the error/sets connected=true.
    if (state === 'open') {
      if (!this.state.error) this.state.connection_state = state;
      return;
    }
    this.state.connection_state = state;
    this.state.connected = false;
    this.previews = {};
    if (this.disconnecting && state === 'closed') return;
    this.error(Object.assign(new Error('SDK 设备连接已中断，请停止当前录制并手动重新连接。'), { code: state === 'closed' ? 'DISCONNECTED' : 'CONNECTION_FAILED' }));
  }
  error(error) {
    // Never expose SDK cause/details or environment secrets through public errors.
    this.state.error = [error?.code, error?.message].filter(Boolean).join(': ') || 'SDK error';
    if (process.env.SHROOM_LICENSE_KEY) this.state.error = this.state.error.replaceAll(process.env.SHROOM_LICENSE_KEY, '[redacted]');
    this.state.connected = false;
    this.previews = {};
    this.onError(new Error(this.state.error));
  }
  frame(frame, product) {
    const raw = frame.raw ?? frame.pressure;
    const insole = product === 'insole', wide = insole && this.state.protocol === '12bit';
    const expected = product === 'glove' ? 256 : insole ? wide ? 512 : 256 : 1024;
    if (!(raw instanceof Uint8Array) || raw.length !== expected) throw new Error(`SDK frame must contain ${expected} raw ADC bytes`);
    const adc = wide ? Array.from({ length: 256 }, (_, index) => raw[index * 2] | (raw[index * 2 + 1] << 8)) : Array.from(raw);
    const fullScale = wide ? 4095 : 255;
    invariant(adc.every(value => value <= fullScale), 'SDK ADC value exceeds the selected bit depth');
    if (insole) invariant(frame.pressure instanceof (wide ? Uint16Array : Uint8Array) && frame.pressure.length === 256 &&
      adc.every((value, index) => value === frame.pressure[index]), 'SDK insole raw bytes and ADC values disagree');
    let mapped;
    const savedLayout = this.schemas[0].metadata.pressure_layout;
    if (product === 'body') mapped = bodyPreview(frame, adc, savedLayout);
    if (product === 'glove') mapped = captureGloveLayout(frame, adc, this.state.side, savedLayout);
    if (insole) mapped = insolePreview(frame, adc, this.state, savedLayout);
    const imu = product === 'glove' || insole ? frame.imu?.raw ?? frame.imu : null;
    if (imu) invariant(imu instanceof Uint8Array && imu.length === (wide ? 40 : 16), `SDK ${product} frame has an invalid raw IMU length`);
    if (product === 'glove' || insole) invariant(imu instanceof Uint8Array, `SDK ${product} frame must contain raw IMU bytes`);
    let values = frame.pressureMatrix ? Array.from(frame.pressureMatrix).flatMap(v => typeof v === 'number' ? [v] : Array.from(v)) : Array.from(frame.values ?? [], value => value * (frame.fullScale ?? 255));
    const rows = frame.rows || (product === 'glove' ? 13 : insole ? 16 : 32), cols = frame.cols || (product === 'glove' ? 15 : insole ? 16 : 32);
    if (values.length !== rows * cols) values = product === 'glove' ? [] : adc;
    invariant(values.every(value => Number.isFinite(value) && value >= 0 && value <= fullScale), 'SDK preview ADC values are invalid');
    // Validate both pressure and IMU before accepting any part of the packet.
    if (mapped) this.schemas[0].metadata.pressure_layout ??= mapped.layout;
    const now = process.hrtime.bigint(), sequence = BigInt(this.state.frames++);
    this.receiveTelemetry.record(Number(now / 1000000n));
    this.state.last_frame_at = new Date().toISOString();
    this.state.ready = true;
    this.previews[this.pressureId] = { pressure: { rows, cols, values, full_scale: fullScale, ...mapped?.extra, unit: 'ADC', source: 'shroom-sdk' } };
    const metadata = { instance_id: this.instanceId, sequence: sequence.toString(), host_time_ns: now.toString(), sdk_timestamp_ms: frame.timestamp ?? null, sdk_sequence: frame.sequence ?? frame.seq ?? null, packet_type: frame.packetType ?? frame.packet_type ?? null, product, side: this.state.side, protocol: this.state.protocol };
    this.onBatch({ streamId: this.pressureId, sequence, deviceTimeNs: now - this.origin, hostTimeNs: now, sampleCount: 1, payload: Buffer.from(raw), metadata: { ...metadata, stream_id: this.pressureId } });
    if (imu) {
      this.previews[this.imuId] = { raw: { values: Array.from(imu), encoding: 'unparsed-imu-bytes' } };
      this.onBatch({ streamId: this.imuId, sequence, deviceTimeNs: now - this.origin, hostTimeNs: now, sampleCount: 1, payload: Buffer.from(imu), metadata: { ...metadata, stream_id: this.imuId } });
    }
  }
  async disconnect() {
    this.disconnecting = true;
    try { if (this.device) await this.device.close(); }
    catch (error) { this.error(error); throw error; }
    finally { this.disconnecting = false; }
    this.device = null;
    this.generation++;
    this.schemas = [];
    this.previews = {};
    this.state.connected = false;
    return this.info();
  }
}
