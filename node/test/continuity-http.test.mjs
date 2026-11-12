import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createApplication } from '../src/server.mjs';

test('continuity HTTP reserves startup, blocks scanning during capture, and cancels scans before acquisition', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daq-continuity-http-'));
  const app = await createApplication({ port: 0, sdkPath: false,
    dataDir: path.join(root, 'sessions'), outputDir: path.join(root, 'exports') });
  t.after(() => app.close());
  const base = '/api/sessions/session-check/continuity';
  const post = (route, input = {}) => fetch(app.url + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.deepEqual(await (await fetch(app.url + base)).json(), { job: null });
  let release, entered;
  const starting = new Promise(resolve => { entered = resolve; });
  const job = { id: 'check-1', session_id: 'session-check', status: 'running', threshold_ms: 25 };
  t.mock.method(app.continuity, 'start', async (id, input) => {
    assert.equal(id, 'session-check'); assert.equal(input.threshold_ms, 25);
    entered(); await new Promise(resolve => { release = resolve; }); return job;
  });
  const pending = post(base, { threshold_ms: 25 });
  await starting;
  assert.equal((await post('/api/sessions/start', { device_ids: [] })).status, 409);
  release();
  const accepted = await pending;
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { job });
  const status = app.capture.status.bind(app.capture);
  const override = t.mock.method(app.capture, 'status', () => ({ ...status(), state: 'recording', session_id: 'active-capture' }));
  assert.equal((await post(base, { threshold_ms: 25 })).status, 409);
  override.mock.restore();
  let cancelled = 0;
  t.mock.method(app.continuity, 'cancelActive', async () => { cancelled++; });
  assert.equal((await post('/api/sessions/start', { device_ids: [] })).status, 400);
  assert.equal(cancelled, 1, 'scan cancellation happens before capture validation and source startup');
  t.mock.method(app.continuity, 'cancel', async id => ({ ...job, session_id: id, status: 'cancelled' }));
  assert.equal((await (await post(base + '/cancel')).json()).job.status, 'cancelled');
  assert.equal((await post('/api/sessions/bad.id/continuity')).status, 400);
  assert.equal((await post(base, null)).status, 400);
});
