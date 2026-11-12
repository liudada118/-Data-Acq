// Receive telemetry is diagnostic only. It never changes capture readiness,
// records, timestamps, or session completeness. Buckets bound memory even when
// a device sends a large burst of frames.
const BUCKET_MS = 100;
const WINDOW_BUCKETS = 100;
const BASELINE_INTERVALS = 3;

export class ReceiveTelemetry {
  constructor(nowMs) { this.reset(nowMs); }

  reset(nowMs) {
    this.startedMs = nowMs;
    this.lastMs = null;
    this.buckets = new Map();
    this.intervals = [];
  }

  prune(nowMs) {
    const oldest = Math.floor(nowMs / BUCKET_MS) - WINDOW_BUCKETS + 1;
    for (const key of this.buckets.keys()) if (key < oldest) this.buckets.delete(key);
    return oldest;
  }

  record(nowMs) {
    this.prune(nowMs);
    if (this.lastMs !== null && nowMs > this.lastMs) {
      this.intervals.push(nowMs - this.lastMs);
      if (this.intervals.length > 31) this.intervals.shift();
    }
    this.lastMs = nowMs;
    const bucket = Math.floor(nowMs / BUCKET_MS);
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
  }

  snapshot(nowMs) {
    const oldest = this.prune(nowMs);
    const observedMs = Math.max(0, nowMs - this.startedMs);
    const windowMs = Math.max(0, nowMs - Math.max(this.startedMs, oldest * BUCKET_MS));
    const count = [...this.buckets.values()].reduce((sum, value) => sum + value, 0);
    const intervals = this.intervals.length >= BASELINE_INTERVALS ? [...this.intervals].sort((a, b) => a - b) : [];
    const expected = intervals.length ? intervals[Math.floor(intervals.length / 2)] : null;
    return {
      sampled_at_monotonic_ms: nowMs,
      observed_ms: observedMs,
      last_frame_age_ms: this.lastMs === null ? null : Math.max(0, nowMs - this.lastMs),
      receive_rate_hz: windowMs >= 1000 ? count * 1000 / windowMs : null,
      rate_window_ms: windowMs,
      frames_in_window: count,
      expected_interval_ms: expected,
      // Unknown/initial rates have no asserted interruption deadline. Once a
      // baseline exists, tolerate four observed periods and at least 10 seconds.
      interruption_threshold_ms: expected === null ? null : Math.max(10000, expected * 4),
    };
  }
}
