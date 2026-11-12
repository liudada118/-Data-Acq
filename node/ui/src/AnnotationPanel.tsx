import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Flag, Pencil, Plus, Settings2, Trash2, Undo2, X } from "lucide-react";
import { editedTimeNs, nsToSeconds, sameScope, secondsToNs, shortcutAllowed, timeLabel } from "./workflow";
import type { Annotation, AnnotationDocument, AnnotationMutation, LabelDefinition } from "./workflow";

type StreamChoice = { id: string; name: string };
export function AnnotationTimeline({ annotations, duration, cursor, onSeek }: { annotations: Annotation[]; duration: number; cursor: number; onSeek?: (time: number) => void }) {
  const total = Math.max(duration, cursor, 1);
  return <div className="annotation-timeline" aria-label="标签时间轴">
    <div className="annotation-timeline-track">
      {annotations.slice(-200).map(annotation => {
        const start = nsToSeconds(annotation.start_ns), end = annotation.end_ns === null ? cursor : nsToSeconds(annotation.end_ns);
        return <button key={annotation.id} className={`timeline-annotation ${annotation.kind}`} style={{ left: `${Math.min(100, start / total * 100)}%`, width: annotation.kind === "point" ? undefined : `${Math.max(.35, Math.min(total - start, end - start) / total * 100)}%`, backgroundColor: annotation.color }} title={`${annotation.label_name} · ${timeLabel(start)}${annotation.kind === "interval" ? ` – ${annotation.end_ns === null ? "进行中" : timeLabel(end)}` : ""}`} aria-label={`${annotation.label_name}，${timeLabel(start)}`} onClick={() => onSeek?.(start)} />;
      })}
      <span className="timeline-cursor" style={{ left: `${Math.min(100, cursor / total * 100)}%` }} />
    </div>
    <div className="timeline-scale"><span>00:00.000</span><span>{timeLabel(total)}</span></div>
  </div>;
}

