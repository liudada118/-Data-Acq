import type { CameraRecordingSource } from "./camera-types";

export interface MicrophoneOption { deviceId: string; label: string }
export interface MicrophoneConnection {
  instanceId: string;
  deviceId: string;
  label: string;
  stream: MediaStream;
  sampleRate: number;
  channels: 1;
  analyser: AnalyserNode;
  connected: boolean;
  error: string | null;
}
export interface UseMicrophoneCaptureOptions {
  online: boolean;
  recording: boolean;
  onDevicesChanged: () => Promise<void>;
}
export interface UseMicrophoneCaptureResult {
  devices: MicrophoneOption[];
  connections: Record<string, MicrophoneConnection>;
  busyIds: string[];
  scanning: boolean;
  error: string;
  scan(): Promise<void>;
  connect(instanceId: string, deviceId?: string): Promise<MicrophoneConnection>;
  disconnect(instanceId: string): Promise<void>;
  prepareRecording(instanceIds: string[]): Promise<CameraRecordingSource[]>;
  startRecording(sessionId: string): Promise<void>;
  recordingSessionId(): string | null;
  stopRecording(): Promise<void>;
  cancelPrepared(): Promise<void>;
}
