import type { PluginConfigField } from "./plugin-types";

/** Generated drafts are untrusted until backend validation; never cast JSON into renderable fields. */
export function draftConfigFields(source: string | undefined): { fields: PluginConfigField[]; error: string } {
  if (!source) return { fields: [], error: "" };
  let document: unknown;
  try { document = JSON.parse(source); }
  catch { return { fields: [], error: "传感器定义尚不是有效 JSON，可继续让 Agent 修正。" }; }
  if (!document || typeof document !== "object" || Array.isArray(document))
    return { fields: [], error: "传感器定义应为 JSON 对象，请让 Agent 修正。" };
  const raw = (document as Record<string, unknown>).config_fields ?? [];
  if (!Array.isArray(raw) || raw.length > 24)
    return { fields: [], error: "连接参数定义格式有误，请让 Agent 修正 config_fields 后测试。" };
  const fields: PluginConfigField[] = [], seen = new Set<string>();
  let invalid = false;
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { invalid = true; continue; }
    const field = value as Record<string, unknown>;
    if (typeof field.key !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(field.key) ||
      ["constructor", "prototype", "__proto__"].includes(field.key) || seen.has(field.key) ||
      typeof field.label !== "string" || field.label.length === 0 || field.label.length > 120 ||
      typeof field.type !== "string" || !["string", "number", "boolean"].includes(field.type) ||
      (field.required !== undefined && typeof field.required !== "boolean") ||
      (field.default !== undefined && (typeof field.default !== field.type ||
        (typeof field.default === "number" && !Number.isFinite(field.default)) ||
        (typeof field.default === "string" && field.default.length > 2048)))) { invalid = true; continue; }
    seen.add(field.key);
    fields.push({ key: field.key, label: field.label, type: field.type as PluginConfigField["type"], required: field.required === true,
      ...(field.default !== undefined ? { default: field.default as string | number | boolean } : {}) });
  }
  return { fields, error: invalid ? "部分连接参数格式有误，已跳过显示；请让 Agent 修正后测试。" : "" };
}
