import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Activity, ArrowLeft, AudioLines, ChevronLeft, ChevronRight, Download, Grid2X2, Loader2, Maximize2, Minimize2, Pause, Play, RefreshCw, Settings2, Tag } from "lucide-react";
import { API_BASE, formatBytes, request } from "./api";
import { LivePreview } from "./LivePreview";
import { AnnotationPanel, AnnotationTimeline } from "./AnnotationPanel";
import { ExperimentDialog } from "./ExperimentDialog";
import { useAnnotations } from "./useAnnotations";
import { emptyExperiment, timeLabel } from "./workflow";
import { groupReplayStreams } from "./replay-layout";
import { workspaceViewportLayout } from "./viewport-layout";
import { useCardPositions, type CardPositionsController } from "./useCardPositions";
import { CardMoveHandle } from "./CardMoveHandle";
import { useMediaLayout } from "./useMediaLayout";
import { useCardSizes } from "./useCardSizes";
import { CardResizeControls } from "./CardResizeControls";
import type { Preview, Session } from "./types";

interface ReplayStream extends Preview {
  available: boolean;
  relative_time_s: number;
  note?: string;
  representation?: string;
  stale?: boolean;
  error?: string;
}
interface ReplayMediaSegment {
  index: number;
  file?: string;
  url?: string | null;
  offset_s: number | null;
  duration_s?: number | null;
  error?: string | null;
  note?: string;
}
interface ReplayMedia {
  id: string;
  name: string;
  url?: string | null;
  offset_s: number | null;
  duration_s?: number | null;
  note?: string;
  kind?: string;
  mime_type?: string;
  sample_rate?: number;
  channels?: number;
  available?: boolean;
  error?: string | null;
  segments?: ReplayMediaSegment[];
}

