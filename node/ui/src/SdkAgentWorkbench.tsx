import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, Check, ChevronRight, Code2, FolderPlus, Loader2, Play, Send, Settings2, Square, Upload } from "lucide-react";
import type { AgentModelSettings } from "./desktop";
import type { PluginConfig } from "./plugin-types";
import { draftConfigFields } from "./sdk-draft-fields";
import { AgentModelSettingsPanel } from "./AgentModelSettingsPanel";
import { AgentMarkdown } from "./AgentMarkdown";
import { agentErrorMessage as messageOf } from "./agent-errors";

interface WorkspaceSummary { id: string; name: string; status: string; updated_at: string }
interface AgentWorkspace extends WorkspaceSummary {
  files: { path: string; size: number; text: boolean; readable?: boolean; format?: string }[];
  messages: { id: string; role: "user" | "assistant"; content: string; created_at: string }[];
  task?: { id: string; status: string; events: { time: string; message: string }[]; error?: string };
  draft: { files: { path: string; size: number }[]; revision: string };
  generation?: { source: "agent" | "manual"; model?: string; revision?: string; updated_at: string };
  test?: { passed: boolean; revision: string; checks: { name: string; passed: boolean; message: string }[]; hardware_verified: false; tested_at: string };
  installed?: { plugin_id: string; name: string; version: string; revision?: string; installed_at: string; hardware_verified: false };
  error?: string;
}
const statusNames: Record<string, string> = { imported: "已导入", adapting: "适配中", draft: "待测试", testing: "测试中", tested: "测试完成", installed: "已安装", error: "需要处理" };

