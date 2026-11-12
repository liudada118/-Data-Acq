import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { defaultLabels } from "./workflow";
import type { LabelDefinition, WorkflowDraft } from "./workflow";

const templates: { id: string; name: string; task: string; description: string; labels: LabelDefinition[] }[] = [
  { id: "free", name: "自由采集", task: "自由采集", description: "直接录制，无需动作标记", labels: [] },
  { id: "grasp", name: "抓握动作", task: "抓取并松开物体", description: "接触 · 抓握 · 松开", labels: defaultLabels() },
  { id: "walking", name: "步态行走", task: "行走与转身", description: "行走 · 转身 · 异常", labels: [
    { id: "walking", name: "行走", kind: "interval", color: "#25866b", shortcut: "1" },
    { id: "turn", name: "转身", kind: "point", color: "#b37b39", shortcut: "2" },
    { id: "abnormal", name: "异常", kind: "point", color: "#ad6262", shortcut: "3" },
  ] },
];

export function ExperimentDialog({ value, onSave, onClose, busy = false, error = "", allowTemplates = false }: {
  value: WorkflowDraft;
  onSave: (value: WorkflowDraft) => void | Promise<void>;
  onClose: () => void;
  busy?: boolean;
  error?: string;
  allowTemplates?: boolean;
}) {
  const [draft, setDraft] = useState(() => structuredClone(value));
  const [tags, setTags] = useState(value.experiment.tags.join("，"));
  const [localError, setLocalError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"experiment" | "labels">("experiment");
  const [appliedTemplate, setAppliedTemplate] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const saveLock = useRef(false);
  const locked = busy || saving;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab]);
  const updateLabel = (id: string, patch: Partial<LabelDefinition>) => setDraft(current => ({ ...current, labels: current.labels.map(label => label.id === id ? { ...label, ...patch } : label) }));

  function applyTemplate(id: string) {
    if (!allowTemplates || locked) return;
    const template = templates.find(item => item.id === id);
    if (!template) return;
    // Templates only edit the next-recording draft; saved annotation IDs are never replaced here.
    setDraft(current => ({ ...current, experiment: { ...current.experiment, task: template.task }, labels: structuredClone(template.labels) }));
    setAppliedTemplate(template.name);
    setLocalError("");
  }

  async function save() {
    if (locked || saveLock.current) return;
    const keys = new Set<string>();
    for (const label of draft.labels) {
      if (!label.name.trim()) { setTab("labels"); return setLocalError("请给每个动作或事件起一个名称，例如「接触」或「抓握」。"); }
      if (label.shortcut && !/^[a-z0-9]$/i.test(label.shortcut)) { setTab("labels"); return setLocalError("快捷键使用一个英文字母或数字，也可以留空。"); }
      if (label.shortcut && keys.has(label.shortcut.toLowerCase())) { setTab("labels"); return setLocalError("两个标记不能使用同一个快捷键，请修改后保存。"); }
      if (label.shortcut) keys.add(label.shortcut.toLowerCase());
    }
    setLocalError("");
    saveLock.current = true;
    setSaving(true);
    try {
      await onSave({ experiment: { ...draft.experiment, task: draft.experiment.task.trim() || (allowTemplates ? "自由采集" : ""), tags: [...new Set(tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))].slice(0, 32) }, labels: draft.labels.map(label => ({ ...label, name: label.name.trim(), shortcut: label.shortcut.toLowerCase() })) });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "保存失败，请重试。填写内容已保留。");
    } finally { saveLock.current = false; setSaving(false); }
  }

  return <dialog ref={dialog} className="modal workflow-dialog task-setup-dialog" aria-labelledby="experiment-dialog-title" onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
    <div className="modal-header"><div><h2 id="experiment-dialog-title">{allowTemplates ? "设置采集任务" : "任务信息与动作标记"}</h2><p className="task-dialog-subtitle">{allowTemplates ? "说明采集内容，动作标记可选。" : "编辑这段录制的说明和回放标记。"}</p></div><button className="icon-button" aria-label="关闭实验信息" onClick={onClose} disabled={locked}><X size={18} /></button></div>
    <div className="workflow-dialog-tabs" role="group" aria-label="实验设置内容"><button type="button" aria-pressed={tab === "experiment"} onClick={() => setTab("experiment")}>采集任务</button><button type="button" aria-pressed={tab === "labels"} onClick={() => setTab("labels")}>动作与事件 <span>{draft.labels.length ? `${draft.labels.length} 个` : "可选"}</span></button></div>
    <div className="task-dialog-body" ref={body}>
    {tab === "experiment" ? <div className="task-setup-content">
      {allowTemplates && <section className="task-template-section" aria-label="采集任务模板">
        <p className="task-section-label">快速开始 <span>选择模板后仍可修改</span></p>
        <div className="task-template-grid">{templates.map(template => <button type="button" key={template.id} disabled={locked} aria-label={`使用${template.name}模板`} aria-pressed={appliedTemplate === template.name} onClick={() => applyTemplate(template.id)}><strong>{template.name}{appliedTemplate === template.name && <Check size={14} aria-hidden="true" />}</strong><span>{template.description}</span></button>)}</div>
        <p className={`task-template-note ${appliedTemplate ? "task-template-feedback" : ""}`} role="status" aria-atomic="true">{appliedTemplate ? <>已填入「{appliedTemplate}」的任务与动作标记，保存后生效。</> : "模板会替换任务名称与动作标记，其他信息保留。"}</p>
      </section>}
      <div className="experiment-fields task-essential-fields">
        <label className="task-primary-field"><span>这次要采什么？</span><input aria-label="这次要采什么" autoFocus maxLength={120} placeholder="例如：左手抓取海绵并松开" value={draft.experiment.task} onChange={event => setDraft(current => ({ ...current, experiment: { ...current.experiment, task: event.target.value } }))} disabled={locked} /><small>{allowTemplates ? "留空将保存为「自由采集」。" : "说明本段录制的动作或目的。"}</small></label>
        <label><span>采集对象 <small>选填</small></span><input aria-label="采集对象" maxLength={120} placeholder="例如：P001 / 海绵 A" value={draft.experiment.subject} onChange={event => setDraft(current => ({ ...current, experiment: { ...current.experiment, subject: event.target.value } }))} disabled={locked} /></label>
      </div>
      <button type="button" className="task-marker-summary" onClick={() => setTab("labels")}><div><strong>动作与事件 <small>可选</small></strong><span>{draft.labels.length ? `${draft.labels.length} 个标记：${draft.labels.slice(0, 4).map(label => label.name || "未命名").join("、")}${draft.labels.length > 4 ? "…" : ""}` : "未设置标记，可直接录制。"}</span></div><ChevronRight size={17} /></button>
      <details className="task-extra-fields"><summary>更多信息 <span>项目、场景、轮次与备注 · 选填</span></summary><div className="experiment-fields">
        {([['project', '所属项目', '例如：触觉抓取研究'], ['scene', '采集场景', '例如：室内桌面'], ['trial', '本次轮次', '例如：第 3 轮']] as const).map(([key, title, placeholder]) => <label key={key}><span>{title}</span><input maxLength={120} placeholder={placeholder} value={draft.experiment[key]} onChange={event => setDraft(current => ({ ...current, experiment: { ...current.experiment, [key]: event.target.value } }))} disabled={locked} /></label>)}
        <label><span>录制关键词</span><input aria-label="录制关键词" value={tags} maxLength={2000} placeholder="左手，海绵，室内（逗号分隔）" onChange={event => setTags(event.target.value)} disabled={locked} /><small>描述整段录制，不在时间轴上打点。</small></label>
        <label className="experiment-notes"><span>采集说明 / 备注</span><textarea rows={3} maxLength={2000} value={draft.experiment.notes} onChange={event => setDraft(current => ({ ...current, experiment: { ...current.experiment, notes: event.target.value } }))} disabled={locked} /></label>
      </div></details>
      <p className="workflow-help task-save-note">{allowTemplates ? "保存后返回展示区，点击「开始采集」开始录制。" : "保存后更新本段录制信息，原始数据保持不变。"}</p>
    </div> : <div className="label-dictionary">
      <div className="task-mark-explainer"><strong>标记，就是告诉回放“什么时候发生了什么”。</strong><p>录制时手动点击，标记会保存在时间轴上。</p><div className="task-mark-examples"><div><span className="mark-example-point" /><strong>一个时刻</strong><span>如接触：点击一次。</span></div><div><span className="mark-example-interval" /><strong>一段过程</strong><span>如抓握：点击开始，再点击结束。</span></div></div></div>
      <div className="task-mark-toolbar"><span>动作列表 <strong>{draft.labels.length} / 32</strong></span>{allowTemplates && draft.labels.length > 0 && <button type="button" disabled={locked} onClick={() => { setDraft(current => ({ ...current, labels: [] })); setLocalError(""); }}>本次不使用标记</button>}</div>
      {!draft.labels.length && <div className="task-mark-empty">暂无动作标记，可直接保存或添加动作。</div>}
      {draft.labels.map((label, index) => <div className="label-definition" key={label.id}>
        <input type="color" aria-label={`标签 ${index + 1} 颜色`} value={label.color} disabled={locked} onChange={event => updateLabel(label.id, { color: event.target.value })} />
        <label><span>动作 / 事件名称</span><input aria-label={`标签 ${index + 1} 名称`} maxLength={80} placeholder="例如：接触" value={label.name} disabled={locked} onChange={event => updateLabel(label.id, { name: event.target.value })} /></label>
        <label><span>怎么记录</span><select aria-label={`标签 ${index + 1} 类型`} value={label.kind} disabled={locked} onChange={event => updateLabel(label.id, { kind: event.target.value as "point" | "interval" })}><option value="point">一个时刻 · 点一下</option><option value="interval">一段过程 · 开始 / 结束</option></select></label>
        <label className="label-shortcut"><span>快捷键</span><input aria-label={`标签 ${index + 1} 快捷键`} maxLength={1} placeholder="可选" value={label.shortcut} disabled={locked} onChange={event => updateLabel(label.id, { shortcut: event.target.value })} /></label>
        <button type="button" className="icon-button" aria-label={`删除标签 ${label.name || index + 1}`} disabled={locked} onClick={() => setDraft(current => ({ ...current, labels: current.labels.filter(item => item.id !== label.id) }))}><Trash2 size={15} /></button>
      </div>)}
      <button type="button" className="button secondary small" disabled={locked || draft.labels.length >= 32} onClick={() => setDraft(current => ({ ...current, labels: [...current.labels, { id: `label-${crypto.randomUUID().slice(0, 12)}`, name: "", color: "#25866b", shortcut: "", kind: "point" }] }))}><Plus size={15} />添加动作或事件</button>
      <p className="workflow-help">快捷键选填，录制时生效；输入文字时不会触发。</p>
    </div>}
    </div>
    <div className="workflow-dialog-footer">
      {(localError || error) && <p role="alert" className="workflow-error">{localError || error}</p>}
      <div className="task-dialog-actions"><button type="button" className="button secondary" disabled={locked} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={locked} onClick={() => void save()}>{locked ? "正在保存…" : allowTemplates ? "保存任务，返回展示区" : "保存修改"}</button></div>
    </div>
  </dialog>;
}
