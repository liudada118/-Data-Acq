import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { formatBytes } from "./api";
import type { ExportFormat, RecoveryReport } from "./types";

export function RecoveryInspection({ report, loading, error, exportError = "", exporting, formats, onRetry, onExport }: {
  report: RecoveryReport | null;
  loading: boolean;
  error: string;
  exportError?: string;
  exporting: boolean;
  formats: ExportFormat[];
  onRetry: () => void;
  onExport: (format: string) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [format, setFormat] = useState("json");
  const quick = report?.inspection_mode === "metadata" || report?.fully_scanned === false;
  useEffect(() => { setConfirmed(false); }, [report]);
  return <section className="recovery-check-panel" aria-label="不完整录制检查">
    <p className="recovery-warning">只读检查文件与元信息，不扫描整段录制。不会修复原始数据，也不会把它标为完整；导出时另行逐条校验可用部分。</p>
    {loading && <p className="recovery-summary" role="status"><Loader2 size={16} className="spin" />正在快速检查各路文件与元信息…</p>}
    {error && <div className="recovery-warning" role="alert"><p>未能完成检查：{error}</p><p>原文件已保留。检查超时不代表文件损坏；可重试，或在导出中心提交不完整数据包，由后台校验可用部分。</p><button className="button secondary small" disabled={loading || exporting} onClick={onRetry}><RefreshCw size={14} />重新检查</button></div>}
    {report && !loading && !error && <>
      <div className="recovery-summary"><strong>{report.has_data ? quick ? "已完成文件与元信息检查 · 尚未逐条验证" : "已验证现存文件结构与计数" : "没有可导出的样本或媒体块"}</strong><span>采集服务丢弃：{report.dropped_records === null ? "未记录" : `${report.dropped_records} 个数据块`}</span></div>
      <div className="recovery-streams table-scroll"><table className="data-table"><thead><tr><th>数据流</th><th>已保存数据</th><th>已知时间范围</th><th>缺损 / 限制</th></tr></thead><tbody>
        {report.streams.map(stream => <tr key={stream.id}><td>{stream.name}<br />{stream.available === false ? "文件不可用" : quick ? "可尝试读取" : "已检查"}</td><td>{stream.records} 块 / {stream.samples} 样本<br />{formatBytes(stream.payload_bytes)}{stream.counts_verified === false && <p>清单计数 · 未逐条核验</p>}</td><td>{stream.start_s === null || stream.end_s === null ? quick ? "待逐条读取后确认" : "无会话起点映射" : `${stream.start_s.toFixed(3)} – ${stream.end_s.toFixed(3)} s`}<br />{stream.observed_span_s === null ? "观察跨度未检查" : `观察跨度 ${stream.observed_span_s.toFixed(3)} s`}</td><td>{stream.record_sequence_gaps === null ? "记录序号缺口未检查" : stream.samples ? `记录序号缺口 ${stream.record_sequence_gaps}` : "无已保存样本"}{stream.error && <p>{stream.error}</p>}</td></tr>)}
        {report.media_streams.map(media => <tr key={media.id}><td>{media.name}<br />{media.available === false ? "文件不可用" : `${media.segments?.length ?? 1} 个文件`}</td><td>{media.chunks} 个媒体块<br />{formatBytes(media.bytes)}</td><td>{media.duration_s === null ? "时长未知" : `${media.duration_s.toFixed(3)} s`}</td><td>{media.attachment_only ? "未完整收尾，保留可用附件；不保证播放" : "文件字节数已核验，未验证播放"}{media.error && <p>{media.error}</p>}{media.segments?.some(segment => segment.error || segment.available === false) && <details><summary>分段异常</summary>{media.segments.filter(segment => segment.error || segment.available === false).map(segment => <p key={segment.index}>第 {segment.index + 1} 段：{segment.error ?? "文件不可用"}</p>)}</details>}</td></tr>)}
      </tbody></table></div>
      <p className="workflow-help">观察跨度是首末记录时间之差，不代表该区间连续有效；记录序号缺口不等于硬件丢帧数。</p>
      <ul className="recovery-warning">{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      {exportError && <p className="recovery-warning" role="alert">导出任务提交未确认：{exportError}。检查结果仍保留；重试前请先在导出中心查看是否已有任务。</p>}
      <div className="recovery-actions"><label className="field-label recovery-format">导出格式<select aria-label="异常录制导出格式" value={format} disabled={exporting || !report.has_data} onChange={event => setFormat(event.target.value)}>{formats.filter(item => item.available).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="recovery-confirmation"><input type="checkbox" checked={confirmed} disabled={exporting || !report.has_data} onChange={event => setConfirmed(event.target.checked)} />我了解数据不完整，导出时校验可用部分并保留缺损报告。</label>
        <button className="button primary" disabled={!report.has_data || !confirmed || exporting || !formats.some(item => item.id === format && item.available)} onClick={() => onExport(format)}>{exporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />}{exporting ? "正在提交…" : "创建不完整数据包"}</button>
      </div>
    </>}
  </section>;
}
