import { createHash } from 'node:crypto';
import { GUIDE_FILES, sourceInfo } from './package-guide.mjs';

const asString = value => typeof value === 'string' ? value : '';
const objects = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 8);
const key = value => value.normalize('NFKC').toLowerCase();
const reserved = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const shorten = (value, count) => Array.from(value).slice(0, count).join('');
function shortenUnits(value, maximum) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maximum) break;
    result += character;
  }
  return result;
}

function fitComponent(stem, extension, collisionSuffix = '') {
  const available = 255 - extension.length - collisionSuffix.length;
  if (available < 1) throw new TypeError('Package filename extension exceeds Windows component limit');
  const dataSuffix = stem.match(/_(?:压力|IMU原始字节|IMU|分段(?:\d+|未知_[a-f0-9]{8}))$/)?.[0] ?? '';
  const fitted = stem.length <= available ? stem
    : dataSuffix && dataSuffix.length < available
      ? shortenUnits(stem.slice(0, -dataSuffix.length), available - dataSuffix.length) + dataSuffix
      : shortenUnits(stem, available);
  return fitted + collisionSuffix + extension;
}

/** A single Windows-safe Unicode path component, without path or reserved-name semantics. */
export function safePackageName(value, fallback = '传感器') {
  let name = asString(value).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().replace(/[ .]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (reserved.test(name)) name = `设备_${name}`;
  return shorten(name, 100).replace(/[ .]+$/g, '') || fallback;
}

const archiveTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function recordingTime(value) {
  // Require an explicit offset. A timezone-less date must not depend on the server's timezone.
  const fields = asString(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/i);
  if (!fields) return '时间未知';
  const [, year, month, day, hour, minute, second, , zoneHour = '0', zoneMinute = '0'] = fields;
  const calendar = new Date(0); calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (Number(year) < 1 || calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month)
    || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(zoneHour) > 23 || Number(zoneMinute) > 59) return '时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const parts = Object.fromEntries(archiveTime.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}

/** Display/download filename only; archives are still stored internally under the job ID. */
export function createExportArchiveName({ name, started_at, format, recovery = false, sequence = 1 } = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999999) throw new TypeError('Invalid export filename sequence');
  const label = /^[a-z0-9]{1,16}$/i.test(asString(format)) ? format.toUpperCase() : 'DATA';
  const base = safePackageName(asString(name).replace(/[\\/]/g, '-'), '未命名录制');
  const suffix = `_${recordingTime(started_at)}_${label}${recovery ? '_数据不完整' : ''}${sequence > 1 ? `_${sequence}` : ''}.zip`;
  return fitComponent(base, suffix);
}

export function allocateExportArchiveName(options, existingNames = []) {
  const used = new Set(existingNames.filter(name => typeof name === 'string').map(key));
  for (let sequence = 1; sequence <= 999999; sequence++) {
    const filename = createExportArchiveName({ ...options, sequence });
    if (!used.has(key(filename))) return { filename, sequence };
  }
  throw new Error('Export filename sequence exhausted');
}

function relativePath(value) {
  if (typeof value !== 'string') throw new TypeError('Package filenames must be strings');
  const name = value.replaceAll('\\', '/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\u0000-\u001f]/.test(name)
    || name.split('/').some((part, index, parts) => part === '.' || part === '..' || (!part && index !== parts.length - 1)))
    throw new TypeError('Invalid relative package filename');
  return name;
}

function deviceBase(info) {
  const side = info.side === 'left' ? '左' : info.side === 'right' ? '右' : '';
  if (info.product === 'body') return '人体全身';
  if (info.product === 'glove') return `${side ? `${side}手` : ''}手套`;
  if (info.product === 'insole') return `${side ? `${side}脚` : ''}鞋垫`;
  if (info.product === 'hand-pad') return '压力阵列';
  if (info.modality === 'camera' || info.modality === 'audio') {
    const label = info.modality === 'camera' ? '摄像头' : '麦克风';
    let device = asString(info.device_label).trim();
    if (device.startsWith(label)) device = device.slice(label.length).trim();
    if (/^\([^()]+\)$/.test(device)) device = device.slice(1, -1).trim();
    return device ? `${label}_${device}` : label;
  }
  return asString(info.device_label) || asString(info.sensor) || '传感器';
}

function dataSuffix(info) {
  if (info.modality === 'pressure') return '_压力';
  if (info.modality === 'imu') return info.data_type.includes('原始字节') ? '_IMU原始字节' : '_IMU';
  return '';
}
const withSuffix = (base, suffix) => shorten(base, Math.max(1, 100 - Array.from(suffix).length)) + suffix;
const portToken = value => safePackageName(`_${asString(value)}`, '_串口').slice(1) || '串口';

function extension(file) {
  const part = file.match(/\.(?:wav|webm|mp4)\.part$/i);
  if (part) return part[0];
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(dot) : '';
}

/** Resolve exact entries or a directory prefix without ever changing child filenames. */
export function mapPackagePath(original, fileMap) {
  const value = relativePath(original);
  const exact = fileMap.find(item => item.original_file === value);
  if (exact) return exact.file;
  const parent = fileMap.filter(item => item.original_file.endsWith('/') && value.startsWith(item.original_file))
    .sort((a, b) => b.original_file.length - a.original_file.length)[0];
  return parent ? parent.file + value.slice(parent.original_file.length) : value;
}

