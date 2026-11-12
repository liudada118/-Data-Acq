import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackageFileMap, mapPackagePath, safePackageName } from '../src/exports/package-names.mjs';
import { buildPackageGuide, GUIDE_FILES } from '../src/exports/package-guide.mjs';

const pressure = (id, instance, side, port, product = 'glove') => ({ id, kind: 'pressure', file: `${id}.bin`, unit: 'ADC',
  metadata: { instance_id: instance, side, port, product } });
const imu = (id, instance, side) => ({ id, kind: 'imu', file: `${id}.bin`, unit: 'raw-byte',
  metadata: { instance_id: instance, side, product: 'glove', parsed: false } });
const lookup = mappings => Object.fromEntries(mappings.map(item => [item.original_file, item.file]));

test('uses sensor names and distinguishes left/right pressure and raw IMU without changing IDs', () => {
  const manifest = { streams: [pressure('body', 'b', null, 'COM29', 'body'), pressure('lp', 'l', 'left', 'COM5'), imu('li', 'l', 'left'),
    pressure('rp', 'r', 'right', 'COM9'), imu('ri', 'r', 'right')], media_streams: [
    { id: 'v', kind: 'camera', name: 'DroidCam Video', file: 'v.webm' },
    { id: 'a', kind: 'audio', name: '麦克风 (DroidCam Audio)', file: 'a.wav' },
  ] };
  const original = structuredClone(manifest), files = ['body.csv', 'lp.csv', 'li.csv', 'rp.csv', 'ri.csv', 'v.webm', 'a.wav', 'manifest.json'];
  const map = createPackageFileMap({ manifest, format: 'csv', files });
  assert.deepEqual(lookup(map), { 'body.csv': '人体全身_压力.csv', 'lp.csv': '左手手套_压力.csv', 'li.csv': '左手手套_IMU原始字节.csv',
    'rp.csv': '右手手套_压力.csv', 'ri.csv': '右手手套_IMU原始字节.csv', 'v.webm': '摄像头_DroidCam Video.webm',
    'a.wav': '麦克风_DroidCam Audio.wav', 'manifest.json': 'manifest.json' });
  assert.equal(map.find(item => item.original_file === 'li.csv').stream_id, 'li');
  assert.deepEqual(manifest, original);
});

test('same-side multiple devices use unique COM labels paired across pressure and IMU', () => {
  const streams = [pressure('pa', 'a', 'left', 'COM5'), imu('ia', 'a', 'left'), pressure('pb', 'b', 'left', 'COM8'), imu('ib', 'b', 'left')];
  const files = streams.map(stream => `${stream.id}.csv`);
  const names = lookup(createPackageFileMap({ manifest: { streams }, format: 'csv', files }));
  assert.equal(names['pa.csv'], '左手手套_COM5_压力.csv'); assert.equal(names['ia.csv'], '左手手套_COM5_IMU原始字节.csv');
  assert.equal(names['pb.csv'], '左手手套_COM8_压力.csv'); assert.equal(names['ib.csv'], '左手手套_COM8_IMU原始字节.csv');
  const reversed = lookup(createPackageFileMap({ manifest: { streams: [...streams].reverse() }, format: 'csv', files: [...files].reverse() }));
  assert.deepEqual(reversed, names);
});

test('duplicate type without unique ports uses deterministic short device identity', () => {
  const streams = [pressure('pa', 'a', 'left', 'COM5'), imu('ia', 'a', 'left'), pressure('pb', 'b', 'left', 'COM5'), imu('ib', 'b', 'left')];
  const names = lookup(createPackageFileMap({ manifest: { streams }, format: 'npz', files: streams.map(stream => `${stream.id}.npz`) }));
  assert.match(names['pa.npz'], /^左手手套_COM5_[a-f0-9]{8}_压力\.npz$/);
  assert.notEqual(names['pa.npz'], names['pb.npz']);
  assert.equal(names['pa.npz'].replace('_压力.npz', ''), names['ia.npz'].replace('_IMU原始字节.npz', ''));
});

