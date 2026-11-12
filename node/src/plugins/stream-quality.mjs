/** Source counters are independent of the application's contiguous record sequence. */
export function createStreamQuality() {
  return { observed: 0, indexed: 0, unindexed: 0, previous: null, afterReversal: false, missing: 0n, gaps: 0, duplicates: 0, reversals: 0, invalidJpeg: 0, warningJpeg: 0 };
}

export function observeStreamQuality(state, sourceSequence, jpegStatus) {
  state.observed++;
  if (jpegStatus?.status === 'invalid') state.invalidJpeg++;
  else if (jpegStatus?.status === 'warning') state.warningJpeg++;
  const event = { source_sequence_status: 'unknown', source_sequence_gap: null };
  if (sourceSequence === null || sourceSequence === undefined) {
    state.unindexed++;
    // A received frame without an index must not be miscounted as a later gap.
    state.previous = null;
    state.afterReversal = false;
    return event;
  }
  const value = BigInt(sourceSequence);
  state.indexed++;
  event.source_sequence_status = state.previous === null ? 'first' : 'continuous';
  event.source_sequence_gap = '0';
  if (state.previous !== null) {
    const delta = value - state.previous;
    if (delta > 0n && state.afterReversal) {
      // 100,99,101 may be out of order rather than a reset. Do not count the
      // already-observed 100 as missing; this ambiguous boundary is unmeasured.
      event.source_sequence_status = 'first'; state.afterReversal = false;
    } else if (delta > 1n) {
      const missing = delta - 1n;
      state.missing += missing; state.gaps++;
      event.source_sequence_status = 'gap'; event.source_sequence_gap = missing.toString();
    } else if (delta === 0n) {
      state.duplicates++; event.source_sequence_status = 'duplicate';
    } else if (delta < 0n) {
      state.reversals++; state.afterReversal = true; event.source_sequence_status = 'reversal';
    }
  }
  // A reversal/reset starts a new comparison span; never invent a wrap size.
  state.previous = value;
  return event;
}

export function streamQualitySnapshot(state) {
  const known = state.indexed > 0;
  return {
    observed_frames: state.observed,
    source_sequence_status: !known ? 'unknown' : state.unindexed || state.reversals ? 'partial' : 'available',
    source_sequence_supported: known,
    source_indexed_frames: state.indexed, source_unindexed_frames: state.unindexed,
    source_missing_frames: known ? state.missing.toString() : null,
    source_gap_events: known ? state.gaps : null,
    source_duplicates: known ? state.duplicates : null,
    source_reversals: known ? state.reversals : null,
    invalid_jpeg_frames: state.invalidJpeg, jpeg_warning_frames: state.warningJpeg,
  };
}