export function SdkAgentWorkbench({ recording, onInstalled, onCapture }: {
  recording: boolean; onInstalled: () => Promise<void>; onCapture: () => void;
}) {
  const bridge = window.synapseDesktop?.integration;
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [current, setCurrent] = useState<AgentWorkspace | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AgentModelSettings>({ baseUrl: "", model: "", hasKey: false });
  const [draftTab, setDraftTab] = useState("plugin.json");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testConfig, setTestConfig] = useState<PluginConfig>({});
  const selectedId = useRef<string | null>(null);
  const draftRevision = useRef("");
  const messagesViewport = useRef<HTMLDivElement>(null);
  const messagesContent = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const composing = useRef(false);
  const submittingChat = useRef(false);
  const scrollToLatest = useCallback(() => {
    const viewport = messagesViewport.current;
    if (viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight;
  }, []);
  const running = current?.task?.status === "running" || current?.status === "testing";
  const locked = !!busy || !!running;
  const refreshList = useCallback(async () => {
    if (!bridge) return;
    const result = await bridge.invoke("list") as { workspaces: WorkspaceSummary[] };
    setWorkspaces(result.workspaces);
  }, [bridge]);
  const showWorkspace = useCallback(async (id: string) => {
    if (!bridge) return;
    selectedId.current = id; followLatest.current = true; setDrafts({}); draftRevision.current = ""; setTestConfig({}); setError("");
    const result = await bridge.invoke("status", { workspace_id: id }) as AgentWorkspace;
    if (selectedId.current === id) setCurrent(result);
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    void Promise.all([bridge.invoke("list"), bridge.modelSettings.get()]).then(([result, model]) => {
      if (!mounted) return;
      const list = (result as { workspaces: WorkspaceSummary[] }).workspaces;
      setWorkspaces(list); setSettings(model);
      if (list[0]) void showWorkspace(list[0].id).catch(cause => setError(messageOf(cause)));
    }).catch(cause => { if (mounted) setError(messageOf(cause)); });
    return () => { mounted = false; };
  }, [bridge, showWorkspace]);
  useEffect(() => {
    if (!bridge || !current) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const id = current.id;
    const poll = async () => {
      try {
        const next = await bridge.invoke("status", { workspace_id: id }) as AgentWorkspace;
        if (!cancelled && selectedId.current === id) {
          setCurrent(next);
          if (next.task?.status !== "running") void refreshList().catch(() => {});
        }
      } catch (cause) { if (!cancelled) setError(messageOf(cause)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [bridge, current?.id, refreshList]);
  useEffect(() => {
    if (!bridge || !current) return;
    const revision = `${current.id}:${current.draft?.revision ?? ""}`;
    if (draftRevision.current === revision) return;
    draftRevision.current = revision;
    let cancelled = false;
    const paths = (current.draft?.files ?? []).map(file => file.path).filter(name => name === "adapter.mjs" || name === "plugin.json");
    void Promise.all(paths.map(async path => bridge.invoke("readDraft", { workspace_id: current.id, path }) as Promise<{ path: string; content: string }>))
      .then(results => { if (!cancelled) setDrafts(Object.fromEntries(results.map(item => [item.path, item.content]))); })
      .catch(cause => { if (!cancelled) setError(messageOf(cause)); });
    return () => { cancelled = true; };
  }, [bridge, current?.id, current?.draft?.revision]);
  useLayoutEffect(() => { scrollToLatest(); }, [current, scrollToLatest]);
  useEffect(() => {
    if (!bridge || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scrollToLatest);
    if (messagesViewport.current) observer.observe(messagesViewport.current);
    if (messagesContent.current) observer.observe(messagesContent.current);
    return () => observer.disconnect();
  }, [bridge, scrollToLatest]);
  async function action(name: string, args: Record<string, unknown> = {}) {
    if (!bridge || busy) return;
    setBusy(name); setError("");
    try {
      const result = await bridge.invoke(name, { workspace_id: current?.id, ...args }) as AgentWorkspace;
      if (result?.id && result.id === selectedId.current) setCurrent(result);
      if (name === "install") await onInstalled();
      await refreshList();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }
  async function importSdk() {
    if (!bridge) return;
    setBusy("import"); setError("");
    try {
      const workspace = await bridge.chooseSdkDirectory() as AgentWorkspace | null;
      if (workspace) { await refreshList(); await showWorkspace(workspace.id); }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  }
  function submitMessage() {
    const text = message.trim();
    if (!text || locked || recording || !current || submittingChat.current) return;
    submittingChat.current = true;
    followLatest.current = true;
    scrollToLatest();
    setMessage("");
    void action("chat", { message: text }).finally(() => { submittingChat.current = false; });
  }
  const configDefinition = draftConfigFields(drafts["plugin.json"]);
  const readyToTest = !!current?.draft?.files?.some(file => file.path === "adapter.mjs") && !!current.draft.files.some(file => file.path === "plugin.json");
  const installable = current?.test?.passed && current.test.revision === current.draft.revision;
  const currentDraftInstalled = !!current?.installed && (current.installed.revision
    ? current.installed.revision === current.draft.revision
    : current.status === "installed" && installable);

  if (!bridge) return <section className="sdk-agent-unavailable"><Bot size={34} /><h2>在桌面软件中接入 SDK</h2>
    <p>SDK 导入、对话适配和测试安装需要桌面版的本地文件与插件运行能力。请重新启动 Shroom Capture 桌面软件，打开「SDK 接入 Agent」。</p>
    <p>安装后的传感器仍可在浏览器的传感器列表中选择并采集。</p></section>;
  return <section className="sdk-agent" aria-label="SDK 接入 Agent">
    <header className="sdk-agent-toolbar"><div className="sdk-agent-steps"><span>1 导入 SDK</span><ChevronRight size={15} /><span>2 对话适配</span><ChevronRight size={15} /><span>3 测试安装</span><ChevronRight size={15} /><span>4 选择采集</span></div>
      <button className="button secondary" disabled={locked || recording} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={15} />模型连接{!settings.baseUrl || !settings.model ? " · 未配置" : ""}</button></header>
    {settingsOpen && <AgentModelSettingsPanel settings={settings} api={bridge.modelSettings} disabled={locked || recording}
      onSaved={setSettings} onClose={() => setSettingsOpen(false)} onSavingChange={saving => setBusy(saving ? "settings" : "")} />}
    {error && <p className="sdk-agent-error" role="alert">{error}</p>}
    <div className="sdk-agent-layout">
      <aside className="sdk-imports"><button className="button primary" disabled={locked || recording} aria-busy={busy === "import"}
        title="桌面导入上限：总计 8 GiB、单文件 2 GiB、10,000 个文件。" onClick={() => void importSdk()}>
        {busy === "import" ? <><Loader2 size={16} className="spin" />正在校验并导入…</> : <><FolderPlus size={16} />导入 SDK 文件夹</>}</button>
        <p>包含文档、示例、库文件的本地目录。导入时仅复制到本机工作区。</p>
        <p>最多 10,000 个文件，总计 8 GiB，单文件 2 GiB。大目录校验与复制可能需要一些时间。</p>
        <div className="sdk-workspace-list">{workspaces.map(item => <button key={item.id} className={current?.id === item.id ? "selected" : ""}
          disabled={!!busy} onClick={() => void showWorkspace(item.id).catch(cause => setError(messageOf(cause)))}><strong>{item.name}</strong><small>{statusNames[item.status] ?? item.status}</small></button>)}</div>
        {current && <details className="sdk-import-files"><summary>已导入文件 · {current.files.length}</summary><ul>{current.files.map(file => <li key={file.path}><span title={file.path}>{file.path}</span><small>{file.text ? "文本" : file.readable || /\.(docx|pdf)$/i.test(file.path) ? "可读文档" : "本地文件"}</small></li>)}</ul></details>}
      </aside>
      <div className="sdk-conversation"><header><Bot size={20} /><div><h2>{current?.name ?? "添加你的下一个传感器"}</h2><p>{current ? statusNames[current.status] ?? current.status : "从 SDK 文档与调用示例开始"}</p></div></header>
        <div className="sdk-messages" aria-live="polite" ref={messagesViewport} onScroll={event => {
          const viewport = event.currentTarget;
          followLatest.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48;
        }}><div ref={messagesContent}>
          {!current?.messages.length && <div className="sdk-agent-intro"><h3>把接入要求告诉 Agent</h3><p>例如：读取这个摄像头 SDK 的示例和协议，接入两路 RTSP 画面，并随统一开始和停止采集。</p><p>支持文本、DOCX 正文和 PDF 文字层；提取的文字会发送到你配置的模型。软件已内置 RTSP 解码能力。适配代码经过测试安装后才进入传感器列表。</p></div>}
          {current?.messages.map(item => <article className={`sdk-message ${item.role}`} key={item.id}><strong>{item.role === "user" ? "你" : "Agent"}</strong>{item.role === "assistant" ? <AgentMarkdown content={item.content} /> : <div>{item.content}</div>}</article>)}
          {current?.task && <details className="sdk-agent-events" open={running}><summary>{running ? "正在适配…" : current.task.status === "completed" ? "本轮适配完成" : "本轮任务状态"}</summary>
            {current.task.events.slice(-40).map((event, index) => <p key={`${event.time}-${index}`}>{event.message}</p>)}{current.task.error && <p role="alert">{current.task.error}</p>}</details>}
        </div></div>
        <form className="sdk-composer" onSubmit={event => { event.preventDefault(); submitMessage(); }}>
          <textarea aria-label="向 Agent 描述 SDK 接入需求" value={message} onChange={event => setMessage(event.target.value)}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat) submitMessage();
            }}
            disabled={!current || locked || recording} placeholder="描述传感器、需要的数据流和连接方式…" maxLength={12000} rows={3} />
          <div><span>{recording ? "正在采集，请停止后适配 SDK" : "Enter 发送 · Shift+Enter 换行"}</span>{running ? <button type="button" className="button secondary" disabled={!!busy} onClick={() => void action("cancel")}><Square size={14} />停止适配</button> : <button className="button primary" disabled={!current || locked || !message.trim() || recording}><Send size={15} />发送</button>}</div>
        </form>
      </div>
      <aside className="sdk-review"><header><Code2 size={18} /><h2>适配器与验证</h2></header>
        {current?.generation && <p className="sdk-test-note">{current.generation.source === "agent" && current.generation.revision === current.draft.revision ? `内置 Agent 生成 · ${current.generation.model}` : "草稿已在对话工具之外修改"}</p>}
        <div className="sdk-draft-tabs">{["plugin.json", "adapter.mjs"].map(name => <button key={name} aria-pressed={draftTab === name} onClick={() => setDraftTab(name)}>{name === "plugin.json" ? "传感器定义" : "适配代码"}</button>)}</div>
        <pre className="sdk-draft-code" tabIndex={0}>{drafts[draftTab] || "导入 SDK 并开始对话后，生成内容将在这里显示。"}</pre>
        {configDefinition.error && <p className="sdk-agent-error" role="status">{configDefinition.error}</p>}
        {configDefinition.fields.length > 0 && <details className="sdk-test-config"><summary>测试连接参数</summary>{configDefinition.fields.map(field => <label key={field.key}>{field.label}
          {field.type === "boolean" ? <input type="checkbox" checked={(testConfig[field.key] ?? field.default) === true} onChange={event => setTestConfig({ ...testConfig, [field.key]: event.target.checked })} /> :
            <input type={field.type === "number" ? "number" : "text"} value={String(testConfig[field.key] ?? field.default ?? "")} onChange={event => setTestConfig({ ...testConfig, [field.key]: field.type === "number" && event.target.value ? Number(event.target.value) : event.target.value })} />}</label>)}</details>}
        <div className="sdk-test-results">{current?.test?.checks.map((check, index) => <p key={index} className={check.passed ? "passed" : "failed"}><strong>{check.passed ? "通过" : "失败"} · {check.name}</strong><span>{check.message}</span></p>)}</div>
        <p className="sdk-test-note">测试将执行生成代码与 probe，请先查看适配代码。独立进程拥有本机权限。测试通过表示软件接口通过，设备连接与数据质量仍需实机确认。</p>
        <div className="sdk-install-actions"><button className="button secondary" disabled={!readyToTest || locked || recording} onClick={() => void action("test", { config: Object.fromEntries(Object.entries(testConfig).filter(([key]) => configDefinition.fields.some(field => field.key === key))) })}>{busy === "test" ? <Loader2 size={15} className="spin" /> : <Play size={15} />}测试适配器</button>
          <button className="button primary" disabled={!installable || locked || recording} onClick={() => void action("install")}>{busy === "install" ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}安装传感器</button></div>
        {current?.installed && <div className="sdk-installed"><Check size={18} /><p><strong>已安装版本 · {current.installed.name}</strong><span>v{current.installed.version} · {currentDraftInstalled ? "本次草稿已安装" : "本次草稿尚未安装，列表中仍为之前版本"}</span></p><button className="button secondary small" onClick={onCapture}>去选择并采集</button></div>}
      </aside>
    </div>
  </section>;
}
