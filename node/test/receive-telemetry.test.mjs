import test from 'node:test';
import assert from 'node:assert/strict';
import { ReceiveTelemetry } from '../src/capture/receive-telemetry.mjs';
import { SdkController } from '../src/capture/sdk.mjs';

test('receive diagnostics distinguish first-frame wait, zero rate, and elapsed time without new data', () => {
  const telemetry = new ReceiveTelemetry(1000);
  assert.deepEqual(telemetry.snapshot(1000), { sampled_at_monotonic_ms: 1000, observed_ms: 0, last_frame_age_ms: null,
    receive_rate_hz: null, rate_window_ms: 0, frames_in_window: 0,
    expected_interval_ms: null, interruption_threshold_ms: null });
  assert.equal(telemetry.snapshot(3000).receive_rate_hz, 0);
  telemetry.record(4000);
  const later = telemetry.snapshot(9000);
  assert.equal(later.last_frame_age_ms, 5000);
  assert.equal(later.frames_in_window, 1);
  assert.equal(later.receive_rate_hz, 1 / 8);
  assert.equal(later.interruption_threshold_ms, null, 'one frame does not establish a device cadence');
});

test('window counts expire and memory stays bounded under a high-rate source', () => {
  const telemetry = new ReceiveTelemetry(0);
  for (let time = 0; time <= 60000; time++) telemetry.record(time);
  const active = telemetry.snapshot(60000);
  assert.ok(telemetry.buckets.size <= 100);
  assert.ok(telemetry.intervals.length <= 31);
  assert.ok(Math.abs(active.receive_rate_hz - 1000) < 1);
  assert.equal(active.interruption_threshold_ms, 10000);
  const stopped = telemetry.snapshot(71000);
  assert.equal(stopped.frames_in_window, 0);
  assert.equal(stopped.receive_rate_hz, 0);
  assert.equal(stopped.last_frame_age_ms, 11000);
  assert.equal(telemetry.buckets.size, 0);
});

test('low-frequency sources get an observed cadence threshold rather than a fixed short timeout', () => {
  const telemetry = new ReceiveTelemetry(0);
  for (const time of [0, 30000, 60000, 90000]) telemetry.record(time);
  const health = telemetry.snapshot(110000);
  assert.equal(health.expected_interval_ms, 30000);
  assert.equal(health.interruption_threshold_ms, 120000);
  assert.equal(health.receive_rate_hz, 0, 'no frames in the recent window does not itself mean interrupted');
  telemetry.reset(150000);
  const reset = telemetry.snapshot(150000);
  assert.equal(reset.last_frame_age_ms, null);
  assert.equal(reset.frames_in_window, 0);
  assert.equal(reset.interruption_threshold_ms, null);
});

test('SDK telemetry counts only validated frames and resets on reconnect without changing raw batches', async t => {
  const batches = [], errors = [];
  const sdk = new SdkController({ origin: process.hrtime.bigint(), onBatch: batch => batches.push(batch),
    onError: error => errors.push(error), ensureLicense: async () => {} });
  sdk.state.loaded = true;
  sdk.module = { Shroom: { connectHandPad: async () => ({ state: 'open', close: async () => {} }) } };
  t.after(() => sdk.disconnect());
  await sdk.connect({ product: 'hand-pad', path: 'FIXTURE' });
  assert.equal(sdk.info().receive_health.last_frame_age_ms, null);
  assert.throws(() => sdk.frame({ raw: new Uint8Array(2) }, 'hand-pad'), /1024 raw ADC/);
  assert.equal(sdk.info().receive_health.frames_in_window, 0);
  const raw = Uint8Array.from({ length: 1024 }, (_, index) => index % 256);
  sdk.frame({ raw }, 'hand-pad');
  assert.equal(sdk.info().receive_health.frames_in_window, 1);
  assert.ok(sdk.info().receive_health.last_frame_age_ms >= 0);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].payload, Buffer.from(raw));
  assert.equal(batches[0].sampleCount, 1);
  assert.equal(sdk.info().ready, true, 'diagnostics do not modify recording readiness');
  await sdk.disconnect();
  await sdk.connect({ product: 'hand-pad', path: 'FIXTURE' });
  assert.equal(sdk.info().receive_health.frames_in_window, 0);
  assert.equal(sdk.info().receive_health.last_frame_age_ms, null);
  assert.equal(sdk.info().frames, 0);
  assert.deepEqual(errors, []);
});