function RecordedAudio({ media, cursor, playing, speed }: { media: ReplayMedia; cursor: number; playing: boolean; speed: number }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [loadedSource, setLoadedSource] = useState("");
  const [error, setError] = useState("");
  const [manualIndex, setManualIndex] = useState<number | null>(null);
  const segments = media.segments?.length ? media.segments : [{ index: 0, url: media.url, offset_s: media.offset_s, duration_s: media.duration_s }];
  const playable = segments.filter(segment => segment.url);
  const timed = playable.filter(segment => segment.offset_s !== null).sort((a, b) => a.offset_s! - b.offset_s!);
  const active = timed.find(segment => cursor >= segment.offset_s! && (typeof segment.duration_s !== "number" || cursor < segment.offset_s! + segment.duration_s))
    ?? [...timed].reverse().find(segment => segment.offset_s! <= cursor)
    ?? timed[0] ?? playable.find(segment => segment.index === manualIndex) ?? playable[0];
  const source = active?.url ? `${API_BASE}${active.url}` : "";
  const offset = active?.offset_s ?? null;
  const outside = !active || offset !== null && (cursor < offset ||
    (typeof active.duration_s === "number" && cursor >= offset + active.duration_s));
  useEffect(() => { setLoadedSource(""); setError(""); }, [source]);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    element.playbackRate = speed;
    if (!playing || outside) element.pause();
    if (!source || loadedSource !== source || offset === null) return;
    const target = Math.max(0, cursor - offset);
    try {
      if (Math.abs(element.currentTime - target) > .35 || !playing)
        element.currentTime = Number.isFinite(element.duration) ? Math.min(element.duration, target) : target;
    } catch { /* WAV metadata may not yet have arrived after a seek. */ }
    let cancelled = false;
    if (playing && !outside) void element.play().catch(() => { if (!cancelled) setError("请点击音频控件播放以允许声音。"); });
    return () => { cancelled = true; };
  }, [cursor, playing, speed, loadedSource, source, offset, outside]);
  return <>
    <div className="replay-audio-content">
      <div className="replay-audio-label"><AudioLines size={30} aria-hidden="true" /><span>已保存音频<small>{media.sample_rate ? `${media.sample_rate.toLocaleString()} Hz · ` : ""}WAV{segments.length > 1 && ` · 第 ${active ? segments.indexOf(active) + 1 : "—"} / ${segments.length} 段`}</small></span></div>
      {source ? <audio ref={audio} controls preload="metadata" src={source}
        onLoadedMetadata={() => setLoadedSource(source)} onError={() => setError("无法读取该段音频，可下载 WAV 文件查看。")}
        onPlay={() => setError("")} />
        : <p className="replay-media-pending">此音频没有可播放的文件</p>}
      {segments.length === 1 && source && <a className="button secondary small" download href={source}><Download size={14} />下载 WAV</a>}
      {segments.length > 1 && <details className="replay-audio-segments"><summary>下载 {segments.length} 段 WAV</summary><div>
        {segments.map((segment, index) => <div key={segment.index}>
          <span>第 {index + 1} 段{typeof segment.duration_s === "number" ? ` · ${timeLabel(segment.duration_s)}` : ""}</span>
          {segment.url ? <a className="button secondary small" download href={`${API_BASE}${segment.url}`} aria-label={`下载第 ${index + 1} 段 WAV`}><Download size={14} />下载</a> : <span>文件不可用</span>}
          {segment.error && <small>{segment.error}</small>}
        </div>)}
      </div></details>}
      {timed.length === 0 && playable.length > 1 && <label className="replay-audio-segment-choice">独立播放分段<select aria-label="音频分段" value={active?.index ?? ""} onChange={event => setManualIndex(Number(event.target.value))}>{playable.map(segment => <option key={segment.index} value={segment.index}>第 {segments.indexOf(segment) + 1} 段</option>)}</select></label>}
    </div>
    <p className="replay-stream-note" title={media.note ?? "浏览器时间估计对齐，非硬件同步"}>{outside ? "此时刻不在可播放的音频片段内 · " : ""}{offset === null ? "缺少时间映射，请使用音频自身控件 · " : ""}{media.note ?? "浏览器时间估计对齐，非硬件同步"}</p>
    {media.error && <p className="workflow-error" role="status">{media.error}</p>}
    {error && <p className="workflow-error">{error}</p>}
  </>;
}
interface ReplayFrame {
  session_id: string;
  time_s: number;
  duration_s: number;
  streams: Record<string, ReplayStream>;
  media_streams: ReplayMedia[];
  incomplete?: boolean;
  warnings?: string[];
  stream_errors?: Record<string, string>;
  validation?: "on-demand-records" | "full-index";
}
function RecordedVideo({ media, cursor, playing, speed }: { media: ReplayMedia; cursor: number; playing: boolean; speed: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const outside = media.offset_s !== null && (cursor < media.offset_s || (typeof media.duration_s === "number" && Number.isFinite(media.duration_s) && cursor > media.offset_s + media.duration_s));
  useEffect(() => {
    const element = video.current;
    if (!element || !loaded || media.offset_s === null) return;
    const target = Math.max(0, cursor - media.offset_s);
    try { if (Math.abs(element.currentTime - target) > .35 || !playing) element.currentTime = Number.isFinite(element.duration) ? Math.min(element.duration, target) : target; }
    catch { /* Some containers expose seekability only after further data loads. */ }
    element.playbackRate = speed;
    if (playing && !outside) void element.play().catch(() => setError("浏览器未自动播放视频，可使用视频内的播放按钮。"));
    else element.pause();
  }, [cursor, playing, speed, loaded, media.offset_s, outside]);
  return <><div className="replay-video-wrap"><video ref={video} controls muted playsInline preload="metadata" src={`${API_BASE}${media.url}`} onLoadedMetadata={() => setLoaded(true)} onError={() => setError("此浏览器无法读取视频，可从导出包获取原始媒体。")} />{outside && <div className="replay-video-outside">此时刻不在该视频片段内</div>}</div><p className="replay-stream-note" title={media.note ?? "浏览器时间估计对齐，非硬件同步"}>{media.note ?? "浏览器时间估计对齐，非硬件同步"}{media.offset_s === null ? " · 缺少时间映射，使用视频自身控件回放" : ""}</p>{error && <p className="workflow-error">{error}</p>}</>;
}

function ReplayCardHeading({ name, status, focused, onFocus, move }: { name: string; status: string; focused: boolean; onFocus: () => void; move?: { positions: CardPositionsController; id: string } }) {
  return <header className={move?.positions.enabled ? "card-move-header" : undefined} {...(move?.positions.enabled ? move.positions.headerProps(move.id) : {})}>
    {move?.positions.enabled && <CardMoveHandle positions={move.positions} cardId={move.id} label={name} />}
    <div className="replay-stream-title"><h3 title={name}>{name}</h3><span title={status}>{status}</span></div>
    <button type="button" className="icon-button" aria-label={`${focused ? "还原" : "放大"}${name}回放`} aria-pressed={focused} onClick={onFocus}>
      {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button></header>;
}

export function SessionReplay({ session, onClose, onExport, onInspectContinuity, seekRequest }: { session: Session; onClose: () => void; onExport: () => void; onInspectContinuity?: () => void; seekRequest?: { time_s: number; key: number } }) {
  const duration = Math.max(0, Number(session.duration_s) || 0);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [mediaStreams, setMediaStreams] = useState<ReplayMedia[]>([]);
  const [replayWarnings, setReplayWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [settings, setSettings] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [page, setPage] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [streamViews, setStreamViews] = useState<Record<string, string>>({});
  const [viewport, setViewport] = useState({ width: 1100, height: 500 });
  const gridRef = useRef<HTMLDivElement>(null);
  const sensorGridRef = useRef<HTMLDivElement>(null);
  const labelButton = useRef<HTMLButtonElement>(null);
  const labelPanel = useRef<HTMLDivElement>(null);
  const target = useRef(cursor); target.current = cursor;
  const seekVersion = useRef(0);
  const annotations = useAnnotations(session.id);
  const allStreams = [...(session.streams ?? []), ...(session.media_streams ?? [])];
  const incomplete = session.status === "incomplete" || frame?.incomplete === true;
  const sensorGroups = groupReplayStreams(session.streams ?? []);
  const mediaChoices = [...(session.media_streams ?? []).map(media => ({ id: media.id, name: media.name, kind: media.kind })),
    ...mediaStreams.filter(media => !(session.media_streams ?? []).some(item => item.id === media.id))];
  const cardIds = [...sensorGroups.map(group => group.id), ...mediaChoices.map(media => `media:${media.id}`)];
  const focused = focusedId !== null && cardIds.includes(focusedId) ? focusedId : null;
  const mediaFocused = !!focused && focused.startsWith("media:");
  const cameraCount = mediaChoices.filter(media => media.kind !== "audio").length;
  const mediaLayout = useMediaLayout({ ...viewport, cameraCount, audioCount: mediaChoices.length - cameraCount,
    sensorCount: sensorGroups.length, focused: !!focused }, `replay:${session.id}`);
  const sensorViewport = mediaLayout.metrics.sensorViewport;
  const layout = workspaceViewportLayout(sensorViewport.width, sensorViewport.height, sensorGroups.length, false, sensorViewport.width < 620 ? 220 : 200);
  const sensorDefaultWidth = Math.max(1, (sensorViewport.width - (layout.columns - 1) * 10) / layout.columns - 1);
  const [resizingSensorId, setResizingSensorId] = useState<string | null>(null);
  const sensorDefaultHeight = Math.max(1, (sensorViewport.height - (layout.rows - 1) * 10) / layout.rows - 1);
  const sensorSizes = useCardSizes({ scope: `replay:${session.id}:sensors`, onResize: setResizingSensorId, cards: sensorGroups.map(group => ({ id: group.id, kind: "sensor" as const,
    defaultWidth: sensorDefaultWidth, defaultHeight: sensorDefaultHeight, maxWidth: Math.max(1, sensorViewport.width - 1), maxHeight: Math.max(1, sensorViewport.height - 1) })) });
  const sensorPositions = useCardPositions({ scope: `replay:${session.id}:sensors`, gridRef: sensorGridRef, layout,
    cards: sensorGroups.map(group => ({ id: group.id, width: sensorSizes.getSize(group.id).width, height: sensorSizes.getSize(group.id).height })),
    viewportWidth: sensorViewport.width, viewportHeight: sensorViewport.height, disabled: !!focused });
  const sensorGrid = sensorPositions.plan;
  const sensorPage = Math.max(0, Math.min(sensorGrid.pages.length - 1, (resizingSensorId ? sensorGrid.placements[resizingSensorId]?.page : undefined) ?? page));
  const pageRange = { ...sensorGrid.pages[sensorPage], page: sensorPage, pages: sensorGrid.pages.length };
  const visibleIds = new Set(focused ? [focused] : [...mediaChoices.map(media => `media:${media.id}`), ...sensorGroups.slice(pageRange.start, pageRange.end).map(group => group.id)]);
  const seek = (time: number) => { seekVersion.current++; setPlaying(false); setFrame(null); setCursor(Math.max(0, Math.min(duration, time))); };

  useEffect(() => {
    if (seekRequest && Number.isFinite(seekRequest.time_s)) seek(seekRequest.time_s);
  }, [seekRequest?.key, session.id]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const bounds = grid.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0)
        setViewport(previous => Math.abs(previous.width - bounds.width) < 1 && Math.abs(previous.height - bounds.height) < 1
          ? previous : { width: bounds.width, height: bounds.height });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(grid); window.addEventListener("resize", measure); measure();
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [session.id]);
  useEffect(() => { if (page !== pageRange.page) setPage(pageRange.page); }, [page, pageRange.page]);
  useEffect(() => {
    if (!showLabels) return;
    labelPanel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      event.preventDefault(); setShowLabels(false); labelButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [showLabels]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let last = -1;
    let lastVersion = -1;
    const controller = new AbortController();
    async function poll() {
      const wanted = target.current;
      const requestedVersion = seekVersion.current;
      if (wanted !== last || requestedVersion !== lastVersion) {
        setLoading(true);
        try {
          const next = await request<ReplayFrame>(`/api/sessions/${encodeURIComponent(session.id)}/replay?time_s=${wanted.toFixed(6)}`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
          if (stopped) return;
          if (requestedVersion === seekVersion.current) {
            setFrame(next);
            setReplayWarnings([...new Set([...(next.warnings ?? []), ...Object.entries(next.stream_errors ?? {}).map(([id, message]) => `${allStreams.find(stream => stream.id === id)?.name ?? id}：${message}`)])]);
            // Seeking clears sampled sensor frames, never the mounted media elements.
            setMediaStreams(previous => {
              const nextById = new Map(previous.map(media => [media.id, media]));
              for (const media of next.media_streams ?? []) nextById.set(media.id, media);
              const merged = [...nextById.values()];
              return JSON.stringify(previous) === JSON.stringify(merged) ? previous : merged;
            });
            last = wanted; lastVersion = requestedVersion; setError("");
          }
        } catch (cause) {
          if (stopped) return;
          setError(cause instanceof Error ? cause.message : "回放加载失败"); setPlaying(false); setLoading(false); return;
        }
        if (!stopped) setLoading(false);
      }
      if (!stopped) timer = setTimeout(poll, 180);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [session.id, retry]);
  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(), delta = (now - previous) / 1000 * speed; previous = now;
      setCursor(current => Math.min(duration, current + delta));
    }, 200);
    return () => clearInterval(timer);
  }, [playing, speed, duration]);
  useEffect(() => { if (cursor >= duration) setPlaying(false); }, [cursor, duration]);

  return <section className="session-replay replay-workspace" aria-label="录制回放与标注">
    <div className="replay-page-heading"><button className="button secondary small replay-back" aria-label="返回录制记录" title="返回录制记录" onClick={onClose}><ArrowLeft size={15} /><span>返回录制记录</span></button><div className="replay-session-title"><h1 title={session.name}>{session.name}</h1><p>{timeLabel(duration)} · {allStreams.length} 路数据 · {formatBytes(session.bytes_written)}</p></div><div className="replay-heading-actions">{cardIds.length > 0 && <button className="button secondary small" onClick={() => { mediaLayout.reset(); sensorGroups.forEach(group => sensorSizes.reset(group.id)); setResizingSensorId(null); setPage(0); }} title="恢复按窗口自动排布">恢复卡片大小</button>}{onInspectContinuity && <button className="button secondary small" aria-label="检查数据连续性" title="检查数据连续性" onClick={onInspectContinuity}><Activity size={15} /><span>检查连续性</span></button>}<button className="button secondary small" aria-label="实验信息" title="实验信息" onClick={() => setSettings(true)} disabled={!annotations.document}><Settings2 size={15} /><span>实验信息</span></button><button ref={labelButton} className="button secondary small" aria-label={showLabels ? "收起标签面板" : "显示标签面板"} aria-pressed={showLabels} aria-expanded={showLabels} aria-controls="replay-annotations" onClick={() => setShowLabels(!showLabels)}><Tag size={15} />标签</button><button className="button primary small" aria-label="导出数据与标签" title="导出数据与标签" onClick={onExport}><Download size={15} /><span>导出数据与标签</span></button></div></div>
        <section className="replay-controls" aria-label="回放时间控制"><div className="replay-transport"><button className="button primary small" aria-label={playing ? "暂停回放" : "播放录制"} disabled={Boolean(error) || !frame || duration <= 0} onClick={() => { if (cursor >= duration) setCursor(0); setPlaying(!playing); }}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "暂停" : "播放"}</button><span className="mono">{timeLabel(cursor)}<small> / {timeLabel(duration)}</small></span><label>速度<select aria-label="回放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label><label className="replay-jump">跳转 / 秒<input type="number" aria-label="回放时间秒数" min={0} max={duration} step="0.1" value={Number(cursor.toFixed(3))} onChange={event => { if (event.target.value !== "") seek(Number(event.target.value)); }} /></label></div>
          <input className="replay-range" aria-label="回放时间轴" type="range" min={0} max={duration || 1} step="0.001" value={cursor} onChange={event => seek(Number(event.target.value))} />
          <AnnotationTimeline annotations={annotations.document?.annotations ?? []} duration={duration} cursor={cursor} onSeek={seek} />
          <div className="replay-loading-line" role="status">{loading && !frame ? <><Loader2 size={13} className="spin" />正在定位已保存的数据…</> : <><span className="status-dot green" />按录制时间定位 · {incomplete ? "可读部分预览，缺损信息保留" : "抽样预览，导出保留原始数据"}</>}</div>
        </section>
    {(incomplete || replayWarnings.length > 0) && <details className="replay-integrity"><summary>{incomplete ? "数据不完整 · 仅回放可读部分" : "此录制存在数据异常"} · 查看说明</summary><div>
      {session.error && <p role="status">录制停止原因：{session.error}</p>}
      <p>按需读取当前记录，不代表已逐条验证整段录制；缺失或损坏的数据不会补齐，原始状态保持不变。</p>
      {replayWarnings.length > 0 && <ul>{replayWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </div></details>}
    <div className={`replay-layout ${showLabels ? "with-annotations" : ""}`}>
      <div className="replay-main" inert={showLabels}>
        {error && <div className="workflow-error replay-error" role="alert"><span>{error}</span><button className="button secondary small" onClick={() => { setError(""); setRetry(value => value + 1); }}><RefreshCw size={14} />重新读取</button></div>}
        <div ref={gridRef} style={mediaLayout.style} className={`media-sensor-layout independent-card-layout bounded-board-layout ${viewport.width < 760 ? "media-stacked" : ""} ${mediaChoices.length ? "has-media-rail" : ""} ${sensorGroups.length ? "has-sensor-grid" : ""} ${focused ? mediaFocused ? "media-is-focused" : "sensor-is-focused" : ""}`}>
          <aside className={`media-rail ${mediaChoices.some(media => media.kind !== "audio") ? "has-camera" : "audio-only"}`} aria-label="回放影像与声音" hidden={!mediaChoices.length || !!focused && !mediaFocused}>
          {[...mediaChoices].sort((a, b) => Number(a.kind === "audio") - Number(b.kind === "audio")).flatMap((choice, index) => {
            const media = mediaStreams.find(item => item.id === choice.id);
            const id = `media:${choice.id}`;
            const audio = choice.kind === "audio" || media?.kind === "audio" || media?.mime_type?.startsWith("audio/");
            const card = <article className={`replay-stream-card independent-card bounded-media-card ${audio ? "replay-audio-card" : "replay-video-card"}`} key={id}
              style={focused === id ? { width: Math.max(1, viewport.width - 1), height: Math.max(1, viewport.height - 1) } : { width: "100%", height: audio ? mediaLayout.metrics.audioHeight : mediaLayout.metrics.cameraHeight }}
              data-replay-id={id} aria-label={`${choice.name}回放卡片`} hidden={!visibleIds.has(id)}>
              <ReplayCardHeading name={choice.name} status={media?.error ? "包含缺损 · 查看可用部分" : audio ? "已保存音频" : "已保存视频"} focused={focused === id} onFocus={() => setFocusedId(focused === id ? null : id)} />
              {media && (media.url || media.segments?.length) ? audio ? <RecordedAudio media={media} cursor={cursor} playing={playing} speed={speed} />
                : <RecordedVideo media={media} cursor={cursor} playing={playing} speed={speed} />
                : <div className="replay-media-pending" role="status">{media?.error ?? (loading ? "正在读取媒体信息…" : "未提供可回放的媒体文件")}</div>}
              
            </article>;
            return index === cameraCount && mediaLayout.metrics.splitHeight
              ? [<div key="media-height-divider" className="media-resize-handle media-resize-height" {...mediaLayout.separatorProps("camera")}><span>↕ 麦克风高度</span></div>, card] : [card];
          })}
          </aside>
          {mediaLayout.metrics.splitWidth && <div className="media-resize-handle media-resize-width" {...mediaLayout.separatorProps("width")} />}
          <div ref={sensorGridRef} className={`replay-stream-grid ${focused ? "replay-single-view" : ""}`} hidden={!sensorGroups.length && mediaChoices.length > 0 || mediaFocused}
            style={{ "--replay-columns": focused ? 1 : layout.columns, "--replay-rows": focused ? 1 : layout.rows } as CSSProperties}>
          {sensorGroups.map(group => {
            const selected = group.streams.find(stream => stream.id === streamViews[group.id]) ?? group.streams[0];
            const currentSnapshot = frame?.streams[selected.id];
            return <article className={`replay-stream-card independent-card independent-size-card ${sensorPositions.draggingId === group.id ? "card-is-moving" : ""}`} key={group.id} data-replay-id={group.id}
              style={focused === group.id ? { width: Math.max(1, viewport.width - 1), height: Math.max(1, viewport.height - 1) } : {
                ...sensorSizes.style(group.id), gridColumn: (sensorGrid.placements[group.id]?.columnSpan ?? 1) > 1
                  ? `${sensorGrid.placements[group.id]?.column} / span ${sensorGrid.placements[group.id]?.columnSpan}` : sensorGrid.placements[group.id]?.column,
                gridRow: `${sensorGrid.placements[group.id]?.row} / span ${sensorGrid.placements[group.id]?.rowSpan}`,
              }}
              aria-label={`${group.name}回放卡片`} hidden={!visibleIds.has(group.id)}>
              <ReplayCardHeading name={group.name} status={[currentSnapshot?.available ? `T+ ${currentSnapshot.relative_time_s.toFixed(3)} s` : currentSnapshot?.error ? "该流暂不可回放" : "等待该流数据", currentSnapshot?.note, currentSnapshot?.stale ? "此帧距游标较远" : ""].filter(Boolean).join(" · ")}
                focused={focused === group.id} onFocus={() => setFocusedId(focused === group.id ? null : group.id)} move={{ positions: sensorPositions, id: group.id }} />
              {group.streams.length > 1 && <div className="replay-stream-tabs" role="group" aria-label={`${group.name}回放数据`}>
                {group.streams.map(stream => <button type="button" key={stream.id} aria-pressed={selected.id === stream.id}
                  onClick={() => setStreamViews(previous => ({ ...previous, [group.id]: stream.id }))}>{stream.kind === "pressure" ? "压力" : "IMU"}</button>)}
                <span>同一设备 · {group.streams.length} 路数据</span>
              </div>}
              {group.streams.map(device => {
                const snapshot = frame?.streams[device.id];
                const replayDevice = snapshot?.pressure ? { ...device, rows: snapshot.pressure.rows, cols: snapshot.pressure.cols } : device;
                return <div key={device.id} className="replay-sensor-view" data-stream-id={device.id} hidden={selected.id !== device.id}>
                  {snapshot?.error ? <p className="replay-unavailable" role="status">{snapshot.error}</p> : <LivePreview device={replayDevice} enabled connected paused={false} embedded cardContentFullscreen snapshot={snapshot?.available || snapshot?.camera?.preview_status ? snapshot : null} />}
                  {(snapshot?.note || snapshot?.stale) && <p className="replay-stream-note" title={[snapshot.note, snapshot.stale ? "显示该时刻之前的最近数据，距离游标较远。" : ""].filter(Boolean).join(" · ")}>{snapshot.note}{snapshot.stale && " · 此帧距游标较远"}</p>}
                  {snapshot?.imu && <div className="replay-imu-values">{snapshot.imu.values.map((value, index) => <span key={index}>{["ax", "ay", "az", "gx", "gy", "gz"][index] ?? index}: {value.toFixed(3)}</span>)}</div>}
                </div>;
              })}
              {focused !== group.id && <CardResizeControls sizes={sensorSizes} cardId={group.id} allowFullHeight label={group.name} />}
            </article>;
          })}
          {sensorPositions.indicatorStyle && <div className={`card-drop-target ${sensorPositions.swapTargetId ? "card-swap-target" : ""}`} style={sensorPositions.indicatorStyle} aria-hidden="true"><span>{sensorPositions.indicatorLabel}</span></div>}
          {cardIds.length === 0 && <div className="replay-empty">此录制没有可展示的数据流。</div>}
          </div>
        </div>
        <span className="card-move-announcement" role="status" aria-live="polite">{sensorPositions.announcement}</span>
        <footer className="replay-pagination">
          {focused ? <button className="button secondary small" onClick={() => setFocusedId(null)}><Grid2X2 size={14} />返回全部数据源</button>
            : <span>{mediaChoices.length > 0 && `影像与声音 ${mediaChoices.length} 路 · `}{sensorGroups.length ? `${pageRange.start + 1}–${pageRange.end} / ${sensorGroups.length} 个传感器` : "全部媒体已展示"}<span className="replay-page-note"> · 所有音视频跟随时间轴</span></span>}
          {!focused && pageRange.pages > 1 && <div role="group" aria-label="回放分页">
            <button className="icon-button" aria-label="上一屏回放" disabled={pageRange.page === 0} onClick={() => { setResizingSensorId(null); setPage(pageRange.page - 1); }}><ChevronLeft size={15} /></button>
            <span>{pageRange.page + 1} / {pageRange.pages}</span>
            <button className="icon-button" aria-label="下一屏回放" disabled={pageRange.page + 1 === pageRange.pages} onClick={() => { setResizingSensorId(null); setPage(pageRange.page + 1); }}><ChevronRight size={15} /></button>
          </div>}
        </footer>
      </div>
      {showLabels && <button type="button" tabIndex={-1} className="replay-annotation-backdrop" aria-label="关闭标签面板" onClick={() => { setShowLabels(false); labelButton.current?.focus({ preventScroll: true }); }} />}
      <div id="replay-annotations" ref={labelPanel} className="replay-annotation-column" role="region" aria-label="回放标签面板" hidden={!showLabels}><AnnotationPanel document={annotations.document} live={false} busy={annotations.busy} error={annotations.error} streams={allStreams} cursor={cursor} duration={duration} onMutate={annotations.mutate} onSettings={() => setSettings(true)} onClose={() => { setShowLabels(false); labelButton.current?.focus({ preventScroll: true }); }} onSeek={seek} /></div>
    </div>
    {settings && annotations.document && <ExperimentDialog value={{ experiment: { ...emptyExperiment(), ...annotations.document.experiment }, labels: annotations.document.labels }} busy={annotations.busy} error={annotations.error} onClose={() => setSettings(false)} onSave={async draft => { if (await annotations.updateContext(draft)) setSettings(false); }} />}
  </section>;
}