test('WAV segment filenames retain original index gaps and .wav.part suffix', () => {
  const manifest = { media_streams: [{ id: 'mic', kind: 'audio', name: '麦克风', segments: [
    { index: 0, file: 'a.wav', start_sample: 0 }, { index: 2, file: 'c.wav.part', start_sample: 96000 },
  ] }] };
  const names = lookup(createPackageFileMap({ manifest, format: 'wav', files: ['a.wav', 'c.wav.part'] }));
  assert.equal(names['a.wav'], '麦克风_分段000001.wav'); assert.equal(names['c.wav.part'], '麦克风_分段000003.wav.part');
});

test('raw BIN / converted NPZ and directories use aliases without renaming frame or audio index children', () => {
  const manifest = { streams: [pressure('p', 'p', 'right', 'COM9'),
    { id: 'audio', name: 'Line In', kind: 'audio', file: 'audio.bin' },
    { id: 'cam', name: 'RGB', kind: 'camera', file: 'cam.bin' }] };
  const raw = createPackageFileMap({ manifest, format: 'json', files: ['p.bin', 'audio.bin', 'cam.bin'] });
  assert.equal(mapPackagePath('p.bin', raw), '右手手套_压力.bin');
  const map = createPackageFileMap({ manifest, format: 'npz', files: ['p.npz', 'audio.npz', 'audio/audio.wav', 'audio/blocks.csv', 'cam/'] });
  assert.equal(mapPackagePath('audio/', map), '麦克风_Line In/');
  assert.equal(mapPackagePath('audio/audio.wav', map), '麦克风_Line In/audio.wav');
  assert.equal(mapPackagePath('audio/blocks.csv', map), '麦克风_Line In/blocks.csv');
  assert.equal(mapPackagePath('cam/frame_00000000.png', map), '摄像头_RGB/frame_00000000.png');
  assert.equal(mapPackagePath('cam/frames.csv', map), '摄像头_RGB/frames.csv');
  assert.equal(mapPackagePath('unknown.json', map), 'unknown.json');
});

test('safe Unicode names retain type and segment suffixes within Windows component limits', () => {
  assert.equal(safePackageName(' NUL. '), '设备_NUL'); assert.equal(safePackageName('CON.txt'), '设备_CON.txt');
  assert.equal(safePackageName('CLOCK$'), '设备_CLOCK$'); assert.equal(safePackageName('CONIN$'), '设备_CONIN$');
  assert.equal(safePackageName('CONOUT$.txt'), '设备_CONOUT$.txt'); assert.equal(safePackageName('a\u0085b'), 'a_b');
  assert.equal(safePackageName('../a\\b:*?"<>|'), '.._a_b_______');
  assert.equal(safePackageName('e\u0301'), 'é'); assert.equal(safePackageName('..'), '传感器');
  const manifest = { media_streams: [{ id: 'mic', name: '🎤'.repeat(200) + '/x', kind: 'audio',
    segments: [{ index: 1, file: 'b.wav.part' }] }] };
  const name = createPackageFileMap({ manifest, format: 'wav', files: ['b.wav.part'] })[0].file;
  assert.ok(name.length <= 255); assert.match(name, /_分段000002\.wav\.part$/); assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]/);
});

test('unfinished camera filenames preserve their full video container suffix', () => {
  for (const ext of ['webm.part', 'mp4.part']) {
    const manifest = { media_streams: [{ id: 'camera', name: 'Phone', kind: 'camera', file: `camera.${ext}` }] };
    const map = createPackageFileMap({ manifest, format: 'json', files: [`camera.${ext}`] });
    assert.equal(map[0].file, `摄像头_Phone.${ext}`);
  }
});

