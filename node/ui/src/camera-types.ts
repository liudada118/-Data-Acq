export type CameraQuality = "720p" | "1080p";

export interface CameraOption {
  deviceId: string;
  label: string;
}

export interface CameraConnection {
  instanceId: string;
  deviceId: string;
  label: string;
  stream: MediaStream;
  width: number;
  height: number;
  frameRate: number;
  quality: CameraQuality;
  connected: boolean;
  error: string | null;
}

/** Only pass to the local session-start request; never persist the token. */
export interface CameraRecordingSource {
  instance_id: string;
  token: string;
  mime_type: string;
}

export interface UseCameraCaptureOptions {
  online: boolean;
  recording: boolean;
  onDevicesChanged: () => Promise<void>;
}

export interface UseCameraCaptureResult {
  devices: CameraOption[];
  connections: Record<string, CameraConnection>;
  busyIds: string[];
  scanning: boolean;
  error: string;
  scan(): Promise<void>;
  connect(instanceId: string, deviceId?: string, quality?: CameraQuality): Promise<CameraConnection>;
  disconnect(instanceId: string): Promise<void>;
  prepareRecording(instanceIds: string[]): Promise<CameraRecordingSource[]>;
  startRecording(sessionId: string): Promise<void>;
  recordingSessionId(): string | null;
  stopRecording(): Promise<void>;
  cancelPrepared(): Promise<void>;
}
