import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { validateManifest, inspectPackage } from '../src/plugins/contract.mjs';
import { probePackage, PluginManager } from '../src/plugins/manager.mjs';
import { CaptureEngine } from '../src/capture/engine.mjs';

const manifest = {
  api_version: 1, id: 'fixture-vendor', name: 'Test-only camera and pressure SDK', version: '1.0.0', entry: 'adapter.mjs',
  streams: [
    { id: 'rgb', name: 'Vendor camera', kind: 'camera', dtype: 'uint8', shape: [2, 3, 3], sample_rate: 50 },
    { id: 'pressure', name: 'Vendor pressure', kind: 'pressure', dtype: 'float32', shape: [2, 2], sample_rate: 50, unit: 'ADC' },
  ],
  config_fields: [{ key: 'fail', label: 'Fixture failure', type: 'boolean', default: false }, { key: 'marker', label: 'Marker file', type: 'string' }],
};
const source = `import { writeFile } from 'node:fs/promises';
export function createAdapter({config,emit}) {
  let timer, sequence=0;
  return {
    async probe() { return { sdk_loaded: true, has_secret: !!process.env.PLUGIN_RUNTIME_SECRET }; },
    async start() {
      if(config.marker) await writeFile(config.marker, 'started');
      timer=setInterval(()=>{
        if(config.fail && sequence >= 10) { process.exit(7); return; }
        emit({stream_id:'rgb', payload:Buffer.alloc(18, 123), sequence, device_time_ns:123456n});
        const payload=Buffer.alloc(16); for(let i=0;i<4;i++) payload.writeFloatLE(i+0.5,i*4);
        emit({stream_id:'pressure',payload,sequence,device_time_ns:123456n}); sequence++;
      },20);
    },
    async stop() { clearInterval(timer); }
  };
}`;
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'capture-plugin-test-'));
  const pluginRoot = path.join(directory, 'plugins'), packageDir = path.join(pluginRoot, manifest.id);
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(path.join(packageDir, 'adapter.mjs'), source);
  const engine = new CaptureEngine({ dataDir: path.join(directory, 'sessions'), pluginRoot, sdkPath: false });
  t.after(async () => { await engine.close(); assert.ok(directory.startsWith(path.join(os.tmpdir(), 'capture-plugin-test-'))); await rm(directory, { recursive: true, force: true }); });
  return { directory, packageDir, engine };
}
async function until(check, timeout = 3000) {
  const start = Date.now();
  while (!(await check())) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await delay(30); }
}
test('declarative validation rejects path escapes and malformed image descriptions without executing module', async t => {
  const { packageDir } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), 'throw new Error("MUST NOT EXECUTE")');
  assert.equal((await inspectPackage(packageDir)).manifest.id, manifest.id);
  assert.throws(() => validateManifest({ ...manifest, entry: '../escape.mjs' }), /relative path/);
  assert.throws(() => validateManifest({ ...manifest, streams: [{ ...manifest.streams[0], shape: [2, 3, 4] }] }), /RGB8/);
  assert.throws(() => validateManifest({ ...manifest, streams: [{ ...manifest.streams[0], id: '../escape' }] }), /stream/);
});
test('explicit probe loads interface, never starts acquisition and does not inherit secrets', async t => {
  const { directory, packageDir } = await fixture(t);
  process.env.PLUGIN_RUNTIME_SECRET = 'must-not-reach-sdk';
  t.after(() => delete process.env.PLUGIN_RUNTIME_SECRET);
  const marker = path.join(directory, 'started.txt');
  const result = await probePackage(packageDir, { config: { marker } });
  assert.equal(result.passed, true); assert.equal(result.probe_ran, true); assert.equal(result.hardware_verified, false);
  assert.equal(result.details.has_secret, false);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
test('installed plugin discovers, connects, previews and records camera and sensor data with preserved source clocks', async t => {
  const { directory, engine } = await fixture(t);
  await engine.init();
  assert.equal((await engine.pluginCatalog()).plugins[0].id, manifest.id);
  const connected = await engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'a' });
  assert.equal(connected.connected, true);
  assert.deepEqual(connected.stream_ids, ['plugin-a-rgb', 'plugin-a-pressure']);
  await until(() => engine.preview().streams?.['plugin-a-rgb']);
  const thumbnail = engine.preview().streams['plugin-a-rgb'].camera;
  assert.equal(thumbnail.width, 3); assert.equal(Buffer.from(thumbnail.rgb_base64, 'base64')[0], 123);
  const session = await engine.start({ name: 'Plugin integration fixture', device_ids: connected.stream_ids });
  await assert.rejects(engine.pluginDisconnect({ instance_id: 'a' }), error => error.statusCode === 409);
  await delay(150);
  const result = await engine.stop();
  assert.equal(result.status, 'complete'); assert.equal(result.source, 'sdk-plugin'); assert.equal(result.simulated, false);
  for (const stream of result.streams) {
    assert.ok(stream.records >= 2); assert.equal(stream.mode, 'sdk-plugin');
    const bytes = await readFile(path.join(directory, 'sessions', session.id, stream.file));
    assert.equal(bytes.subarray(0, 8).toString(), 'MDAQBIN1');
    assert.equal(bytes.readUInt32LE(8 + 24), 1);
    assert.ok(bytes.readBigInt64LE(8 + 16) > bytes.readBigInt64LE(8 + 8));
  }
  const metadata = (await readFile(path.join(directory, 'sessions', session.id, 'plugin-frames.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(metadata.length >= 4); assert.equal(metadata[0].source_device_time_ns, '123456'); assert.equal(metadata[0].hardware_synchronized, false);
  await engine.pluginDisconnect({ instance_id: 'a' });
  assert.equal((await engine.pluginCatalog()).instances[0].connected, false);
});
test('native-style child crash leaves capture service alive and marks active recording incomplete', async t => {
  const { engine } = await fixture(t);
  await engine.init();
  const instance = await engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'crash', config: { fail: true } });
  await engine.start({ device_ids: instance.stream_ids });
  await until(async () => (await engine.pluginCatalog()).instances[0].error);
  const finished = await engine.stop();
  assert.equal(finished.status, 'incomplete'); assert.match(finished.error, /exited|no frames/);
  assert.equal(engine.status().engine_alive, true);
});

test('native crash diagnosis drains large stderr, joins split fatal messages and never exposes vendor secrets', async t => {
  const { packageDir } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `
    const write = text => new Promise(resolve => process.stderr.write(text, resolve));
    export function createAdapter() {
      return { async start() {
        await write('private-sdk-token rtsp://user:secret@camera/private\\n' + 'x'.repeat(1024 * 1024));
        await write('\\nFATAL ERR');
        await new Promise(resolve => setTimeout(resolve, 10));
        await write('OR: Error::New napi_get_last_error_info\\n');
        process.exit(134);
      }, stop() {} };
    }
  `);
  const manager = new PluginManager({ root: path.dirname(packageDir) });
  t.after(() => manager.close());
  await manager.reload();
  await assert.rejects(manager.connect({ plugin_id: manifest.id, instance_id: 'native-crash' }), error => {
    assert.match(error.message, /^SDK process exited \(134\)：原生模块发生 N-API 致命错误$/);
    assert.doesNotMatch(error.message, /private|token|rtsp|secret|camera\//);
    assert.equal(error.statusCode, 503);
    return true;
  });
  const instance = manager.instances.get('native-crash');
  assert.ok(Buffer.byteLength(instance.child.pluginExitDiagnostic()) <= 8192, 'retained stderr must stay bounded');
  const catalog = await manager.reload();
  assert.equal(catalog.instances[0].connected, false);
  assert.equal(catalog.plugins.length, 1, 'manager remains usable after child crash');
});

test('probe exit diagnosis uses known fatal markers only and retains at most the stderr tail', async t => {
  const cases = [
    { name: 'external-buffer', output: 'FATAL ERROR: Cannot create external ArrayBuffer outside sandbox\n', suffix: '：Electron 拒绝了原生模块的外部内存缓冲区' },
    { name: 'out-of-memory', output: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n', suffix: '：SDK 进程内存分配失败' },
    { name: 'unknown-134', output: 'private-sdk-token rtsp://user:secret@camera/private\n', suffix: '' },
    { name: 'expired-marker', output: 'FATAL ERROR: Error::New napi_get_last_error_info\n' + 'x'.repeat(65536), suffix: '' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const { packageDir, engine } = await fixture(t);
    await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter() {
      return { probe() { process.stderr.write(${JSON.stringify(scenario.output)}, () => process.exit(134)); return new Promise(() => {}); },
        start() { throw new Error('Probe must not start acquisition'); }, stop() {} };
    }`);
    await engine.init();
    await assert.rejects(probePackage(packageDir), error => {
      assert.equal(error.message, 'SDK test process exited (134)' + scenario.suffix);
      assert.doesNotMatch(error.message, /private|token|rtsp|secret|camera\//);
      return true;
    });
    assert.equal(engine.status().engine_alive, true);
  });
});

test('explicit SDK error stays primary when stderr also contains a native fatal marker', async t => {
  const { packageDir, engine } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter() {
    return { probe() { process.stderr.write('FATAL ERROR: Error::New napi_get_last_error_info\\n');
      throw new Error('SDK declared configuration failure'); }, start() {}, stop() {} };
  }`);
  await engine.init();
  await assert.rejects(probePackage(packageDir), { message: 'SDK declared configuration failure' });
  assert.equal(engine.status().engine_alive, true);
});
test('malformed SDK payload fails connection explicitly without bringing down capture', async t => {
  const { packageDir, engine } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter({emit}) {
    return { start(){ emit({stream_id:'rgb',payload:Buffer.alloc(2)}); }, stop(){} };
  }`);
  await engine.init();
  await assert.rejects(engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'bad' }), /payload length/);
  const info = await engine.pluginCatalog();
  assert.equal(info.instances[0].connected, false); assert.match(info.instances[0].error, /payload length/);
  assert.equal(engine.status().engine_alive, true);
});
test('synchronous SDK burst exceeding IPC bounds reports overflow instead of growing indefinitely', async t => {
  const { packageDir, engine } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter({emit}) {
    return { start(){ for(let i=0;i<100;i++) emit({stream_id:'rgb',payload:Buffer.alloc(18)}); }, stop(){} };
  }`);
  await engine.init();
  await assert.rejects(engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'burst' }), /queue overflow/);
  assert.equal(engine.status().engine_alive, true);
});
test('hung probe is terminated at deadline and cannot start acquisition', async t => {
  const { packageDir } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter() {
    return { probe(){ return new Promise(()=>{}); }, start(){ throw new Error('must not start'); }, stop(){} };
  }`);
  await assert.rejects(probePackage(packageDir, { timeoutMs: 150 }), /timed out/);
});
test('an SDK probe returning ok:false is a failed test, not a successful module load', async t => {
  const { packageDir } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter() {
    return { probe(){ return {ok:false,message:'Vendor runtime missing'}; }, start(){}, stop(){} };
  }`);
  await assert.rejects(probePackage(packageDir), /Vendor runtime missing/);
});
test('a probe cannot pass when SDK cleanup fails', async t => {
  const { packageDir } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter() {
    return { probe(){ return {ok:true}; }, start(){}, stop(){throw new Error('Device handle was not released');} };
  }`);
  await assert.rejects(probePackage(packageDir), /Device handle was not released/);
});

test('native camera cleanup that exceeds three seconds completes before the bounded stop deadline', { timeout: 10000 }, async t => {
  const { packageDir, engine } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter({emit}) {
    let timer;
    return { start(){ timer=setInterval(()=>emit({stream_id:'rgb',payload:Buffer.alloc(18)}),50); },
      async stop(){ clearInterval(timer); await new Promise(resolve=>setTimeout(resolve,3400)); } };
  }`);
  await engine.init();
  await engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'slow-cleanup' });
  await until(async () => (await engine.pluginCatalog()).instances[0]?.received_records > 0);
  const stopped = await engine.pluginDisconnect({ instance_id: 'slow-cleanup' });
  assert.equal(stopped.connected, false);
  assert.equal(stopped.error, null);
  assert.equal(engine.status().engine_alive, true);
});

