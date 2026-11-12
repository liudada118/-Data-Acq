import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_API_VERSION = 1;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const sizes = { uint8: 1, uint16: 2, float32: 4 };
const problem = message => Object.assign(new Error(message), { statusCode: 400 });
const text = (value, max = 120) => typeof value === 'string' && value.length > 0 && value.length <= max;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function safeRelative(value) {
  if (!text(value, 240) || value.includes('\\') || value.includes(':') || value.includes('\0') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw problem('Invalid plugin relative path');
  return value;
}

/** Declarative validation only: this function never imports or executes vendor code. */
export function validateManifest(input) {
  if (!object(input) || input.api_version !== 1 || !ID_PATTERN.test(input.id ?? '') || !text(input.name) || !text(input.version, 64) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.version ?? '')) throw problem('Plugin requires api_version: 1, safe id, name and semantic version');
  const entry = safeRelative(input.entry);
  if (!/\.(mjs|js|cjs)$/.test(entry)) throw problem('Plugin entry must be a JavaScript module');
  if (!Array.isArray(input.streams) || input.streams.length < 1 || input.streams.length > 8) throw problem('Plugin requires 1–8 streams');
  const ids = new Set();
  const streams = input.streams.map(source => {
    if (!object(source) || !ID_PATTERN.test(source.id ?? '') || ids.has(source.id) || !text(source.name) || !['camera', 'audio', 'pressure', 'imu'].includes(source.kind)) throw problem('Invalid or duplicate plugin stream');
    ids.add(source.id);
    if (!sizes[source.dtype] || !Array.isArray(source.shape) || !source.shape.length || source.shape.length > 3 || source.shape.some(n => !Number.isSafeInteger(n) || n < 1)) throw problem('Invalid plugin dtype or shape');
    const elements = source.shape.reduce((a, b) => a * b, 1);
    if (!Number.isSafeInteger(elements) || elements * sizes[source.dtype] > MAX_FRAME_BYTES) throw problem('Plugin frame is too large');
    const rate = source.sample_rate ?? 0;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1e7) throw problem('Invalid sample rate');
    if (source.kind === 'camera' && (source.dtype !== 'uint8' || source.shape.length !== 3 || source.shape[2] !== 3)) throw problem('Camera v1 requires RGB8 shape [height,width,3]');
    const encoding = source.kind === 'camera' ? source.encoding ?? 'rgb8' : undefined;
    if (source.kind === 'camera' ? !['rgb8', 'mjpeg'].includes(encoding) : source.encoding !== undefined) throw problem('Only camera streams support encoding rgb8 or mjpeg');
    if (source.kind === 'pressure' && source.shape.length !== 2) throw problem('Pressure v1 requires shape [rows,cols]');
    if (source.kind === 'pressure' && elements > 65536) throw problem('Pressure v1 preview supports at most 65536 channels');
    if (source.kind === 'imu' && elements > 256) throw problem('IMU v1 supports at most 256 channels');
    if (source.kind === 'audio' && (source.dtype !== 'float32' || source.shape.length !== 1 || elements > 8 || rate < 8000 || rate > 384000)) throw problem('Audio v1 requires float32 channels and a known sample rate');
    const unit = source.unit ?? (source.kind === 'camera' ? encoding === 'mjpeg' ? 'MJPEG' : 'RGB8' : '');
    if (typeof unit !== 'string' || unit.length > 40) throw problem('Invalid unit');
    return { id: source.id, name: source.name, kind: source.kind, dtype: source.dtype, shape: [...source.shape],
      sample_rate: rate, sample_rate_hz: rate, sample_rate_known: rate > 0, irregular_timestamps: true,
      channels: source.kind === 'camera' ? 3 : elements, channel_names: [], unit, units: [unit], batch_samples: 1,
      ...(source.kind === 'camera' ? { encoding, width: source.shape[1], height: source.shape[0], metadata: { pixel_format: encoding, encoding, width: source.shape[1], height: source.shape[0] } } : {}),
      ...(source.kind === 'pressure' ? { rows: source.shape[0], cols: source.shape[1] } : {}) };
  });
  const configFields = input.config_fields ?? [];
  if (!Array.isArray(configFields) || configFields.length > 24) throw problem('Invalid config_fields');
  const keys = new Set();
  const config_fields = configFields.map(field => {
    if (!object(field) || !ID_PATTERN.test(field.key ?? '') || keys.has(field.key) || ['__proto__', 'constructor', 'prototype'].includes(field.key) || !text(field.label) || !['string', 'number', 'boolean'].includes(field.type)) throw problem('Invalid plugin configuration field');
    keys.add(field.key);
    if (field.default !== undefined && !validValue(field.default, field.type)) throw problem('Invalid configuration default');
    return { key: field.key, label: field.label, type: field.type, required: field.required === true,
      ...(field.default !== undefined ? { default: field.default } : {}) };
  });
  return { api_version: 1, id: input.id, name: input.name, version: input.version, entry, streams, config_fields,
    description: typeof input.description === 'string' ? input.description.slice(0, 2000) : '' };
}
function validValue(value, type) { return typeof value === type && (type === 'string' ? value.length <= 2048 : type === 'number' ? Number.isFinite(value) : true); }
export function validateConfig(manifest, supplied = {}) {
  if (!object(supplied) || Object.keys(supplied).some(key => !manifest.config_fields.some(field => field.key === key))) throw problem('Unknown plugin configuration field');
  const result = {};
  for (const field of manifest.config_fields) {
    const value = supplied[field.key] ?? field.default;
    if (value === undefined || value === '') { if (field.required) throw problem(`Missing configuration: ${field.label}`); continue; }
    if (!validValue(value, field.type)) throw problem(`Invalid configuration: ${field.label}`);
    result[field.key] = value;
  }
  return result;
}
export function bytesPerSample(stream) { return sizes[stream.dtype] * stream.shape.reduce((a, b) => a * b, 1); }
export function isMjpegStream(stream) { return stream.kind === 'camera' && (stream.encoding ?? stream.metadata?.encoding) === 'mjpeg'; }

/** MJPEG shape describes decoded RGB dimensions; its recorded payload is one original, variable-length JPEG. */
export function validFramePayload(stream, payload, samples) {
  if (!(payload instanceof Uint8Array) || !Number.isSafeInteger(samples) || samples < 1 || samples > 1e6 || payload.byteLength > MAX_FRAME_BYTES || (stream.kind === 'camera' && samples !== 1)) return false;
  return isMjpegStream(stream) ? payload.byteLength > 0 : payload.byteLength === bytesPerSample(stream) * samples;
}

export async function inspectPackage(directory) {
  const root = path.resolve(directory);
  if (!(await lstat(root)).isDirectory() || path.resolve(await realpath(root)) !== root) throw problem('Plugin directory must not be a symbolic link');
  const filename = path.join(root, 'plugin.json');
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw problem('Invalid plugin manifest file');
  const manifest = validateManifest(JSON.parse(await readFile(filename, 'utf8')));
  const entry = path.join(root, manifest.entry);
  const entryInfo = await lstat(entry);
  const resolved = await realpath(entry);
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || !resolved.startsWith(root + path.sep) || resolved !== entry) throw problem('Plugin entry escapes package');
  return { manifest, directory: root, entry };
}
