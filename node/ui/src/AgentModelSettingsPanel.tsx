import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import defaults from "../../src/integration/model-catalog-defaults.json";
import type { AgentModelCatalog, AgentModelSettings, DesktopIntegration } from "./desktop";

const normalizedUrl = (value: string) => value.trim().replace(/\/+$/, "");
const builtin = { ...defaults, schemaVersion: 1 as const, source: "default" as const, updatedAt: null };
const matchProvider = (url: string, catalog: AgentModelCatalog) => catalog.providers.find(provider => provider.id !== "custom" && normalizedUrl(provider.baseUrl) === normalizedUrl(url))?.id ?? "custom";

/** Catalog refresh changes available choices only; credentials and edited settings stay local. */
export function AgentModelSettingsPanel({ settings, api, disabled, onSaved, onClose, onSavingChange }: {
  settings: AgentModelSettings; api: DesktopIntegration["modelSettings"]; disabled: boolean;
  onSaved: (settings: AgentModelSettings) => void; onClose: () => void; onSavingChange?: (saving: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<AgentModelCatalog>(builtin);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true), requestId = useRef(0);
  const previousModels = useRef<Record<string, string>>({});
  const previousCustomUrl = useRef(matchProvider(settings.baseUrl, builtin) === "custom" ? settings.baseUrl : "");
  const inferred = matchProvider(baseUrl, catalog);
  const providerId = providerChoice === "custom" ? "custom" : providerChoice
    ? catalog.providers.some(provider => provider.id === providerChoice && normalizedUrl(provider.baseUrl) === normalizedUrl(baseUrl)) ? providerChoice : "custom"
    : inferred;
  const provider = catalog.providers.find(item => item.id === providerId) ?? catalog.providers.find(item => item.id === "custom")!;
  const modelChoice = manualModel || !provider.models.some(item => item.id === model) ? "__manual__" : model;
  const endpointChanged = normalizedUrl(baseUrl) !== normalizedUrl(settings.baseUrl);
  const hasCurrentKey = settings.hasKey && !endpointChanged && !clearKey;
  const locked = disabled || saving;

  const loadCatalog = useCallback(async (refresh = false) => {
    if (!api.catalog) { setWarning("当前桌面版本不支持模型目录，请重新启动更新后的桌面软件；仍可手动配置。"); return; }
    const request = ++requestId.current;
    setLoading(true); setWarning("");
    try {
      const next = await api.catalog({ refresh });
      if (!alive.current || request !== requestId.current) return;
      if (!next || next.schemaVersion !== 1 || !Array.isArray(next.providers) || !next.providers.some(item => item?.id === "custom") ||
        next.providers.some(item => !item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.baseUrl !== "string" ||
          typeof item.defaultModel !== "string" || !Array.isArray(item.models) || item.models.some(option => !option || typeof option.id !== "string" || typeof option.label !== "string")))
        throw new Error("模型目录格式无效。");
      setCatalog(next); setWarning(next.warning ?? "");
    } catch {
      if (alive.current && request === requestId.current) setWarning("暂时无法更新模型列表，已保留可用选项；当前连接未改变。");
    } finally { if (alive.current && request === requestId.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    alive.current = true; void loadCatalog();
    return () => { alive.current = false; requestId.current++; };
  }, [loadCatalog]);

  function chooseProvider(id: string) {
    const next = catalog.providers.find(item => item.id === id); if (!next) return;
    previousModels.current[`${providerId}:${normalizedUrl(baseUrl)}`] = model;
    if (providerId === "custom") previousCustomUrl.current = baseUrl;
    const url = id === "custom" ? previousCustomUrl.current : next.baseUrl;
    setProviderChoice(id); setBaseUrl(url);
    setModel(previousModels.current[`${id}:${normalizedUrl(url)}`] ?? next.defaultModel);
    setManualModel(false); setApiKey(""); setClearKey(false); setError("");
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (locked) return;
    if (!baseUrl.trim() || !model.trim()) { setError("请填写服务地址和模型名称。"); return; }
    setSaving(true); setError(""); onSavingChange?.(true);
    try {
      const result = await api.save({ baseUrl: baseUrl.trim(), model: model.trim(),
        ...(apiKey.trim() && !clearKey ? { apiKey: apiKey.trim() } : {}),
        ...(clearKey || (endpointChanged && !apiKey.trim()) ? { clearApiKey: true } : {}) });
      if (alive.current) { setApiKey(""); onSaved(result); onClose(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "保存模型连接失败，请重试。"); }
    finally { if (alive.current) setSaving(false); onSavingChange?.(false); }
  }

  return <section className="sdk-model-panel" aria-label="模型连接设置">
    <header><div><h2>模型连接</h2><p>使用 Shroom 模型目录选择服务商和模型，支持 Responses API。</p></div><button type="button" className="button secondary small" disabled={saving} onClick={onClose}>返回对话</button></header>
    <div className="sdk-model-catalog-heading"><span>可用模型</span><button type="button" className="button secondary small" disabled={loading || locked || !api.catalog} onClick={() => void loadCatalog(true)}><RefreshCw size={14} className={loading ? "spin" : ""} />{loading ? "正在刷新" : "刷新模型列表"}</button></div>
    <p className="sdk-model-catalog-status" role="status">{loading ? "正在读取模型列表…" : catalog.source === "remote" ? "已从 Shroom 接口更新模型列表。" : catalog.source === "cache" ? "使用最近缓存的模型列表。" : "使用随软件提供的模型列表。"}{warning && ` ${warning}`}</p>
    <form className="sdk-model-settings" onSubmit={event => void save(event)}>
      <label>服务商<select aria-label="服务商" disabled={locked} value={providerId} onChange={event => chooseProvider(event.target.value)}>{catalog.providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Responses API 地址<input aria-label="Responses API 地址" required type="url" placeholder="https://api.example.com/v1" disabled={locked} readOnly={providerId !== "custom"} value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setProviderChoice("custom"); setApiKey(""); setClearKey(false); }} /></label>
      <label>模型<select aria-label="模型" disabled={locked} value={modelChoice} onChange={event => { setManualModel(event.target.value === "__manual__"); if (event.target.value !== "__manual__") setModel(event.target.value); }}>
        {provider.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="__manual__">其他模型（手动填写）</option></select></label>
      {modelChoice === "__manual__" && <label>自定义模型名称<input aria-label="自定义模型名称" required disabled={locked} value={model} onChange={event => setModel(event.target.value)} placeholder="填写服务提供方的模型 ID" /></label>}
      <label>API Key<input aria-label="API Key" type="password" autoComplete="off" disabled={locked || clearKey} placeholder={hasCurrentKey ? "已安全保存，留空保留" : "在本机加密保存"} value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
      {settings.hasKey && <label className="sdk-model-clear-key"><input aria-label="清除已保存密钥" type="checkbox" checked={clearKey} disabled={locked} onChange={event => { setClearKey(event.target.checked); if (event.target.checked) setApiKey(""); }} />清除已保存密钥</label>}
      <div className="sdk-model-help">{provider.hint && <p>{provider.hint}</p>}<p>模型列表只提供连接选项，实际可用性取决于服务端权限与 Responses 接口支持。</p>{endpointChanged && settings.hasKey && <p>已切换服务地址，原服务密钥不会沿用。需要鉴权的服务请填写新密钥。</p>}{disabled && <p>任务或采集进行中，完成后可以修改模型连接。</p>}</div>
      {error && <p className="sdk-agent-error" role="alert">{error}</p>}
      <button type="submit" className="button primary" disabled={locked}>{saving ? "正在保存" : "保存连接"}</button>
    </form>
  </section>;
}
