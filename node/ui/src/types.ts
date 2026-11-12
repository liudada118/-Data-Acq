export type DeviceKind = "camera" | "audio" | "pressure" | "imu";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  transport: string;
  sample_rate: number;
  sample_rate_known?: boolean;
  unit: string;
  channels: number;
  mode: string;
  connected: boolean;
  width?: number;
  height?: number;
  rows?: number;
  cols?: number;
  dtype?: string;
  shape?: number[];
  preview_supported?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Status {
  state: "idle" | "recording" | "stopping" | "error";
  engine_alive?: boolean;
  session_id: string | null;
  elapsed_s: number;
  bytes_written: number;
  queue_depth: number;
  queue_capacity: number;
  dropped_records: number;
  record_counts: Record<string, number>;
  media_chunk_counts?: Record<string, number>;
  camera_uploads_pending?: number;
  camera_stop_requires_owner?: boolean;
  selected_ids: string[];
  error?: string;
}

export type GloveFingerId = "thumb" | "index" | "middle" | "ring" | "little";

/** Raw ADC in SDK physical-point order; independent from the legacy 13×15 matrix. */
export interface GlovePressurePreview {
  side: "left" | "right";
  fingers: Record<GloveFingerId, {
    values: number[];
    pulp: number | null;
    source_indices: number[];
    pulp_source_index: number;
  }>;
  palm: { values: number[]; row_lengths: number[]; source_indices: number[] };
}

export interface PressurePreview {
  rows: number;
  cols: number;
  values: number[];
  full_scale?: number;
  glove?: GlovePressurePreview;
  regions?: { id: string; name: string; rows: number; cols: number; values: number[] }[];
  points?: { row: number; col: number; x_mm: number; y_mm: number; value: number }[];
}

export interface CameraQuality {
  observed_frames: number;
  source_sequence_status: "unknown" | "available" | "partial";
  source_sequence_supported: boolean;
  source_indexed_frames: number;
  source_unindexed_frames: number;
  source_missing_frames: string | null;
  source_gap_events: number | null;
  source_duplicates: number | null;
  source_reversals: number | null;
  invalid_jpeg_frames: number;
  jpeg_warning_frames: number;
}

export interface Preview {
  timestamp_s: number;
  streams?: Record<string, Omit<Preview, "streams">>;
  raw?: { values: number[]; encoding: string };
  pressure?: PressurePreview;
  imu?: { values: number[] };
  audio?: { waveform: number[]; rms: number };
  camera?: {
    width: number;
    height: number;
    rgb_base64?: string;
    jpeg_base64?: string;
    jpeg_bytes?: Uint8Array<ArrayBuffer>;
    binary_preview?: boolean;
    sequence: number;
    quality?: CameraQuality;
    jpeg_status?: unknown;
    preview_status?: "invalid-jpeg" | "jpeg-too-large" | "unsupported-jpeg";
  };
  status?: Status;
}

export interface AudioSegment {
  index: number;
  file: string;
  start_sample: number;
  sample_count: number;
  payload_bytes: number;
  bytes: number;
  duration_ms: number;
  finalized: boolean;
  error?: string | null;
}

export interface Session {
  id: string;
  name: string;
  started_at: string;
  ended_at?: string;
  duration_s: number;
  device_ids: string[];
  bytes_written: number;
  record_count: number;
  record_counts?: Record<string, number>;
  dropped_records?: number;
  source: string;
  status: string;
  finalized?: boolean;
  error?: string | null;
  streams?: (Device & { file?: string; records?: number; samples?: number; error?: string | null })[];
  media_streams?: (Device & {
    file?: string;
    mime_type: string;
    chunks: number;
    bytes: number;
    finalized: boolean;
    error?: string | null;
    duration_ms?: number;
    segments?: AudioSegment[];
  })[];
  [key: string]: unknown;
}

export interface Profile {
  id: string;
  name: string;
  device_ids: string[];
}
export interface ExportFormat {
  id: string;
  label: string;
  available: boolean;
  description: string;
}
export interface ExportJob {
  id: string;
  session_id: string;
  format: string;
  status: "pending" | "running" | "complete" | "error";
  progress: number;
  filename?: string;
  error?: string;
  download_url?: string;
  recovery?: boolean;
}

export interface RecoveryReport {
  session_id: string;
  source_status: string;
  source_finalized: boolean;
  recovery: true;
  incomplete: true;
  checked_at: string;
  has_data: boolean;
  dropped_records: number | null;
  error: string | null;
  warnings: string[];
  inspection_mode?: "metadata" | "records";
  fully_scanned?: boolean;
  streams: {
    id: string;
    name: string;
    kind: string;
    records: number;
    samples: number;
    payload_bytes: number;
    start_s: number | null;
    end_s: number | null;
    observed_span_s: number | null;
    nominal_sample_duration_s: number | null;
    record_sequence_gaps: string | null;
    error: string | null;
    validation?: "metadata" | "prefix";
    available?: boolean;
    verified?: boolean;
    counts_verified?: boolean;
    declared_records?: number;
    declared_samples?: number;
    declared_payload_bytes?: number;
  }[];
  media_streams: {
    id: string;
    name: string;
    kind: string;
    file: string;
    chunks: number;
    bytes: number;
    samples: number | null;
    duration_s: number | null;
    finalized: boolean;
    error: string | null;
    attachment_only: boolean;
    playback_verified: false;
    available?: boolean;
    segments?: (Partial<AudioSegment> & { index: number; file: string; available?: boolean; attachment_only?: boolean })[];
  }[];
}

export interface LogEntry {
  id: number;
  time: string;
  message: string;
  level: "info" | "success" | "error";
}
