import type { CameraQuality } from "./types";

export interface RecordedStreamQuality extends CameraQuality {
  scope: "recorded-frames";
  jpeg_decode_verified: false;
  provenance: "manifest-snapshot";
  rescanned: false;
  validation: "not-rescanned";
  scan_record_count_matches: boolean | null;
}

export interface ContinuityAnomaly {
  type: string;
  time_s: number | null;
  interval_ms?: number | null;
  missing_records?: string;
  sequence?: string;
}

export interface ContinuityBucket {
  start_s: number;
  end_s: number;
  interval_count: number;
  gaps: number;
  max_gap_ms: number | null;
  sequence_gap_events: number;
  backward_timestamps: number;
  backward_host_timestamps?: number;
}

export interface ContinuityStream {
  id: string;
  name: string;
  sensor_label: string;
  kind: string;
  encoding?: string | null;
  time_basis: string;
  time_origin?: "recording_start" | "first_record" | null;
  seekable?: boolean;
  available: boolean;
  records: number;
  samples: number;
  interval_count: number;
  mean_hz: number | null;
  p50_interval_ms: number | null;
  p95_interval_ms: number | null;
  p99_interval_ms: number | null;
  max_gap_ms: number | null;
  max_gap_time_s: number | null;
  gaps_over_threshold: number;
  sequence_gap_events: number;
  sequence_missing_records: string;
  record_sequence_scope?: "application-records";
  recorded_quality?: RecordedStreamQuality | null;
  recorded_quality_status?: "available" | "unavailable" | "invalid";
  duplicate_sequences: number;
  backward_sequences: number;
  backward_timestamps: number;
  backward_host_timestamps?: number;
  duplicate_timestamps: number;
  source_bytes: number;
  validated_bytes: number;
  first_time_s: number | null;
  last_time_s: number | null;
  completion: "complete" | "partial" | "unavailable";
  scan_complete?: boolean;
  error: string | null;
  timeline: ContinuityBucket[];
  anomalies: ContinuityAnomaly[];
  anomalies_total: number;
  anomalies_truncated: boolean | number;
}

export interface ContinuityData {
  session_id: string;
  threshold_ms: number;
  source_status: string;
  application_dropped_records?: number | null;
  application_dropped_batches?: number | null;
  dropped_records?: number | null;
  dropped_batches?: number | null;
  source_error?: string | null;
  checked_at: string;
  duration_s: number;
  warnings: string[];
  quantile_method: string;
  streams: ContinuityStream[];
  media_streams: ContinuityMedia[];
  [key: string]: unknown;
}

export interface ContinuityMedia {
  id: string;
  name?: string;
  sensor_label?: string;
  kind?: string;
  available?: boolean;
  error?: string | null;
  validation?: string;
  declared_duration_s?: number | null;
  frame_loss?: "unknown";
  synchronization?: "unknown";
  missing_segments?: number;
  segment_gap_samples?: string;
  segment_overlap_samples?: string;
  notes?: string[];
  segments?: { index: number | null; file: string | null; start_sample: number | null; sample_count: number | null; duration_s: number | null;
    available: boolean; gap_before_samples: string | number | null; overlap_before_samples: string | number | null; error?: string | null }[];
  [key: string]: unknown;
}

export interface ContinuityJob {
  id: string;
  session_id: string;
  status: "running" | "complete" | "error" | "cancelled";
  threshold_ms: number;
  progress: number;
  scanned_bytes: number;
  total_bytes: number;
  current_stream_id: string | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  report?: ContinuityData | null;
}
