export interface Experiment {
  project: string;
  task: string;
  subject: string;
  scene: string;
  trial: string;
  notes: string;
  tags: string[];
}
export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
  shortcut: string;
  kind: "point" | "interval";
}
export interface Annotation {
  id: string;
  label_id: string;
  label_name: string;
  color: string;
  kind: "point" | "interval";
  start_ns: string;
  end_ns: string | null;
  stream_ids: string[];
  note: string;
  source: string;
  created_at: string;
  updated_at: string;
}
export interface AnnotationDocument {
  schema_version: number;
  session_id: string;
  revision: number;
  experiment: Experiment;
  labels: LabelDefinition[];
  annotations: Annotation[];
  history: { revision?: number; at?: string; action?: string; op?: string; [key: string]: unknown }[];
}
export interface AnnotationMutation {
  op: "mark" | "begin" | "end" | "upsert" | "delete";
  id?: string;
  label_id?: string;
  start_ns?: string;
  end_ns?: string | null;
  stream_ids?: string[];
  note?: string;
}
export interface WorkflowDraft { experiment: Experiment; labels: LabelDefinition[] }
export const WORKFLOW_KEY = "synapse-node.experiment.v1";
export const emptyExperiment = (): Experiment => ({ project: "", task: "", subject: "", scene: "", trial: "", notes: "", tags: [] });
export const defaultLabels = (): LabelDefinition[] => [
  { id: "contact", name: "接触", kind: "point", color: "#25866b", shortcut: "1" },
  { id: "grasp", name: "抓握", kind: "interval", color: "#b37b39", shortcut: "2" },
  { id: "release", name: "松开", kind: "point", color: "#667fac", shortcut: "3" },
];
export function parseDraft(value: unknown): WorkflowDraft {
  const fallback = { experiment: emptyExperiment(), labels: defaultLabels() };
  if (!value || typeof value !== "object") return fallback;
  const input = value as Partial<WorkflowDraft>;
  const experiment = emptyExperiment();
  for (const key of ["project", "task", "subject", "scene", "trial", "notes"] as const) {
    if (typeof input.experiment?.[key] === "string") experiment[key] = input.experiment[key].slice(0, key === "notes" ? 2000 : 120);
  }
  experiment.tags = Array.isArray(input.experiment?.tags) ? input.experiment.tags.filter((x): x is string => typeof x === "string").slice(0, 32).map(x => x.slice(0, 80)) : [];
  const seen = new Set<string>(), keys = new Set<string>();
  const labels = Array.isArray(input.labels) ? input.labels.filter(label => {
    if (!label || typeof label !== "object" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(label.id) || seen.has(label.id) || typeof label.name !== "string" || !label.name.trim() || !["point", "interval"].includes(label.kind) || !/^#[0-9a-f]{6}$/i.test(label.color)) return false;
    seen.add(label.id); return true;
  }).slice(0, 32).map(label => {
    const shortcut = typeof label.shortcut === "string" && /^[a-z0-9]$/i.test(label.shortcut) && !keys.has(label.shortcut.toLowerCase()) ? label.shortcut.toLowerCase() : "";
    if (shortcut) keys.add(shortcut);
    return { id: label.id, name: label.name.trim().slice(0, 80), color: label.color, kind: label.kind, shortcut };
  }) : fallback.labels;
  return { experiment, labels };
}
export function readDraft(): WorkflowDraft {
  try { return parseDraft(JSON.parse(localStorage.getItem(WORKFLOW_KEY) ?? "null")); }
  catch { return parseDraft(null); }
}
export function saveDraft(draft: WorkflowDraft) {
  try { localStorage.setItem(WORKFLOW_KEY, JSON.stringify(draft)); } catch { /* Draft is usable in memory. */ }
}
export function nsToSeconds(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  return Number(BigInt(value)) / 1e9;
}
export function secondsToNs(value: number | string): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 31_536_000) throw new Error("时间必须是有效的非负秒数。");
  return BigInt(Math.round(number * 1e9)).toString();
}
export function timeLabel(value: number): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(safe / 60);
  return `${minutes.toString().padStart(2, "0")}:${(safe % 60).toFixed(3).padStart(6, "0")}`;
}
export function editedTimeNs(original: string | null | undefined, originalDisplay: string, nextDisplay: string): string {
  return original && originalDisplay === nextDisplay ? original : secondsToNs(nextDisplay);
}
export function sameScope(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id));
}
export function shortcutAllowed(event: Pick<KeyboardEvent, "repeat" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing" | "target">): boolean {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return false;
  const target = event.target as Element | null;
  return !(target as HTMLElement | null)?.isContentEditable && !target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], dialog');
}
