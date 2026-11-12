import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../src/server.mjs';
import { readAnnotationDocument, validateExperiment, validateLabels } from '../src/annotations.mjs';

const labels = [
  { id: 'contact', name: '接触', color: '#25866b', kind: 'point', shortcut: '1' },
  { id: 'grasp', name: '抓握', color: '#b37b39', kind: 'interval', shortcut: '2' },
];
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-annotations-'));
  const options = { port: 0, sdkPath: false, dataDir: path.join(directory, 'sessions'), outputDir: path.join(directory, 'exports') };
  let app = await createApplication(options);
  t.after(() => app.close());
  const get = endpoint => fetch(app.url + endpoint);
  const post = (endpoint, value) => fetch(app.url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { get app() { return app; }, options, get, post,
    restart: async () => { await app.close(); app = await createApplication(options); },
    start: async () => {
      const response = await post('/api/sessions/start', { device_ids: ['sim-pressure', 'sim-imu'], labels,
        experiment: { project: '多模态实验', task: '抓握', subject: 'P001', trial: '3', tags: ['海绵', '左手'] } });
      assert.equal(response.status, 201, await response.clone().text()); return response.json();
    },
  };
}
const hash = value => createHash('sha256').update(value).digest('hex');

test('annotation context validation bounds metadata, shortcuts and label IDs', () => {
  assert.deepEqual(validateExperiment({ project: ' demo ', tags: ['a', 'a'], ignored: 'discard' }),
    { project: 'demo', task: '', subject: '', scene: '', trial: '', notes: '', tags: ['a'] });
  assert.throws(() => validateExperiment({ notes: 'x'.repeat(2001) }));
  assert.throws(() => validateExperiment({ trial: 3 }));
  assert.throws(() => validateLabels([...labels, { ...labels[0], id: 'other' }]));
  assert.throws(() => validateLabels([{ ...labels[0], id: '../../evil' }]));
  assert.throws(() => validateLabels([{ ...labels[0], color: 'url(https://example.test)' }]));
});

test('live annotations use capture clock, serialize revisions and persist context without changing raw data', { timeout: 20000 }, async t => {
  const f = await fixture(t); const { session_id: id, session } = await f.start();
  const endpoint = `/api/sessions/${id}/annotations`;
  assert.equal(session.experiment.subject, 'P001'); assert.deepEqual(session.labels, labels);
  let doc = await (await f.get(endpoint)).json();
  assert.equal(doc.revision, 0);
  await delay(120);
  let response = await f.post(endpoint, { revision: 0, op: 'mark', label_id: 'contact', stream_ids: ['sim-pressure'], note: '首次接触' });
  assert.equal(response.status, 200); doc = await response.json();
  const point = doc.annotations[0];
  assert.ok(BigInt(point.start_ns) >= 100000000n); assert.equal(point.end_ns, point.start_ns);
  assert.deepEqual(point.stream_ids, ['sim-pressure']); assert.equal(point.source, 'live');
  const concurrent = await Promise.all([0, 1].map(() => f.post(endpoint, { revision: 1, op: 'mark', label_id: 'contact' })));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  doc = await (await concurrent.find(r => r.status === 200)).json();
  assert.equal((await f.post(endpoint, { revision: doc.revision, op: 'upsert', label_id: 'contact', start_ns: '0' })).status, 409);
  assert.equal((await f.post(endpoint, { revision: doc.revision, op: 'begin', label_id: 'grasp', stream_ids: ['unknown'] })).status, 400);
  doc = await (await f.post(endpoint, { revision: doc.revision, op: 'begin', label_id: 'grasp' })).json();
  const opened = doc.annotations.at(-1); assert.equal(opened.end_ns, null);
  assert.equal((await f.post(endpoint, { revision: doc.revision, op: 'begin', label_id: 'grasp' })).status, 409);
  const stoppedResponse = await f.post('/api/sessions/stop', {}); assert.equal(stoppedResponse.status, 200);
  const stopped = (await stoppedResponse.json()).session;
  doc = await (await f.get(endpoint)).json();
  const closed = doc.annotations.find(item => item.id === opened.id);
  assert.equal(closed.end_ns, stopped.duration_ns); assert.equal(closed.closed_reason, 'recording-stop');
  assert.equal(doc.history.at(-1).action, 'auto-end'); assert.ok(doc.history.at(-1).before.end_ns === null);
  const rawPath = path.join(f.options.dataDir, id, 'sim-pressure.bin');
  const rawHash = hash(await readFile(rawPath));
  const initialManifest = await readFile(path.join(f.options.dataDir, id, 'manifest.json'), 'utf8');
  assert.equal((await f.post(endpoint, { revision: doc.revision, op: 'mark', label_id: 'contact' })).status, 409);
  assert.equal((await f.post(endpoint, { revision: doc.revision, op: 'upsert', label_id: 'contact', start_ns: (BigInt(stopped.duration_ns) + 1n).toString() })).status, 400);
  response = await f.post(endpoint, { revision: doc.revision, op: 'upsert', id: point.id, label_id: 'contact', start_ns: '10000000', note: '回放修正', stream_ids: [] });
  assert.equal(response.status, 200); doc = await response.json();
  assert.equal(doc.annotations.find(item => item.id === point.id).source, 'review');
  assert.equal(doc.history.at(-1).before.start_ns, point.start_ns);
  response = await f.post(`/api/sessions/${id}/context`, { revision: doc.revision, experiment: { ...doc.experiment, notes: '复核完成' } });
  assert.equal(response.status, 200); doc = await response.json();
  assert.equal((await f.post(`/api/sessions/${id}/context`, { revision: doc.revision, labels: [] })).status, 400);
  response = await f.post(endpoint, { revision: doc.revision, op: 'delete', id: point.id });
  assert.equal(response.status, 200); doc = await response.json();
  assert.equal(doc.history.at(-1).action, 'delete');
  assert.equal(hash(await readFile(rawPath)), rawHash);
  assert.equal(await readFile(path.join(f.options.dataDir, id, 'manifest.json'), 'utf8'), initialManifest);
  const expected = doc;
  await f.restart();
  assert.deepEqual(await (await f.get(endpoint)).json(), expected);
});