export function AnnotationPanel({ document, labels: draftLabels = [], live, disabled = false, busy, error, streams, cursor, duration, onMutate, onSettings, onClose, onSeek }: {
  document: AnnotationDocument | null;
  labels?: LabelDefinition[];
  live: boolean;
  disabled?: boolean;
  busy: boolean;
  error: string;
  streams: StreamChoice[];
  cursor: number;
  duration: number;
  onMutate: (input: AnnotationMutation) => Promise<boolean>;
  onSettings: () => void;
  onClose?: () => void;
  onSeek?: (time: number) => void;
}) {
  const labels = document?.labels ?? draftLabels;
  const annotations = document?.annotations ?? [];
  const [scope, setScope] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<Partial<Annotation> | null>(null);
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("0");
  const [editorError, setEditorError] = useState("");
  const [undo, setUndo] = useState<Annotation | null>(null);
  const [visibleCount, setVisibleCount] = useState(100);
  const originalTimes = useRef({ start: "0", end: "0" });
  const action = useRef<(label: LabelDefinition) => void>(() => {});
  const canWrite = Boolean(document) && !busy && !disabled;

  function editAnnotation(annotation: Partial<Annotation>) {
    const startText = nsToSeconds(annotation.start_ns).toFixed(3), endText = nsToSeconds(annotation.end_ns).toFixed(3);
    originalTimes.current = { start: startText, end: endText };
    setEditing(annotation); setStart(startText); setEnd(endText); setEditorError("");
  }
  function activate(label: LabelDefinition) {
    if (!canWrite) return;
    if (live) {
      const open = annotations.find(item => item.label_id === label.id && item.kind === "interval" && item.end_ns === null && sameScope(item.stream_ids, scope ? [scope] : []));
      void onMutate(open ? { op: "end", id: open.id } : { op: label.kind === "point" ? "mark" : "begin", label_id: label.id, stream_ids: scope ? [scope] : [], note }).then(ok => { if (ok) setNote(""); });
    } else {
      editAnnotation({ label_id: label.id, kind: label.kind, start_ns: secondsToNs(cursor), end_ns: secondsToNs(label.kind === "point" ? cursor : Math.min(duration, cursor + 1)), stream_ids: scope ? [scope] : [], note });
    }
  }
  action.current = activate;
  useEffect(() => {
    if (!live || !canWrite) return;
    const keydown = (event: KeyboardEvent) => {
      if (!shortcutAllowed(event)) return;
      const label = labels.find(item => item.shortcut && item.shortcut.toLowerCase() === event.key.toLowerCase());
      if (!label) return;
      event.preventDefault(); action.current(label);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [live, canWrite, labels]);
  useEffect(() => { setEditing(null); setUndo(null); setScope(""); setVisibleCount(100); }, [document?.session_id]);
  async function saveEdit() {
    if (!editing?.label_id) return setEditorError("请选择标签。");
    const label = labels.find(item => item.id === editing.label_id);
    const a = Number(start), b = label?.kind === "point" ? a : Number(end);
    if (!start.trim() || (label?.kind === "interval" && !end.trim()) || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a || b > duration + 0.0005) return setEditorError(`时间应在 0～${duration.toFixed(3)} 秒内，结束不能早于开始。`);
    const startNs = editedTimeNs(editing.start_ns, originalTimes.current.start, start);
    const endNs = label?.kind === "point" ? startNs : editedTimeNs(editing.end_ns, originalTimes.current.end, end);
    const ok = await onMutate({ op: "upsert", ...(editing.id ? { id: editing.id } : {}), label_id: editing.label_id, start_ns: startNs, end_ns: endNs, stream_ids: editing.stream_ids ?? [], note: editing.note ?? "" });
    if (ok) { setEditing(null); setEditorError(""); }
  }
  async function remove(annotation: Annotation) {
    if (await onMutate({ op: "delete", id: annotation.id })) setUndo(annotation);
  }
  async function restore() {
    if (!undo) return;
    if (await onMutate({ op: "upsert", label_id: undo.label_id, start_ns: undo.start_ns, end_ns: undo.end_ns, stream_ids: undo.stream_ids, note: undo.note })) setUndo(null);
  }
  return <aside className="annotation-panel" aria-label={live ? "实时标签" : "标签与标注"}>
    <div className="annotation-panel-heading"><div><Flag size={17} /><h2>{live ? "记录动作与事件" : "动作与事件标记"}</h2><span>{annotations.length}</span></div><div><button className="icon-button" title={live ? "正在录制，请停止后再修改下一段任务与动作标记" : "设置任务与动作标记"} aria-label="配置实验信息与标签" onClick={() => { if (!live && !busy) onSettings(); }} disabled={live || busy}><Settings2 size={16} /></button>{onClose && <button className="icon-button" aria-label="收起标签栏" onClick={onClose}><X size={16} /></button>}</div></div>
    <p className="annotation-hint">{live ? "看到动作发生时按下面的按钮，时间会记在这次录制里。过程类动作按一次开始、再按一次结束。修改下一段任务或标记种类，请先停止录制。" : document ? disabled ? "标记已随录制保存，进入回放可查看和修改发生时间。" : "先把时间轴移到动作发生处，再添加或修改标记。" : "可选功能：例如记下接触的时刻、圈出抓握的过程。不使用标记也能正常录制。"}</p>
    <div className="annotation-labels">{labels.map(label => {
      const open = annotations.find(item => item.label_id === label.id && item.kind === "interval" && item.end_ns === null && sameScope(item.stream_ids, scope ? [scope] : []));
      return <button key={label.id} className={`annotation-label-button ${open ? "is-open" : ""}`} disabled={!canWrite} onClick={() => activate(label)} aria-label={`${open ? "结束" : live ? label.kind === "point" ? "标记" : "开始" : "添加"}${label.name}`}>
        <i style={{ backgroundColor: label.color }} /><span>{open ? `结束${label.name}` : live && label.kind === "interval" ? `开始${label.name}` : label.name}<small>{open ? "正在记录过程 · 再按结束" : label.kind === "point" ? live ? "点一下，记下这一刻" : "记下发生时刻" : live ? "按下开始记录过程" : "标出开始和结束时间"}</small></span>{label.shortcut && <kbd>{label.shortcut.toUpperCase()}</kbd>}{open ? <Check size={14} /> : <Plus size={14} />}
      </button>;
    })}{!labels.length && <p className="workflow-help">当前未设置动作标记，数据仍会正常保存。{live ? "录制后可在回放中添加。" : "需要时点击上方设置，添加要记录的动作。"}</p>}</div>
    {!live && !document && <p className="annotation-start-note">开始采集后，这些按钮才会记录时间。</p>}
    {labels.length > 0 && <div className="annotation-defaults"><label><span>标记哪些传感器</span><select aria-label="新标签作用范围" value={scope} disabled={busy} onChange={event => setScope(event.target.value)}><option value="">全部传感器</option>{streams.map(stream => <option key={stream.id} value={stream.id}>{stream.name}</option>)}</select></label><label><span>这次标记的备注</span><input aria-label="打点备注" value={note} maxLength={1000} disabled={busy} placeholder="选填，如物体滑落" onChange={event => setNote(event.target.value)} /></label></div>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {editing && !live && <form className="annotation-editor" onSubmit={event => { event.preventDefault(); void saveEdit(); }}>
      <div className="annotation-editor-title"><strong>{editing.id ? "编辑标注" : "新增标注"}</strong><button type="button" className="icon-button" aria-label="取消编辑标注" onClick={() => setEditing(null)}><X size={14} /></button></div>
      <label><span>标签</span><select aria-label="编辑标注标签" value={editing.label_id} onChange={event => setEditing(current => ({ ...current, label_id: event.target.value }))}>{labels.map(label => <option key={label.id} value={label.id}>{label.name} · {label.kind === "point" ? "点" : "区间"}</option>)}</select></label>
      <div className="annotation-time-fields"><label><span>开始 / 秒</span><input aria-label="标注开始时间" type="number" min={0} max={duration} step="0.001" value={start} onChange={event => setStart(event.target.value)} /><button type="button" onClick={() => setStart(cursor.toFixed(3))}>当前游标</button></label>{labels.find(label => label.id === editing.label_id)?.kind === "interval" && <label><span>结束 / 秒</span><input aria-label="标注结束时间" type="number" min={0} max={duration} step="0.001" value={end} onChange={event => setEnd(event.target.value)} /><button type="button" onClick={() => setEnd(cursor.toFixed(3))}>当前游标</button></label>}</div>
      <label><span>作用传感器（不选为全部）</span><select aria-label="编辑标注作用传感器" multiple size={Math.min(3, Math.max(2, streams.length))} value={editing.stream_ids ?? []} onChange={event => setEditing(current => ({ ...current, stream_ids: Array.from(event.target.selectedOptions, option => option.value) }))}>{streams.map(stream => <option key={stream.id} value={stream.id}>{stream.name}</option>)}</select></label>
      <label><span>备注</span><textarea aria-label="标注备注" rows={2} maxLength={1000} value={editing.note ?? ""} onChange={event => setEditing(current => ({ ...current, note: event.target.value }))} /></label>
      {editorError && <p className="workflow-error" role="alert">{editorError}</p>}<button className="button primary small" disabled={busy} type="submit">{busy ? "保存中…" : "保存标注"}</button>
    </form>}
    <div className="annotation-list-heading"><strong>标注记录</strong>{document && <span>修订 {document.revision}</span>}</div>
    {annotations.length === 0 && <div className="annotation-empty"><Flag size={21} /><p>{live ? labels.length ? "动作发生时点一下，记录会出现在这里。" : "本次先保存原始数据，之后也能补充标记。" : "尚无动作标记"}</p></div>}
    <ol className="annotation-list">{[...annotations].sort((a, b) => nsToSeconds(b.start_ns) - nsToSeconds(a.start_ns)).slice(0, visibleCount).map(annotation => <li key={annotation.id}>
      <button className="annotation-jump" disabled={!onSeek} onClick={() => onSeek?.(nsToSeconds(annotation.start_ns))}><i style={{ backgroundColor: annotation.color }} /><span><strong>{annotation.label_name}</strong><small>{timeLabel(nsToSeconds(annotation.start_ns))}{annotation.kind === "interval" && ` – ${annotation.end_ns === null ? "进行中" : timeLabel(nsToSeconds(annotation.end_ns))}`}</small></span>{onSeek && <ChevronRight size={13} />}</button>
      <p>{annotation.stream_ids.length ? annotation.stream_ids.map(id => streams.find(stream => stream.id === id)?.name ?? id).join("、") : "全部传感器"}{annotation.note ? ` · ${annotation.note}` : ""}</p>
      {live && annotation.end_ns === null && <button className="button secondary small" disabled={!canWrite} onClick={() => void onMutate({ op: "end", id: annotation.id })}>结束此区间</button>}
      {!live && !disabled && <div className="annotation-row-actions"><button aria-label={`编辑标注${annotation.label_name}`} disabled={busy} onClick={() => editAnnotation(annotation)}><Pencil size={12} />编辑</button><button aria-label={`删除标注${annotation.label_name}`} disabled={busy} onClick={() => void remove(annotation)}><Trash2 size={12} />删除</button></div>}
    </li>)}</ol>
    {annotations.length > visibleCount && <button className="button secondary small" onClick={() => setVisibleCount(count => count + 100)}>显示更早的标注（还有 {annotations.length - visibleCount} 条）</button>}
    {annotations.length > 200 && <p className="workflow-help">时间轴显示最近 200 条，完整记录可在列表中查看和编辑。</p>}
    {undo && !live && <button className="button secondary small annotation-undo" disabled={busy} onClick={() => void restore()}><Undo2 size={14} />恢复刚删除的「{undo.label_name}」</button>}
    {document && document.history.length > 0 && <details className="annotation-history"><summary>修改记录 · {document.history.length}</summary>{document.history.slice(-20).reverse().map((item, index) => <p key={index}><span>r{item.revision}</span> {({ mark: "事件打点", begin: "开始区间", end: "结束区间", upsert: "保存标注", delete: "删除标注", context: "修改实验设置", "auto-end": "自动结束区间" } as Record<string, string>)[item.action ?? ""] ?? item.action} <time>{item.at ? new Date(item.at).toLocaleTimeString("zh-CN") : ""}</time></p>)}</details>}
  </aside>;
}
