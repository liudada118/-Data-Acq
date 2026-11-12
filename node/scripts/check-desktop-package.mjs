import { startDesktopService } from '../electron/service.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { extractFile, listPackage } from '@electron/asar';

// Exercise the actual packaged executable/ASAR without licensing or opening hardware.
const packed = fileURLToPath(new URL('../release/electron/win-unpacked/', import.meta.url));
const archive = path.join(packed, 'resources/app.asar');
const entries = listPackage(archive);
assert.equal(entries.some(p => /^[/\\](?:\.env(?:\.|$)|\.runtime[/\\]|data[/\\])/.test(p)), false);
const processor = await readFile(new URL('../ui/public/audio/pcm-capture.worklet.js', import.meta.url));
assert.deepEqual(extractFile(archive, path.join('ui', 'dist', 'audio', 'pcm-capture.worklet.js')), processor,
  'the installed app must include the current audio processor');
const directory = await mkdtemp(path.join(os.tmpdir(), 'synapse-packaged-smoke-'));
let service;
async function api(route, body) {
  const response = await fetch(service.url + route, { method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value)); return value;
}
try {
  service = await startDesktopService({ executable: path.join(packed, 'Shroom Capture.exe'),
    root: path.join(packed, 'resources/app.asar.unpacked'), userData: directory,
    webDir: path.join(archive, 'ui/dist'), port: 0, packaged: true, disableEnvFile: true,
    env: { SHROOM_LICENSE_FILE: '', SHROOM_LICENSE_KEY: '', SHROOM_SDK_PATH: '' } });
  const health = await api('/api/health');
  assert.equal(health.engine_alive, true); assert.equal(health.sdk_loaded, true);
  const html = await (await fetch(service.url)).text(); assert.match(html, /<div id="root"(?:\s|>)/);
  const audioModule = await fetch(service.url + '/audio/pcm-capture.worklet.js');
  assert.equal(audioModule.status, 200);
  assert.match(audioModule.headers.get('content-type'), /javascript/);
  assert.deepEqual(Buffer.from(await audioModule.arrayBuffer()), processor);
  const ports = await api('/api/sdk/ports');
  const sdk = await api('/api/sdk/connect', { instance_id: 'desktop-check', product: 'mock', mode: 'mock' });
  assert.ok(sdk.stream_ids?.length);
  const started = await api('/api/sessions/start', { name: 'Electron packaged SDK Mock validation', device_ids: sdk.stream_ids });
  await new Promise(resolve => setTimeout(resolve, 700));
  const stopped = await api('/api/sessions/stop', { session_id: started.session_id });
  assert.equal(stopped.session.status, 'complete');
  assert.equal(stopped.session.dropped_records, 0);
  assert.ok(Object.values(stopped.session.record_counts).every(count => count > 0));
  const job = await api('/api/export/jobs', { session_id: started.session_id, format: 'npz' });
  await service.close(); service = null;
  const jobs = JSON.parse(await readFile(path.join(directory, 'data/exports/jobs.json'), 'utf8'));
  assert.equal(jobs.jobs.find(item => item.id === job.id).status, 'complete');
  console.log(JSON.stringify({ packaged: true, runtime: health.runtime, sdkLoaded: health.sdk_loaded,
    enumeratedPorts: ports.ports.length, session: started.session_id, status: stopped.session.status,
    records: stopped.session.record_counts, dropped: stopped.session.dropped_records, npz: 'complete',
    fixtureDirectory: directory, archiveEntries: entries.length, audioWorklet: 'included and served', privateFilesIncluded: false }, null, 2));
} finally { await service?.close(); }
