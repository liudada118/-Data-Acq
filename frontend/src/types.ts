export type DeviceKind = "camera" | "audio" | "pressure" | "imu";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  transport: string;
  sample_rate: number;
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
}

export interface Status {
  state: "idle" | "recording" | "stopping" | "error";
  session_id: string | null;
  elapsed_s: number;
  bytes_written: number;
  queue_depth: number;
  queue_capacity: number;
  dropped_records: number;
  record_counts: Record<string, number>;
  selected_ids: string[];
  error?: string;
}

export interface Preview {
  timestamp_s: number;
  pressure?: { rows: number; cols: number; values: number[] };
  imu?: { values: number[] };
  audio?: { waveform: number[]; rms: number };
  camera?: {
    width: number;
    height: number;
    rgb_base64: string;
    sequence: number;
  };
  status?: Status;
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
  streams?: (Device & { file?: string; records?: number; samples?: number })[];
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
}

export interface LogEntry {
  id: number;
  time: string;
  message: string;
  level: "info" | "success" | "error";
}