test('entire Unicode filename including long extension and collision suffix fits 255 UTF16 units', () => {
  const ext = '.' + 'x'.repeat(140), original = 'a' + ext;
  const stream = { id: 'sensor', kind: 'imu', name: '🎤'.repeat(100), file: original, unit: 'raw-byte' };
  const base = createPackageFileMap({ manifest: { streams: [stream] }, format: 'json', files: [original] })[0].file;
  const map = createPackageFileMap({ manifest: { streams: [stream] }, format: 'json', files: [original, base] });
  const name = map.find(item => item.original_file === original).file;
  assert.ok(name.length <= 255); assert.ok(name.endsWith(ext));
  assert.match(name.slice(0, -ext.length), /_IMU原始字节_[a-f0-9]{8}$/);
  assert.doesNotMatch(name, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  assert.notEqual(name, base);
});

test('unrelated case/Unicode-equivalent files and directories are reserved before aliases', () => {
  const manifest = { streams: [pressure('p', 'p', 'left', 'COM1')], media_streams: [{ id: 'a', kind: 'audio', name: 'É', file: 'a.wav' }] };
  const files = ['p.csv', '左手手套_压力.CSV', 'a.wav', '麦克风_e\u0301.WAV', ...Object.values(GUIDE_FILES)];
  const names = lookup(createPackageFileMap({ manifest, format: 'csv', files }));
  assert.equal(names['左手手套_压力.CSV'], '左手手套_压力.CSV');
  assert.match(names['p.csv'], /^左手手套_压力_[a-f0-9]{8}\.csv$/);
  assert.match(names['a.wav'], /^麦克风_É_[a-f0-9]{8}\.wav$/);
  const keys = Object.values(names).map(name => name.normalize('NFKC').toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  const directoryMap = createPackageFileMap({ manifest: { streams: [{ id: 'cam', kind: 'camera', name: 'RGB' }] }, format: 'csv',
    files: ['cam/', '摄像头_RGB/user-file.txt'] });
  assert.notEqual(mapPackagePath('cam/', directoryMap), '摄像头_RGB/');
});

test('friendly guide paths reference unchanged original manifest and missing segments remain missing', () => {
  const manifest = { streams: [pressure('p', 'p', 'left', 'COM1')], media_streams: [{ id: 'a', kind: 'audio', name: '麦克风', segments: [
    { index: 0, file: 'a.wav', start_sample: 0 }, { index: 1, file: 'missing.wav', start_sample: 48000 },
  ] }], status: 'incomplete' };
  const originals = ['p.csv', 'a.wav', 'manifest.json'], fileMap = createPackageFileMap({ manifest, format: 'csv', files: originals });
  const guide = buildPackageGuide({ manifest, format: 'csv', files: originals.map(file => mapPackagePath(file, fileMap)), fileMap });
  assert.equal(guide.index.entries.find(item => item.stream_id === 'p').file, '左手手套_压力.csv');
  assert.equal(guide.index.entries.find(item => item.stream_id === 'p').original_file, 'p.csv');
  assert.equal(guide.index.source_manifest, 'manifest.json'); assert.deepEqual(guide.index.file_mapping, fileMap);
  assert.equal(guide.index.unavailable_streams[0].source_file, 'missing.wav');
  assert.match(guide.csv, /"左手手套_压力.csv","p.csv"/); assert.match(guide.readme, /manifest.json 保持原样/);
});

test('malformed metadata cannot coerce labels or silently assign ambiguous files', () => {
  const bad = JSON.parse('{"toString":null}');
  const streams = [{ id: bad, name: bad }, { id: 'x', name: bad, kind: 'pressure', metadata: { product: bad } },
    { id: 'a', kind: 'pressure', file: 'same.bin' }, { id: 'b', kind: 'imu', file: 'same.bin' }];
  const converted = createPackageFileMap({ manifest: { streams }, format: 'csv', files: ['x.csv'] });
  assert.equal(converted[0].file, 'x_压力.csv');
  const raw = createPackageFileMap({ manifest: { streams }, format: 'json', files: ['same.bin'] });
  assert.equal(raw[0].file, 'same.bin'); assert.equal(raw[0].stream_id, null);
  assert.throws(() => createPackageFileMap({ files: ['../file.csv'] }), /Invalid relative/);
  assert.throws(() => mapPackagePath('C:\\file.csv', []), /Invalid relative/);
});
