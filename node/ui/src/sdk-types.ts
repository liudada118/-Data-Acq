export type SdkProduct = "hand-pad" | "glove" | "body" | "insole" | "mock";
export type InsoleProtocol = "12bit" | "8bit";
export type GloveProtocol = "segmented" | "full-packet";
export const INSOLE_BAUD_RATES = [921600, 1500000, 3000000, 460800, 256000, 115200, 9600] as const;
export type InsoleBaudRate = typeof INSOLE_BAUD_RATES[number];
export const SDK_PRODUCTS: readonly SdkProduct[] = ["hand-pad", "glove", "body", "insole", "mock"];
export const sdkHasImu = (product: SdkProduct) => product === "glove" || product === "insole";

export interface SdkReceiveHealth {
  sampled_at_monotonic_ms: number;
  observed_ms: number;
  last_frame_age_ms: number | null;
  receive_rate_hz: number | null;
  rate_window_ms: number;
  frames_in_window: number;
  expected_interval_ms: number | null;
  interruption_threshold_ms: number | null;
}

interface SdkState {
  loaded: boolean;
  connected: boolean;
  ready?: boolean;
  connecting?: boolean;
  has_device?: boolean;
  product?: SdkProduct | null;
  side?: "left" | "right" | null;
  protocol?: InsoleProtocol | GloveProtocol | null;
  baudRate?: InsoleBaudRate | null;
  path?: string | null;
  device_id?: string | null;
  frames?: number;
  last_frame_at?: string | number | null;
  receive_health?: SdkReceiveHealth;
  error?: string | null;
  connection_state?: string | null;
  root?: string | null;
  version?: string | null;
  source?: string | null;
  mode?: string | null;
  license_configured?: boolean;
}

export interface SdkInstanceInfo extends SdkState {
  instance_id: string;
  stream_ids: string[];
}

export interface SdkInfo extends SdkState {
  instance_id?: string;
  stream_ids?: string[];
  instances?: SdkInstanceInfo[];
}

export interface SdkConnectionInput {
  instance_id: string;
  product: SdkProduct;
  path?: string;
  side?: "left" | "right";
  protocol?: InsoleProtocol;
  gloveProtocol?: GloveProtocol;
  baudRate?: InsoleBaudRate;
  mode?: "mock";
}

export interface SerialPort {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}