test('stop waits for admitted live annotation mutation and seals its interval', { timeout: 15000 }, async t => {
  const f = await fixture(t); const { session_id: id } = await f.start();
  const originalClock = f.app.capture.annotationClock.bind(f.app.capture);
  let admitted, release;
  const admittedPromise = new Promise(resolve => { admitted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.app.capture.annotationClock = async input => { const value = await originalClock(input); admitted(); await gate; return value; };
  const mark = f.post(`/api/sessions/${id}/annotations`, { revision: 0, op: 'begin', label_id: 'grasp' });
  await admittedPromise;
  let completed = false;
  const stop = f.post('/api/sessions/stop', {}).then(value => { completed = true; return value; });
  await delay(30); assert.equal(completed, false);
  release();
  assert.equal((await mark).status, 200); assert.equal((await stop).status, 200);
  const doc = await (await f.get(`/api/sessions/${id}/annotations`)).json();
  assert.equal(doc.revision, 2); assert.notEqual(doc.annotations[0].end_ns, null);
  assert.equal(doc.history.at(-1).action, 'auto-end');
});

test('legacy sessions have empty annotation documents; malformed sidecars and invalid paths are preserved', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const session = await f.app.capture.start({ device_ids: ['sim-imu'] });
  await delay(40); const manifest = await f.app.capture.stop();
  let doc = await readAnnotationDocument(f.options.dataDir, manifest);
  assert.deepEqual(doc.labels, []); assert.equal(doc.revision, 0);
  const filename = path.join(f.options.dataDir, session.id, 'annotations.json');
  const broken = '{not valid JSON'; await writeFile(filename, broken);
  assert.equal((await f.get(`/api/sessions/${session.id}/annotations`)).status, 400);
  assert.equal((await f.post(`/api/sessions/${session.id}/context`, { revision: 0, experiment: {} })).status, 400);
  assert.equal(await readFile(filename, 'utf8'), broken);
  await assert.rejects(readAnnotationDocument(f.options.dataDir, { ...manifest, id: '../outside' }));
  await unlink(filename);
  doc = await readAnnotationDocument(f.options.dataDir, manifest);
  doc.annotations.push({ id: 'annotation-test', label_id: 'contact', label_name: '接触', kind: 'point', color: '#25866b',
    start_ns: (BigInt(manifest.duration_ns) + 1n).toString(), end_ns: (BigInt(manifest.duration_ns) + 1n).toString(), stream_ids: [], note: '', source: 'review' });
  await writeFile(filename, JSON.stringify(doc));
  await assert.rejects(readAnnotationDocument(f.options.dataDir, manifest), /超出录制范围/);
});

test('interrupted sessions preserve live markers and explicitly recover open intervals', { timeout: 20000 }, async t => {
  const f = await fixture(t); const { session_id: id } = await f.start();
  await delay(60);
  const response = await f.post(`/api/sessions/${id}/annotations`, { revision: 0, op: 'begin', label_id: 'grasp' });
  assert.equal(response.status, 200);
  await f.app.capture.worker.terminate();
  await f.restart();
  const manifest = await (await f.get(`/api/sessions/${id}`)).json();
  assert.equal(manifest.status, 'incomplete');
  const doc = await (await f.get(`/api/sessions/${id}/annotations`)).json();
  assert.equal(doc.annotations[0].closed_reason, 'recovery');
  assert.ok(BigInt(doc.annotations[0].end_ns) >= BigInt(doc.annotations[0].start_ns));
  assert.equal(doc.history.at(-1).reason, 'recovery');
});

test('video files support finite, suffix, invalid and HEAD byte ranges', { timeout: 15000 }, async t => {
  const f = await fixture(t); const { session_id: id } = await f.start();
  await delay(30); const manifest = (await (await f.post('/api/sessions/stop', {})).json()).session;
  const folder = path.join(f.options.dataDir, id), bytes = Buffer.from('opaque-video-byte-range-fixture');
  await writeFile(path.join(folder, 'fixture.webm'), bytes);
  manifest.assets = [...(manifest.assets ?? []), { file: 'fixture.webm', role: 'range-test' }];
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  const url = `${f.app.url}/api/files/${id}/fixture.webm`;
  let response = await fetch(url, { headers: { Range: 'bytes=2-7' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes 2-7/${bytes.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2, 8));
  response = await fetch(url, { headers: { Range: 'bytes=-5' } });
  assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(-5));
  response = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=4-' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-length'), String(bytes.length - 4));
  for (const Range of ['bytes=999-', 'bytes=0-2,5-9', 'bytes=-0', 'garbage', 'bytes=7-2']) {
    response = await fetch(url, { headers: { Range } }); assert.equal(response.status, 416, Range);
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
  }
  assert.equal((await fetch(url)).status, 200);
});