test('a periodic camera that silently stops producing frames is disconnected with an explicit error', { timeout: 16000 }, async t => {
  const { packageDir, engine } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), `export function createAdapter({emit}) {
    return { start(){ emit({stream_id:'rgb',payload:Buffer.alloc(18)}); }, stop(){} };
  }`);
  await engine.init();
  await engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'silent' });
  await until(async () => (await engine.pluginCatalog()).instances[0].error, 13000);
  const info = (await engine.pluginCatalog()).instances[0];
  assert.equal(info.connected, false);
  assert.match(info.error, /10 秒未收到有效帧/);
  assert.equal(engine.status().engine_alive, true);
});
test('plugin shutdown failure still drains raw files and finalizes active recording incomplete', async t => {
  const { directory, packageDir, engine } = await fixture(t);
  await writeFile(path.join(packageDir, 'adapter.mjs'), source.replace('async stop() { clearInterval(timer); }', 'async stop() { clearInterval(timer); throw new Error("Release failed"); }'));
  await engine.init();
  const instance = await engine.pluginConnect({ plugin_id: manifest.id, instance_id: 'cleanup' });
  const session = await engine.start({ device_ids: instance.stream_ids });
  await delay(100);
  await engine.close();
  const stored = JSON.parse(await readFile(path.join(directory, 'sessions', session.id, 'manifest.json'), 'utf8'));
  assert.equal(stored.finalized, true); assert.equal(stored.status, 'incomplete'); assert.match(stored.error, /Release failed/);
  assert.ok(stored.record_count > 0);
});
