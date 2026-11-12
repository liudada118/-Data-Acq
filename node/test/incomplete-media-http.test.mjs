import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { createApplication } from '../src/server.mjs';
import { checkWave } from '../src/exports/reader.mjs';

test('verified interrupted WAV supports byte ranges and a WAV download name without rewriting the recording', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daq-part-wave-'));
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'sessions'), id = 'session-audio-part', folder = path.join(dataDir, id);
  await mkdir(folder, { recursive: true });
  const file = 'microphone-old.wav.part', samples = 8000;
  const pcm = Buffer.alloc(44 + samples * 2);
  pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(samples * 2, 40);
  const media = { id: 'microphone-old', kind: 'audio', mode: 'browser-microphone', format: 'wav', file,
    encoding: 'pcm_s16le', channels: 1, bits_per_sample: 16, sample_rate: 8000, mime_type: 'audio/wav',
    sample_count: samples, payload_bytes: samples * 2, bytes: pcm.length, duration_ms: 1000,
    chunks: 1, finalized: false, error: 'Interrupted', started_at: null };
  const manifest = { id, name: 'Saved partial audio', status: 'incomplete', finalized: true, duration_s: 1, started_at: '2026-11-06T00:00:00Z',
    streams: [], media_streams: [null, media], assets: [{ file, stream_id: media.id, role: 'browser-microphone-audio' }] };
  await writeFile(path.join(folder, file), pcm);
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  // A filesystem read may legally return fewer bytes than requested before EOF.
  const probe = await open(path.join(folder, file), 'r'), prototype = Object.getPrototypeOf(probe);
  const originalRead = prototype.read;
  const shortRead = t.mock.method(prototype, 'read', function(buffer, offset, length, position) {
    return originalRead.call(this, buffer, offset, Math.min(length, 7), position);
  });
  try { assert.equal(await checkWave(folder, media, media), path.join(folder, file)); }
  finally { shortRead.mock.restore(); await probe.close(); }
  app = await createApplication({ port: 0, sdkPath: false, dataDir, outputDir: path.join(root, 'exports') });
  const url = `${app.url}/api/files/${id}/${file}`;
  const range = await fetch(url, { headers: { Range: 'bytes=0-43' } });
  assert.equal(range.status, 206, range.status === 206 ? '' : await range.text()); assert.equal(range.headers.get('Content-Type'), 'audio/wav');
  assert.equal(range.headers.get('Content-Range'), `bytes 0-43/${pcm.length}`);
  assert.match(range.headers.get('Content-Disposition'), /microphone-old\.wav(?:$|"|;)/);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), pcm.subarray(0, 44));
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(pcm.length));
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999999-' } })).status, 416);
  assert.equal((await fetch(`${app.url}/api/files/${id}/undeclared.wav.part`)).status, 404);
  const frame = await (await fetch(`${app.url}/api/sessions/${id}/replay?time_s=0.5`)).json();
  assert.equal(frame.incomplete, true); assert.equal(frame.media_streams[0].available, true);
  assert.deepEqual(await readFile(path.join(folder, file)), pcm);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')).status, 'incomplete');
  // A corrupt source remains downloadable as raw bytes, never advertised as playable WAV.
  pcm.write('BAD!', 0); await writeFile(path.join(folder, file), pcm);
  const bad = await fetch(url, { method: 'HEAD' });
  assert.equal(bad.status, 200); assert.equal(bad.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(bad.headers.get('Accept-Ranges'), null);
});
