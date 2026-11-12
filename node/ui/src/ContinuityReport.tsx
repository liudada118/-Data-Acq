import { useEffect, useId, useRef, useState } from "react";
import { Activity, AlertCircle, Download, Play, RefreshCw, Square, X } from "lucide-react";
import { formatBytes, formatDate, formatDuration } from "./api";
import { cancelContinuityJob, getContinuityJob, startContinuityJob } from "./continuity-client";
import type { ContinuityAnomaly, ContinuityBucket, ContinuityData, ContinuityJob, ContinuityMedia, ContinuityStream } from "./continuity-types";
import type { Session } from "./types";

const message = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试。";
const number = (value: number | null | undefined, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const time = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${formatDuration(value)}.${Math.floor(value % 1 * 1000).toString().padStart(3, "0")}` : "时间未知";
const count = (value: string | null | undefined) => typeof value === "string" && /^\d+$/.test(value) ? value.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "未验证";
const nonzero = (value: string) => /^\d+$/.test(value) && /[1-9]/.test(value);

function Timeline({ buckets, threshold, timeOrigin }: { buckets: ContinuityBucket[]; threshold: number; timeOrigin?: ContinuityStream["time_origin"] }) {
  const shown = buckets.slice(0, 240), max = Math.max(threshold, ...shown.map(item => item.max_gap_ms ?? 0), 1);
  const width = 720, height = 64, bar = width / Math.max(1, shown.length);
  if (!shown.length) return null;
  return <div className="continuity-timeline">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="帧间隔时间分布：每柱表示一个时间窗口的最长间隔，虚线表示预警阈值">
      {shown.map((item, index) => item.interval_count > 0 && <rect key={`${item.start_s}-${index}`} x={index * bar} width={Math.max(.5, bar - 1)}
        y={height - Math.max(2, (item.max_gap_ms ?? 0) / max * (height - 4))} height={Math.max(2, (item.max_gap_ms ?? 0) / max * (height - 4))}
        className={item.gaps > 0 ? "continuity-bar-warning" : "continuity-bar"}>
        <title>{time(item.start_s)} – {time(item.end_s)}：最长 {number(item.max_gap_ms)} ms，超阈 {item.gaps} 次</title>
      </rect>)}
      <line x1="0" x2={width} y1={height - threshold / max * (height - 4)} y2={height - threshold / max * (height - 4)} className="continuity-threshold-line" />
    </svg>
    <div className="continuity-timeline-labels"><span>{time(shown[0].start_s)}</span><span>窗口最长间隔 · 虚线 {number(threshold)} ms</span><span>{time(shown.at(-1)?.end_s)}</span></div>
    {timeOrigin === "first_record" && <p className="continuity-hint">录制起点未知；图中时间相对于这一路首条可读记录，不能据此定位录制回放。</p>}
    {buckets.length > shown.length && <p className="continuity-hint">概览显示前 {shown.length} 个时间窗，完整结果见 JSON 报告。</p>}
  </div>;
}

function anomalyText(item: ContinuityAnomaly) {
  if (item.type === "gap" || item.type === "interval_gap" || item.type === "gap_over_threshold") return `间隔 ${number(item.interval_ms)} ms`;
  if (item.type === "sequence_gap") return `应用序号缺失 ${count(item.missing_records)} 条`;
  if (item.type === "backward_timestamp" || item.type === "timestamp_backwards") return "记录时间倒退";
  if (item.type === "backward_host_timestamp") return "主机时间倒退";
  if (item.type === "duplicate_timestamp") return "记录时间重复";
  if (item.type === "backward_sequence") return "应用序号倒退";
  if (item.type === "duplicate_sequence") return "应用序号重复";
  return `记录异常：${item.type}`;
}

function MediaResult({ media }: { media: ContinuityMedia }) {
  const audio = media.kind === "audio", badSegments = (media.segments ?? []).filter(segment => !segment.available || segment.error || Number(segment.gap_before_samples) > 0 || Number(segment.overlap_before_samples) > 0);
  return <article className="continuity-media" aria-label={`${media.sensor_label || media.name || media.id}媒体检查范围`}>
    <strong>{media.sensor_label || media.name || media.id}</strong><span>{audio ? "音频分段与文件头检查" : "视频元信息检查"}</span>
    <p>实际采集掉帧：未知 · 多设备同步：未检测</p>
    {audio && <p>不可用分段 {number(media.missing_segments, 0)} · 分段空隙 {count(media.segment_gap_samples)} 样本 · 分段重叠 {count(media.segment_overlap_samples)} 样本</p>}
    <p className="continuity-hint">清单声明时长 {typeof media.declared_duration_s === "number" ? formatDuration(media.declared_duration_s) : "未知"}；不等于连续信号已经验证。</p>
    {media.notes?.map((note, index) => <p className="continuity-hint" key={index}>{note}</p>)}
    {media.error && <p className="continuity-error">{media.error}</p>}
    {badSegments.length > 0 && <details className="continuity-events"><summary>异常音频分段 <span>{badSegments.length} 段</span></summary><ul>{badSegments.slice(0, 24).map((segment, index) => <li key={`${segment.index}-${index}`}>{segment.index === null ? "序号未知分段" : `第 ${segment.index + 1} 段`}：{segment.error || (!segment.available ? "文件不可用" : `前方空隙 ${segment.gap_before_samples ?? "未验证"} 样本，重叠 ${segment.overlap_before_samples ?? "未验证"} 样本`)}</li>)}</ul>{badSegments.length > 24 && <p className="continuity-hint">更多分段见 JSON 报告。</p>}</details>}
  </article>;
}

function StreamResult({ stream, threshold, onSeek }: { stream: ContinuityStream; threshold: number; onSeek?: (seconds: number) => void }) {
  const [visible, setVisible] = useState(12);
  const quality = stream.recorded_quality_status === "available" ? stream.recorded_quality : null;
  const isMjpeg = stream.kind === "camera" && stream.encoding?.toLowerCase() === "mjpeg";
  const hasSourceIssue = !!quality && (nonzero(quality.source_missing_frames ?? "") || (quality.source_duplicates ?? 0) > 0 ||
    (quality.source_reversals ?? 0) > 0 || quality.invalid_jpeg_frames > 0);
  const hasOrderIssue = nonzero(stream.sequence_missing_records ?? "") || stream.backward_timestamps > 0 || (stream.backward_host_timestamps ?? 0) > 0 || stream.duplicate_timestamps > 0 || stream.duplicate_sequences > 0 || stream.backward_sequences > 0;
  const hasIssue = stream.gaps_over_threshold > 0 || hasOrderIssue || hasSourceIssue;
  const meanInterval = typeof stream.mean_hz === "number" && Number.isFinite(stream.mean_hz) && stream.mean_hz > 0 ? 1000 / stream.mean_hz : null;
  const gapPercent = stream.interval_count > 0 && Number.isFinite(stream.interval_count) && stream.gaps_over_threshold >= 0 && stream.gaps_over_threshold <= stream.interval_count
    ? stream.gaps_over_threshold / stream.interval_count * 100 : null;
  const label = stream.sensor_label || stream.name || stream.id;
  const status = stream.completion === "unavailable" ? "文件不可检查" : stream.completion === "partial" ? stream.scan_complete ? "已检查全文件，清单不一致" : "仅检查可读前缀"
    : hasSourceIssue ? "录制期发现源帧或 JPEG 异常" : stream.interval_count < 1 ? "记录不足，无法统计间隔" : hasOrderIssue ? "发现时间或序号异常" : stream.gaps_over_threshold > 0 ? "存在超阈间隔" : "未发现超阈或顺序异常";
  return <article className="continuity-stream" aria-label={`${label}连续性结果`}>
    <header><div><h3>{label}</h3><p>{stream.time_basis === "host_receive" ? "主机接收时间" : "原始记录时间"} · {stream.kind === "imu" ? "IMU 数据流" : stream.kind === "pressure" ? "压力数据流" : "数据流"}</p></div><span className={`continuity-state ${hasIssue || stream.error ? "has-warning" : ""}`}>{status}</span></header>
    {stream.error && <p className="continuity-error" role="note"><AlertCircle size={15} aria-hidden="true" />{stream.error}。其余数据流可继续查看。</p>}
    <dl className="continuity-metrics">
      <div><dt>已检查可读记录</dt><dd>{number(stream.records, 0)}</dd></div>
      <div><dt>平均记录接收率</dt><dd>{number(stream.mean_hz)} <small>Hz</small>{meanInterval !== null && <span className="continuity-metric-note">换算平均间隔 {number(meanInterval)} ms</span>}</dd></div>
      <div><dt>最长间隔</dt><dd>{number(stream.max_gap_ms)} <small>ms</small></dd></div>
      <div><dt>超过 {number(threshold)} ms 的间隔</dt><dd>{number(stream.gaps_over_threshold, 0)} <small>次</small>{gapPercent !== null && <span className="continuity-metric-note">占已统计间隔 {number(gapPercent)}% · 不是丢帧率</span>}</dd></div>
      <div><dt>P50 / P95 / P99 间隔</dt><dd className="continuity-percentiles">{number(stream.p50_interval_ms)} / {number(stream.p95_interval_ms)} / {number(stream.p99_interval_ms)} <small>ms</small></dd></div>
      <div><dt>应用序号缺失记录</dt><dd>{count(stream.sequence_missing_records)}</dd></div>
    </dl>
    <section className="continuity-source-quality" aria-label="录制期源帧质量">
      <strong>录制期源帧统计</strong>
      <dl className="continuity-metrics">
        <div><dt>设备源序号缺口</dt><dd>{quality?.source_missing_frames == null ? "未提供" : count(quality.source_missing_frames)}</dd></div>
        <div><dt>源序号重复 / 倒序</dt><dd>{quality?.source_duplicates == null || quality.source_reversals == null ? "未提供" : `${number(quality.source_duplicates, 0)} / ${number(quality.source_reversals, 0)}`}</dd></div>
        {isMjpeg && <>
          <div><dt>JPEG 结构异常</dt><dd>{quality ? number(quality.invalid_jpeg_frames, 0) : "未记录"}</dd></div>
          <div><dt>JPEG 结构警告</dt><dd>{quality ? number(quality.jpeg_warning_frames, 0) : "未记录"}</dd></div>
        </>}
      </dl>
      {quality ? <>
        <p className="continuity-hint">来自录制清单，覆盖 {number(quality.observed_frames, 0)} 条已保存记录；本次未重扫源序号或解码 JPEG。应用序号连续不能代替设备源序号检查。</p>
        {quality.source_sequence_status === "partial" && <p className="continuity-threshold-caution">其中 {number(quality.source_unindexed_frames, 0)} 帧未提供源序号；缺口统计只覆盖相邻有序号的记录段，不能据此判断完整录制是否无丢帧。</p>}
        {quality.source_sequence_status === "unknown" && <p className="continuity-hint">这一路未提供设备源序号，设备侧丢帧情况未知。</p>}
        {quality.scan_record_count_matches === false && <p className="continuity-threshold-caution">录制期统计覆盖的记录数与本次扫描不一致，请结合文件异常检查，勿将此快照当作全文件验证结果。</p>}
        {quality.scan_record_count_matches === null && <p className="continuity-hint">本次扫描未覆盖完整文件，尚无法核对录制期统计的完整范围。</p>}
        {isMjpeg && <p className="continuity-hint">JPEG 结构正常不代表图像已成功解码；异常原始帧仍保留，便于后续检查。</p>}
      </> : <p className="continuity-hint">{stream.recorded_quality_status === "invalid" ? "录制清单中的源帧统计无效。" : "这段录制没有保存可用的源帧统计。"}未提供不等于零丢帧。</p>}
    </section>
    <p className="continuity-interpretation">平均速率不代表每条记录等间隔到达；较短与较长的接收间隔可以交替出现。{stream.time_basis === "host_receive" && "这里统计主机接收时刻，不能直接当作设备采样间隔。"}</p>
    {meanInterval !== null && threshold < meanInterval && <p className="continuity-threshold-caution">当前阈值 {number(threshold)} ms 低于这一路约 {number(meanInterval)} ms 的平均间隔，大量超阈是预期现象。请结合这一路的目标频率与允许延迟设阈值，不能据此判定丢帧。</p>}
    <Timeline buckets={stream.timeline ?? []} threshold={threshold} timeOrigin={stream.time_origin} />
    <details className="continuity-events">
      <summary>异常位置与检查范围 <span>{number(stream.anomalies_total, 0)} 个位置</span></summary>
      <p className="continuity-hint">已检查的完整记录边界 {formatBytes(stream.validated_bytes)} / {formatBytes(stream.source_bytes)} · 首末记录 {time(stream.first_time_s)} – {time(stream.last_time_s)}。未评判信号内容质量。</p>
      <p className="continuity-hint">时间倒退 {number(stream.backward_timestamps, 0)} · 时间重复 {number(stream.duplicate_timestamps, 0)} · 序号倒退 {number(stream.backward_sequences, 0)} · 序号重复 {number(stream.duplicate_sequences, 0)}</p>
      {(stream.backward_host_timestamps ?? 0) > 0 && <p className="continuity-hint">主机时间倒退 {number(stream.backward_host_timestamps, 0)} 次</p>}
      {(stream.anomalies ?? []).length > 0 ? <ol className="continuity-anomaly-list">{stream.anomalies.slice(0, visible).map((item, index) => {
        const seekable = Boolean(onSeek && typeof item.time_s === "number" && Number.isFinite(item.time_s) && item.time_s >= 0);
        return <li key={`${item.type}-${item.sequence}-${index}`}><span><time>{time(item.time_s)}</time><strong>{anomalyText(item)}</strong></span>
          {seekable && <button className="button secondary small" onClick={() => onSeek?.(item.time_s!)} aria-label={`回放至 ${time(item.time_s)} 的${anomalyText(item)}`}><Play size={13} aria-hidden="true" />定位回放</button>}</li>;
      })}</ol> : <p className="continuity-hint">此数据流没有已记录的异常位置。</p>}
      {(stream.anomalies?.length ?? 0) > visible && <button className="button secondary small" onClick={() => setVisible(value => value + 12)}>再显示 12 个位置</button>}
      {Boolean(stream.anomalies_truncated) && <p className="continuity-hint">异常位置数量较多，仅保留部分位置；统计总数仍覆盖已检查记录。</p>}
      {onSeek && stream.max_gap_time_s !== null && stream.max_gap_time_s >= 0 && <button className="button secondary small" onClick={() => onSeek(stream.max_gap_time_s!)}>定位最长间隔 · {time(stream.max_gap_time_s)}</button>}
    </details>
  </article>;
}

export function continuityDownloadName(session: Pick<Session, "name" | "started_at">, threshold: number) {
  let clean = session.name.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "_").trim().replace(/[. ]+$/g, "");
  if (!clean) clean = "录制";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `录制_${clean}`;
  let name = "";
  for (const char of clean) { if (name.length + char.length > 80) break; name += char; }
  const date = new Date(session.started_at), stamp = Number.isNaN(date.getTime()) ? "开始时间未知" : new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date).replace(/[ :]/g, "-");
  return `${name}_${stamp}_时间连续性_${threshold}ms.json`;
}

function saveReport(report: ContinuityData, session: Session) {
  const blob = new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = continuityDownloadName(session, report.threshold_ms);
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ContinuityReport({ session, onClose, onSeek }: { session: Session; onClose: () => void; onSeek?: (seconds: number) => void }) {
  const titleId = useId(), thresholdId = useId(), hintId = useId(), dialog = useRef<HTMLDialogElement>(null);
  const [job, setJob] = useState<ContinuityJob | null>(null), [threshold, setThreshold] = useState("100");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pollError, setPollError] = useState(""), [retry, setRetry] = useState(0);
  const mounted = useRef(false), sessionId = useRef(session.id), actionLock = useRef(false);
  const actionVersion = useRef(0);
  sessionId.current = session.id;
  const running = job?.status === "running", report = job?.report ?? null;
  const thresholdMs = Number(threshold), validThreshold = threshold.trim() !== "" && Number.isFinite(thresholdMs) && thresholdMs >= .001 && thresholdMs <= 60000;
  const stopped = session.finalized === true;
  useEffect(() => {
    actionVersion.current++; actionLock.current = false; setBusy(false); setThreshold("100");
  }, [session.id]);
  useEffect(() => {
    mounted.current = true; const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setJob(null); setError(""); setPollError("");
    getContinuityJob(session.id, abort.signal).then(value => { if (!abort.signal.aborted) { setJob(value); if (value) setThreshold(String(value.threshold_ms)); } })
      .catch(cause => { if (!abort.signal.aborted) setError(`读取已有报告失败：${message(cause)}`); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [session.id, retry]);
  useEffect(() => {
    if (!running || busy) return;
    const abort = new AbortController(), version = actionVersion.current; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getContinuityJob(session.id, abort.signal);
        if (abort.signal.aborted || version !== actionVersion.current) return;
        if (!next) throw new Error("检查任务已不存在，请重新读取状态。");
        setJob(next); setPollError(""); if (next.status === "running") timer = setTimeout(poll, 1000);
      } catch (cause) { if (!abort.signal.aborted && version === actionVersion.current) setPollError(`进度暂时无法更新：${message(cause)}。检查可能仍在继续。`); }
    };
    timer = setTimeout(poll, 700);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [job?.id, running, session.id, retry, busy]);
  async function action(cancel: boolean) {
    if (actionLock.current || (!cancel && (!validThreshold || !stopped))) return;
    actionLock.current = true; const version = ++actionVersion.current; setBusy(true); setError(""); const id = session.id;
    try {
      const next = cancel ? await cancelContinuityJob(id) : await startContinuityJob(id, thresholdMs);
      if (mounted.current && sessionId.current === id) { setJob(next); setPollError(""); }
    } catch (cause) { if (mounted.current && sessionId.current === id) setError(`${cancel ? "取消检查" : "启动检查"}未确认：${message(cause)}。请先刷新任务状态。`); }
    finally { if (version === actionVersion.current) actionLock.current = false; if (mounted.current && sessionId.current === id && version === actionVersion.current) setBusy(false); }
  }
  const progress = Math.max(0, Math.min(1, job?.progress ?? 0));
  const gapCount = report?.streams.reduce((sum, stream) => sum + stream.gaps_over_threshold, 0) ?? 0;
  const dropped = report?.dropped_records ?? report?.application_dropped_records ?? report?.dropped_batches ?? report?.application_dropped_batches;
  return <dialog ref={dialog} className="modal continuity-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="continuity-header"><div><h2 id={titleId}><Activity size={19} aria-hidden="true" />时间连续性报告</h2><p>{session.name} · {formatDuration(session.duration_s)}</p></div><button className="icon-button" aria-label="关闭连续性报告" onClick={onClose}><X size={19} /></button></div>
    <div className="continuity-body">
      <section className="continuity-setup" aria-label="检查设置"><div><label htmlFor={thresholdId}>帧间隔预警阈值</label><div className="continuity-threshold-input"><input id={thresholdId} type="number" min="0.001" max="60000" step="any" value={threshold} disabled={running || busy || loading} onChange={event => setThreshold(event.target.value)} aria-describedby={hintId} aria-invalid={!validThreshold} /><span>ms</span></div></div>
        <p id={hintId}>默认 100 ms 是可调整的预警阈值，不是行业标准。点击检查后才读取这段录制；长录制需要更多时间，可以取消。</p>
      </section>
      {!validThreshold && <p className="continuity-error" role="alert">请输入 0.001 – 60,000 ms 范围内的阈值。</p>}
      {!stopped && <p className="continuity-error">请先停止并保存录制，再检查文件。</p>}
      {loading && <p className="continuity-loading" role="status">正在读取已有检查状态…</p>}
      {(error || pollError) && <div className="continuity-error" role="alert"><p>{error || pollError}</p><button className="button secondary small" disabled={busy} onClick={() => { setPollError(""); setRetry(value => value + 1); }}><RefreshCw size={14} aria-hidden="true" />刷新任务状态</button></div>}
      {running && <section className="continuity-progress" aria-label="检查进度"><div><strong>正在逐条检查</strong><span>{Math.round(progress * 100)}%</span></div><progress max="1" value={progress} aria-label="连续性检查进度" /><p>{formatBytes(job.scanned_bytes)} / {formatBytes(job.total_bytes)}{job.current_stream_id ? ` · ${session.streams?.find(item => item.id === job.current_stream_id)?.name ?? job.current_stream_id}` : ""}</p><p>关闭窗口后检查继续；再次打开可查看进度。</p></section>}
      {job?.status === "cancelled" && <p className="continuity-hint" role="status">检查已取消，未扫描的部分不作结论。原始录制保持不变。</p>}
      {job?.status === "error" && <p className="continuity-error" role="alert">检查未完成：{job.error ?? "请重试"}</p>}
      {report && <section aria-label="连续性检查结果">
        <div className="continuity-summary"><div><span>已读到记录的数据流</span><strong>{report.streams.filter(stream => stream.records > 0).length} / {report.streams.length}</strong></div><div><span>超阈间隔（按数据流计）</span><strong>{report.streams.some(stream => stream.interval_count > 0) ? number(gapCount, 0) : "未检测"}</strong></div><div><span>录制时软件丢弃</span><strong>{typeof dropped === "number" && Number.isFinite(dropped) ? <>{number(dropped, 0)} <small>数据块</small></> : "未记录"}</strong></div><div><span>报告使用阈值</span><strong>{number(report.threshold_ms)} <small>ms</small></strong></div></div>
        <p className="continuity-hint">生成于 {formatDate(report.checked_at)}。手套压力与 IMU 分开存储，但共用一次 SDK 回调的接收时间，不代表两套独立采样时钟。百分位与平均值统计记录间隔，不代表逐样本硬件采样率。</p>
        {report.source_status === "incomplete" && <p className="continuity-notice">原录制标记为“数据不完整”。本报告保留这个状态；可用数据流和有效前缀单独展示。</p>}
        {report.source_error && <p className="continuity-notice">录制时错误：{report.source_error}</p>}
        <div className="continuity-streams">{report.streams.map(stream => <StreamResult key={`${job?.id}-${stream.id}`} stream={stream} threshold={report.threshold_ms} onSeek={stream.seekable === false || stream.time_origin === "first_record" ? undefined : onSeek} />)}</div>
        {!report.streams.length && <p className="continuity-notice">这段录制没有可统计记录间隔的传感器数据流。</p>}
        {report.media_streams.length > 0 && <div className="continuity-media-list" aria-label="媒体检查结果">{report.media_streams.map(media => <MediaResult key={media.id} media={media} />)}</div>}
        {report.warnings.length > 0 && <details className="continuity-events"><summary>检查说明 <span>{report.warnings.length} 项</span></summary><ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      </section>}
      {!loading && !job && !error && <div className="continuity-empty"><Activity size={28} aria-hidden="true" /><strong>还没有这段录制的连续性报告</strong><p>检查接收间隔、应用记录序号和异常位置。不会重新采集或生成数据导出包。</p></div>}
      <section className="continuity-scope" aria-label="报告范围"><strong>这份报告能说明什么</strong><p>统计传感器记录的时间连续性。SDK 时间戳来自主机接收时刻；没有设备原生序号时，设备侧丢帧率未知。应用序号连续不等于设备零丢帧。</p><p>支持的 SDK 数据流会另外显示录制期保存的源序号与 JPEG 结构统计；浏览器音视频实际采集掉帧和多设备同步未在此检测，共同开始不代表硬件同步。</p>{report && <p className="continuity-hint">百分位计算：{report.quantile_method}</p>}</section>
    </div>
    <footer className="continuity-footer"><button className="button secondary" onClick={onClose}>关闭</button><div>{report && <button className="button secondary" onClick={() => saveReport(report, session)}><Download size={15} aria-hidden="true" />下载报告 JSON</button>}{running ? <button className="button secondary" disabled={busy} onClick={() => void action(true)}><Square size={14} aria-hidden="true" />{busy ? "正在取消…" : "取消检查"}</button>
      : <button className="button primary" disabled={loading || busy || Boolean(error) || !validThreshold || !stopped} onClick={() => void action(false)}><Activity size={15} aria-hidden="true" />{busy ? "正在启动…" : report ? "按当前阈值重新检查" : "开始检查"}</button>}</div></footer>
  </dialog>;
}