/** Deterministic archive aliases; no source file operations or payload reads. */
export function createPackageFileMap({ manifest = {}, format, files = [] } = {}) {
  const originals = [...new Set(files.map(relativePath))];
  const streams = objects(manifest.streams), media = objects(manifest.media_streams), all = [...streams, ...media];
  const descriptors = all.filter(stream => typeof stream.id === 'string' && stream.id && !/[\\/]/.test(stream.id))
    .map(stream => {
      const info = sourceInfo(stream, all);
      return { stream, info, group: info.instance_id ? `instance:${info.instance_id}` : `stream:${stream.id}` };
    }).sort((a, b) => (a.info.modality === 'pressure' ? 0 : 1) - (b.info.modality === 'pressure' ? 0 : 1)
      || a.stream.id.localeCompare(b.stream.id, 'en'));
  const groups = new Map();
  for (const item of descriptors) {
    if (!groups.has(item.group)) groups.set(item.group, { key: item.group, base: safePackageName(deviceBase(item.info)), ports: new Set() });
    if (item.info.port) groups.get(item.group).ports.add(item.info.port);
  }
  for (const group of groups.values()) {
    const peers = [...groups.values()].filter(other => key(other.base) === key(group.base));
    const port = group.ports.size === 1 ? portToken([...group.ports][0]) : '';
    if (peers.length === 1) group.name = group.base;
    else if (port && peers.filter(other => other.ports.size === 1 && key(portToken([...other.ports][0])) === key(port)).length === 1)
      group.name = `${shorten(group.base, 75)}_${port}`;
    else group.name = `${shorten(group.base, 75)}${port ? `_${shorten(port, 12)}` : ''}_${digest(group.key)}`;
  }

  const claims = new Map();
  function claim(original, descriptor, stem, ext = '', directory = false) {
    const proposal = { original, descriptor, stem, ext, directory };
    // Ambiguous source metadata must not assign one file to an arbitrary sensor.
    if (claims.has(original) && claims.get(original)?.descriptor.stream.id !== descriptor.stream.id) claims.set(original, null);
    else if (!claims.has(original)) claims.set(original, proposal);
  }
  for (const descriptor of descriptors) {
    const { stream, info } = descriptor, base = groups.get(descriptor.group).name;
    if (streams.includes(stream)) {
      if (format === 'json') {
        if (typeof stream.file === 'string' && originals.includes(stream.file) && !stream.file.includes('/'))
          claim(stream.file, descriptor, withSuffix(base, dataSuffix(info)), extension(stream.file));
      } else {
        for (const file of originals.filter(file => file === `${stream.id}.csv` || file === `${stream.id}.npz`))
          claim(file, descriptor, withSuffix(base, dataSuffix(info)), extension(file));
        const prefix = `${stream.id}/`;
        if (originals.some(file => file.startsWith(prefix))) claim(prefix, descriptor, withSuffix(base, dataSuffix(info)), '', true);
      }
    } else {
      const segments = objects(stream.segments), parts = segments.length ? segments : [{ file: stream.file }];
      for (const part of parts) if (typeof part.file === 'string' && originals.includes(part.file) && !part.file.includes('/')) {
        const suffix = segments.length ? Number.isSafeInteger(part.index) && part.index >= 0
          ? `_分段${String(part.index + 1).padStart(6, '0')}` : `_分段未知_${digest(part.file)}` : '';
        claim(part.file, descriptor, withSuffix(base, suffix), extension(part.file));
      }
    }
  }

  const units = [...claims.values()].filter(Boolean).sort((a, b) => a.original < b.original ? -1 : a.original > b.original ? 1 : 0);
  const covered = file => units.some(unit => unit.directory ? file.startsWith(unit.original) : file === unit.original);
  const used = new Set(Object.values(GUIDE_FILES).map(key));
  // Reserve unrelated files and directories before allocating any friendly aliases.
  for (const file of originals.filter(file => !covered(file))) used.add(key(file.split('/')[0]));
  const unitMappings = [];
  for (const unit of units) {
    const ext = unit.ext, safeStem = safePackageName(unit.stem);
    let candidate = fitComponent(safeStem, ext), attempt = 0;
    while (used.has(key(candidate))) {
      const suffix = `_${digest(`${unit.descriptor.group}:${unit.original}`)}${attempt ? `_${attempt}` : ''}`;
      candidate = fitComponent(safeStem, ext, suffix);
      attempt++;
    }
    used.add(key(candidate));
    unitMappings.push({ original_file: unit.original, file: candidate + (unit.directory ? '/' : ''), stream_id: unit.descriptor.stream.id });
  }
  const result = originals.map(original => {
    const exact = unitMappings.find(item => item.original_file === original);
    if (exact) return exact;
    const parent = unitMappings.find(item => item.original_file.endsWith('/') && original.startsWith(item.original_file));
    return { original_file: original, file: parent ? parent.file + original.slice(parent.original_file.length) : original,
      stream_id: parent?.stream_id ?? null };
  });
  // Root directory aliases are necessary even when callers list only their children.
  for (const item of unitMappings) if (item.original_file.endsWith('/') && !originals.includes(item.original_file)) result.push(item);
  return result;
}
