import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { CameraConnection } from "./camera-types";

interface CameraPreviewProps {
  connection: CameraConnection;
  paused: boolean;
  recording: boolean;
  recordingError?: string;
}

/** Playback is independent of capture: only the camera hook owns/stops tracks. */
export function CameraPreview({ connection, paused, recording, recordingError }: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const interrupted = connection.error || recordingError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = connection.stream;
    return () => { video.srcObject = null; };
  }, [connection.stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    setPlaybackBlocked(false);
    if (paused) video.pause();
    else void video.play().catch(() => { if (!cancelled) setPlaybackBlocked(true); });
    return () => { cancelled = true; };
  }, [connection.stream, paused]);

  function resumePlayback() {
    void videoRef.current?.play().then(() => setPlaybackBlocked(false)).catch(() => setPlaybackBlocked(true));
  }

  return (
    <div className="workspace-camera-preview">
      <div className="workspace-camera-stage">
        <video ref={videoRef} autoPlay={!paused} muted playsInline aria-label={`${connection.label}实时视频`} />
        <div className="workspace-camera-badge">
          <span className={`status-dot ${interrupted || recording ? "red" : "green"}`} />
          {interrupted ? "视频录制中断" : recording ? "正在录制视频" : "实时画面"}
        </div>
        {paused && (
          <div className="workspace-camera-paused" role="status">
            <Pause size={20} />
            <span>预览已暂停{interrupted ? "" : recording ? " · 录制继续" : " · 摄像头仍连接"}</span>
          </div>
        )}
        {playbackBlocked && !paused && (
          <button className="button secondary workspace-camera-play" onClick={resumePlayback}>
            <Play size={15} /><span>播放预览</span>
          </button>
        )}
      </div>
      <footer className="workspace-camera-footer">
        <span title={connection.label}>{connection.label}</span>
        <span className="mono">
          {connection.width > 0 && connection.height > 0 ? `${connection.width} × ${connection.height}` : "尺寸未知"}
          {connection.frameRate > 0 ? ` · ${Math.round(connection.frameRate * 10) / 10} fps` : " · 帧率未知"}
        </span>
      </footer>
    </div>
  );
}
