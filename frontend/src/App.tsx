import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  Download,
  FileCheck2,
  FileJson,
  FolderOpen,
  HardDrive,
  Layers3,
  LayoutDashboard,
  Loader2,
  Mic,
  Monitor,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Unplug,
  Video,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  downloadUrl,
  formatBytes,
  formatDate,
  formatDuration,
  getFormats,
  getJobs,
  getSessions,
  request,
} from "./api";
import { LivePreview, getDeviceLabel } from "./LivePreview";
import { startPreviewPolling } from "./preview";
import type {
  Device,
  DeviceKind,
  ExportFormat,
  ExportJob,
  LogEntry,
  Profile,
  Session,
  Status,
} from "./types";

type Page = "acquisition" | "devices" | "sessions" | "exports" | "settings";
const allDeviceIds = ["sim-camera", "sim-pressure", "sim-audio", "sim-imu"];
const defaultProfiles: Profile[] = [
  { id: "all-modalities", name: "全模态研究组合", device_ids: allDeviceIds },
  {
    id: "tactile-motion",
    name: "触觉与动作",
    device_ids: ["sim-pressure", "sim-imu"],
  },
  {
    id: "audio-visual",
    name: "音视频记录",
    device_ids: ["sim-camera", "sim-audio"],
  },
];
const emptyStatus: Status = {
  state: "idle",
  session_id: null,
  elapsed_s: 0,
  bytes_written: 0,
  queue_depth: 0,
  queue_capacity: 0,
  dropped_records: 0,
  record_counts: {},
  selected_ids: [],
};
const pageNames: Record<Page, string> = {
  acquisition: "数据采集",
  devices: "设备与组合",
  sessions: "录制记录",
  exports: "导出中心",
  settings: "设置与帮助",
};
const pageSubtitles: Record<Page, string> = {
  acquisition: "选择传感器组合，让每一种感知在同一会话中汇集。",
  devices: "管理数据源，保存适合不同实验的采集组合。",
  sessions: "每次录制独立保存，原始数据、设备配置和时间信息始终关联。",
  exports: "从原始录制生成适合分析和训练的数据包。",
  settings: "配置工作台，了解采集链路与设备接入方式。",
};
const kindIcons = {
  camera: Video,
  audio: Mic,
  pressure: ScanLine,
  imu: Activity,
};

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
function storeValue(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Usable without persistent browser storage. */
  }
}
function defaultName() {
  return `多模态实验 ${new Date().toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}`;
}
function sampleRate(device: Device) {
  return device.kind === "audio"
    ? `${device.sample_rate / 1000} kHz`
    : `${device.sample_rate} ${device.kind === "camera" ? "fps" : "Hz"}`;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="关闭对话框"
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof FolderOpen;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={27} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("acquisition");
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState<Status>(emptyStatus);
  const [connected, setConnected] = useState(false);
  const [previewConnected, setPreviewConnected] = useState(false);
  const [previewPaused, setPreviewPaused] = useState(false);
  const [previewRate, setPreviewRate] = useState(() => {
    const rate = readStorage<number>("synapse.preview-rate", 5);
    return [2, 5, 10].includes(rate) ? rate : 5;
  });
  const [profiles, setProfiles] = useState<Profile[]>(() => {
    const saved = readStorage<Profile[]>(
      "synapse.profiles.v1",
      defaultProfiles,
    );
    return Array.isArray(saved)
      ? saved.filter(
          (profile) =>
            typeof profile.name === "string" &&
            Array.isArray(profile.device_ids),
        )
      : defaultProfiles;
  });
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const saved = readStorage<string[]>("synapse.selection.v1", allDeviceIds);
    return Array.isArray(saved)
      ? saved.filter((id) => typeof id === "string")
      : allDeviceIds;
  });
  const [profileId, setProfileId] = useState(() =>
    readStorage<string>("synapse.active-profile.v1", "all-modalities"),
  );
  const [sessionName, setSessionName] = useState(defaultName);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [formats, setFormats] = useState<ExportFormat[]>([]);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [exportOnline, setExportOnline] = useState(false);
  const [exportSessionId, setExportSessionId] = useState("");
  const [exportFormatId, setExportFormatId] = useState("npz");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveDialog, setSaveDialog] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [detailSession, setDetailSession] = useState<Session | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const connectionRef = useRef<boolean | null>(null);
  const lastBytesRef = useRef({
    value: 0,
    time: performance.now(),
    session: "",
  });
  const [writeRate, setWriteRate] = useState(0);
  const [logExpanded, setLogExpanded] = useState(false);
  const recording =
    Boolean(status.session_id) ||
    status.state === "recording" ||
    status.state === "stopping";
  const selectedDevices = devices.filter((device) =>
    selectedIds.includes(device.id),
  );
  const completeSessions = sessions.filter(
    (session) => session.status === "complete",
  );
  const activeProfile = profiles.find((profile) => profile.id === profileId);
  const totalRecords = Object.values(status.record_counts ?? {}).reduce(
    (total, count) => total + count,
    0,
  );

  const addLog = useCallback(
    (message: string, level: LogEntry["level"] = "info") => {
      setLogs((previous) =>
        [
          {
            id: Date.now() + Math.random(),
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            message,
            level,
          },
          ...previous,
        ].slice(0, 60),
      );
    },
    [],
  );

  const refreshSessions = useCallback(async () => {
    const next = await getSessions();
    setSessions(next.sort((a, b) => b.started_at.localeCompare(a.started_at)));
  }, []);

  const loadDevices = useCallback(
    async (announce = false) => {
      const data = await request<{ devices: Device[] }>("/api/devices");
      const simulatedNames: Record<string, string> = {
        camera: "模拟 RGB 摄像头",
        audio: "模拟麦克风",
        pressure: "模拟压力阵列",
        imu: "模拟六轴 IMU",
      };
      setDevices(
        (data.devices ?? []).map((device) =>
          device.mode === "simulated"
            ? { ...device, name: simulatedNames[device.kind] ?? device.name }
            : device,
        ),
      );
      if (announce)
        addLog(
          `设备扫描完成，发现 ${data.devices.length} 个模拟数据源。`,
          "success",
        );
    },
    [addLog],
  );

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request<Status>("/api/status");
        if (stopped) return;
        setStatus(next);
        setConnected(true);
        if (connectionRef.current !== true) {
          addLog("本地 C++ 采集引擎已连接，模拟数据源就绪。", "success");
          void loadDevices().catch(() => {});
          void refreshSessions().catch(() => {});
        }
        connectionRef.current = true;
        const now = performance.now();
        const previous = lastBytesRef.current;
        if (
          previous.session === next.session_id &&
          next.bytes_written >= previous.value
        ) {
          setWriteRate(
            next.state === "recording"
              ? (next.bytes_written - previous.value) /
                  Math.max(0.1, (now - previous.time) / 1000)
              : 0,
          );
        } else setWriteRate(0);
        lastBytesRef.current = {
          value: next.bytes_written,
          time: now,
          session: next.session_id ?? "",
        };
      } catch {
        if (stopped) return;
        setConnected(false);
        if (connectionRef.current !== false)
          addLog(
            "采集服务连接中断，正在尝试重新连接。录制状态以引擎为准。",
            "error",
          );
        connectionRef.current = false;
      } finally {
        if (!stopped) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [addLog, loadDevices, refreshSessions]);

  useEffect(() => {
    if (previewPaused) return;
    return startPreviewPolling(1000 / previewRate, setPreviewConnected);
  }, [previewPaused, previewRate]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [nextFormats, nextJobs] = await Promise.all([
          getFormats(),
          getJobs(),
        ]);
        if (!stopped) {
          setFormats(nextFormats);
          setJobs(nextJobs);
          setExportOnline(true);
        }
      } catch {
        if (!stopped) setExportOnline(false);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (page !== "sessions" && page !== "exports") return;
    void refreshSessions().catch(() => {});
    const timer = setInterval(() => {
      void refreshSessions().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [page, refreshSessions]);

  useEffect(() => {
    storeValue("synapse.profiles.v1", profiles);
  }, [profiles]);
  useEffect(() => {
    storeValue("synapse.selection.v1", selectedIds);
  }, [selectedIds]);
  useEffect(() => {
    storeValue("synapse.active-profile.v1", profileId);
  }, [profileId]);
  useEffect(() => {
    storeValue("synapse.preview-rate", previewRate);
  }, [previewRate]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  function navigate(next: Page) {
    setPage(next);
    setError("");
  }
  function chooseProfile(id: string) {
    if (recording) return;
    const profile = profiles.find((item) => item.id === id);
    setProfileId(id);
    if (profile) setSelectedIds(profile.device_ids);
  }
  function toggleDevice(id: string) {
    if (recording) return;
    setSelectedIds((previous) =>
      previous.includes(id)
        ? previous.filter((deviceId) => deviceId !== id)
        : [...previous, id],
    );
    setProfileId("");
  }
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    const name = newProfileName.trim();
    if (!name || selectedIds.length === 0) return;
    const profile = {
      id: `profile-${Date.now()}`,
      name,
      device_ids: [...selectedIds],
    };
    setProfiles((previous) => [...previous, profile]);
    setProfileId(profile.id);
    setSaveDialog(false);
    setNewProfileName("");
    setNotice(`采集组合「${name}」已保存`);
    addLog(`保存采集组合「${name}」，包含 ${selectedIds.length} 个数据源。`);
  }
  async function startRecording() {
    if (!connected || busy || recording || selectedDevices.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const response = await request<{ session_id: string; status: Status }>(
        "/api/sessions/start",
        {
          name: sessionName.trim() || defaultName(),
          device_ids: selectedDevices.map((device) => device.id),
          profile: {
            name: activeProfile?.name ?? "自定义组合",
            device_ids: selectedIds,
          },
        },
      );
      if (response.status) setStatus(response.status);
      addLog(
        `开始录制「${sessionName.trim() || defaultName()}」，${selectedDevices.length} 路模拟数据。`,
        "success",
      );
      setNotice("录制已开始，原始数据由采集引擎直接写盘");
    } catch (cause) {
      setError(errorMessage(cause));
      addLog(`录制启动失败：${errorMessage(cause)}`, "error");
    } finally {
      setBusy(false);
    }
  }
  async function stopRecording() {
    if (!connected || busy || !recording) return;
    setBusy(true);
    setError("");
    try {
      const response = await request<{ session: Session; status: Status }>(
        "/api/sessions/stop",
        {},
      );
      if (response.status) setStatus(response.status);
      await refreshSessions();
      if (response.session?.id) setExportSessionId(response.session.id);
      if (response.session.status === "complete") {
        addLog(
          `录制已保存：${response.session?.name ?? sessionName}。`,
          "success",
        );
        setNotice("录制已保存，可在录制记录中查看或导出");
      } else {
        setError(
          `录制已停止，但数据不完整：${String(response.session.error ?? "存在丢弃或写盘异常，请查看会话详情")}`,
        );
        addLog("录制不完整，请查看会话详情。", "error");
      }
    } catch (cause) {
      setError(errorMessage(cause));
      addLog(`停止录制失败：${errorMessage(cause)}`, "error");
    } finally {
      setBusy(false);
    }
  }
  async function scanDevices() {
    setRefreshing(true);
    setError("");
    try {
      await loadDevices(true);
      setNotice("设备列表已更新");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  }
  function openExport(session: Session) {
    setExportSessionId(session.id);
    navigate("exports");
  }
  async function showDetails(session: Session) {
    try {
      setDetailSession(
        await request<Session>(
          `/api/sessions/${encodeURIComponent(session.id)}`,
        ),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function submitExport(event: FormEvent) {
    event.preventDefault();
    const sessionId = exportSessionId || completeSessions[0]?.id;
    if (!sessionId || !exportOnline || exportBusy) return;
    setExportBusy(true);
    setError("");
    try {
      await request("/api/export/jobs", {
        session_id: sessionId,
        format: exportFormatId,
      });
      setJobs(await getJobs());
      addLog(`导出任务已创建：${exportFormatId.toUpperCase()}。`);
      setNotice("已加入导出队列");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setExportBusy(false);
    }
  }

  const nav = [
    { id: "acquisition" as const, label: "数据采集", icon: LayoutDashboard },
    { id: "devices" as const, label: "设备与组合", icon: Layers3 },
    { id: "sessions" as const, label: "录制记录", icon: FolderOpen },
    { id: "exports" as const, label: "导出中心", icon: ArrowDownToLine },
  ];
  const availableFormat = formats.find(
    (format) => format.id === exportFormatId,
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate("acquisition");
          }}
          aria-label="Synapse 采集工作站首页"
        >
          <span className="brand-mark">
            <Activity size={24} strokeWidth={2} />
          </span>
          <span className="brand-word">
            synapse<span>多模态采集工作站</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-symbol">
            <Monitor size={15} />
          </span>
          <div>
            <strong>本地工作空间</strong>
            <span>LOCAL WORKSPACE</span>
          </div>
          <span className="tiny-dot" />
        </div>
        <span className="nav-caption">工作台</span>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === "sessions" && sessions.length > 0 && (
                <span className="nav-count mono">{sessions.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className={`engine-card ${connected ? "" : "engine-offline"}`}>
            <span className="engine-symbol">
              <Cpu size={20} />
            </span>
            <div>
              <strong>C++ 采集引擎</strong>
              <span>
                <i className={`status-dot ${connected ? "green" : "gray"}`} />
                {connected ? "已连接 · 本机运行" : "等待连接"}
              </span>
            </div>
          </div>
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
            aria-current={page === "settings" ? "page" : undefined}
          >
            <Settings2 size={19} strokeWidth={1.7} />
            <span>设置与帮助</span>
          </button>
          <div className="sidebar-version">
            <span>Synapse</span>
            <span className="mono">v0.1.0 · PREVIEW</span>
          </div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{pageNames[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="simulation-pill">
              <span className="sim-dot" />
              模拟设备模式
            </span>
            <span className="topbar-divider" />
            <span
              className={`connection-indicator ${connected ? "connected" : ""}`}
            >
              {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
              <span>{connected ? "采集服务在线" : "服务未连接"}</span>
            </span>
            <button
              className="icon-button"
              onClick={() => navigate("settings")}
              aria-label="打开使用帮助"
              title="使用帮助"
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "acquisition"
                  ? "ACQUISITION WORKSPACE"
                  : page === "devices"
                    ? "DEVICE MANAGEMENT"
                    : page === "sessions"
                      ? "RECORDING LIBRARY"
                      : page === "exports"
                        ? "DATA EXPORT"
                        : "WORKSPACE SETTINGS"}
              </div>
              <h1>{pageNames[page]}</h1>
              <p>{pageSubtitles[page]}</p>
            </div>
            {page === "acquisition" && (
              <div className="heading-note">
                <ShieldCheck size={16} />
                <span>原始采集与预览独立运行</span>
              </div>
            )}
            {page === "sessions" && (
              <button
                className="button secondary"
                onClick={() => {
                  void refreshSessions().catch((cause) =>
                    setError(errorMessage(cause)),
                  );
                }}
              >
                <RefreshCw size={15} />
                刷新记录
              </button>
            )}
            {page === "devices" && (
              <button
                className="button secondary"
                disabled={refreshing}
                onClick={() => void scanDevices()}
              >
                <RefreshCw size={15} className={refreshing ? "spin" : ""} />
                扫描设备
              </button>
            )}
          </div>

          {!connected && (
            <div className="alert warning" role="status">
              <Unplug size={17} />
              <span>
                采集引擎未连接。请运行项目启动脚本；连接中断期间，录制状态需等待引擎重新确认。
              </span>
              <button onClick={() => void scanDevices()}>重试连接</button>
            </div>
          )}
          {error && (
            <div className="alert error" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="关闭错误提示"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {status.error && (
            <div className="alert error" role="alert">
              <span>
                采集引擎异常：{status.error}。请停止并保存，检查会话完整性。
              </span>
            </div>
          )}

          {page === "acquisition" && (
            <>
              <section
                className={`session-control ${recording ? "is-recording" : ""}`}
                aria-label="录制控制"
              >
                <div className="session-fields">
                  <label className="field-label" htmlFor="session-name">
                    实验名称
                    <input
                      id="session-name"
                      value={sessionName}
                      maxLength={100}
                      onChange={(event) => setSessionName(event.target.value)}
                      disabled={recording || busy}
                    />
                  </label>
                  <label
                    className="field-label combo-select"
                    htmlFor="profile-select"
                  >
                    采集组合
                    <div className="select-wrap">
                      <select
                        id="profile-select"
                        value={profileId}
                        disabled={recording || busy}
                        onChange={(event) => chooseProfile(event.target.value)}
                      >
                        <option value="">自定义组合</option>
                        {profiles.map((profile) => (
                          <option value={profile.id} key={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={13} />
                    </div>
                  </label>
                  <button
                    className="icon-button save-combo"
                    aria-label="保存当前采集组合"
                    title="保存当前组合"
                    disabled={recording || selectedDevices.length === 0}
                    onClick={() => {
                      setNewProfileName("");
                      setSaveDialog(true);
                    }}
                  >
                    <Save size={17} />
                  </button>
                </div>
                <div className="recording-controls">
                  <div className="recording-timer">
                    <span
                      className={`recording-dot ${recording ? "running" : ""}`}
                    />
                    <span className="mono">
                      {formatDuration(status.elapsed_s)}
                    </span>
                    <small>
                      {!connected
                        ? "状态未知"
                        : recording
                          ? "正在录制"
                          : "准备就绪"}
                    </small>
                  </div>
                  <button
                    className={`button recording-button ${recording ? "stop-button" : "primary"}`}
                    disabled={
                      !connected ||
                      busy ||
                      status.state === "stopping" ||
                      (!recording && selectedDevices.length === 0)
                    }
                    onClick={() =>
                      void (recording ? stopRecording() : startRecording())
                    }
                  >
                    {busy || status.state === "stopping" ? (
                      <Loader2 size={16} className="spin" />
                    ) : recording ? (
                      <Square size={14} fill="currentColor" />
                    ) : (
                      <span className="record-button-dot" />
                    )}
                    {busy
                      ? "处理中…"
                      : status.state === "stopping"
                        ? "正在保存…"
                        : recording
                          ? "停止并保存"
                          : "开始采集"}
                  </button>
                </div>
              </section>

              <div className="acquisition-layout">
                <section className="device-panel">
                  <div className="section-heading">
                    <h2>
                      数据源
                      <span className="count-label mono">
                        {String(devices.length).padStart(2, "0")}
                      </span>
                    </h2>
                    <button
                      className="icon-button quiet"
                      disabled={refreshing || recording}
                      onClick={() => void scanDevices()}
                      aria-label="重新扫描数据源"
                      title="扫描数据源"
                    >
                      <RefreshCw
                        size={15}
                        className={refreshing ? "spin" : ""}
                      />
                    </button>
                  </div>
                  <div className="device-selection-info">
                    <span>勾选加入本次采集</span>
                    <strong className="mono">
                      {selectedDevices.length} / {devices.length}
                    </strong>
                  </div>
                  <div className="device-list">
                    {devices.length === 0 ? (
                      <div className="device-placeholder">
                        <Cpu size={24} />
                        <p>等待采集引擎</p>
                        <small>连接后显示可用数据源</small>
                      </div>
                    ) : (
                      devices.map((device) => {
                        const Icon = kindIcons[device.kind] ?? Radio;
                        const checked = selectedIds.includes(device.id);
                        return (
                          <label
                            key={device.id}
                            className={`device-option ${checked ? "selected" : ""} ${recording ? "locked" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={recording || busy}
                              onChange={() => toggleDevice(device.id)}
                            />
                            <span className="custom-checkbox">
                              {checked && <Check size={12} strokeWidth={3} />}
                            </span>
                            <span
                              className={`device-icon modality-${device.kind}`}
                            >
                              <Icon size={19} strokeWidth={1.6} />
                            </span>
                            <div className="device-option-body">
                              <strong>{device.name}</strong>
                              <span>
                                {device.kind === "pressure"
                                  ? `${device.rows ?? 16} × ${device.cols ?? 16} 阵列`
                                  : device.kind === "camera"
                                    ? `${device.width ?? 160} × ${device.height ?? 90} RGB`
                                    : device.kind === "audio"
                                      ? "单声道音频"
                                      : "三轴加速度 / 三轴角速度"}
                              </span>
                              <div>
                                <i className="status-dot green" />
                                <span className="mono">
                                  {sampleRate(device)}
                                </span>
                                <span className="sim-badge">模拟</span>
                              </div>
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                  <div className="device-panel-bottom">
                    <div className="adapter-note">
                      <Layers3 size={16} />
                      <div>
                        <strong>扩展你的采集组合</strong>
                        <p>通过统一适配器接入新设备</p>
                      </div>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("devices")}
                    >
                      管理设备与组合
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </section>

                <section className="preview-section">
                  <div className="preview-section-heading">
                    <div>
                      <h2>
                        同步预览
                        <span
                          className={`live-label ${previewPaused ? "paused" : ""}`}
                        >
                          <i />
                          {previewPaused
                            ? "PAUSED"
                            : previewConnected
                              ? "LIVE"
                              : "OFFLINE"}
                        </span>
                      </h2>
                      <p>
                        显示刷新 {previewRate} Hz · 原始数据按设备采样率录制
                      </p>
                    </div>
                    <button
                      className="button subtle small"
                      aria-pressed={previewPaused}
                      onClick={() => setPreviewPaused(!previewPaused)}
                    >
                      {previewPaused ? <Play size={14} /> : <Pause size={14} />}
                      {previewPaused ? "恢复预览" : "暂停预览"}
                    </button>
                  </div>
                  <div className="preview-grid">
                    {devices.length > 0 ? (
                      [...devices]
                        .sort(
                          (a, b) =>
                            allDeviceIds.indexOf(a.id) -
                            allDeviceIds.indexOf(b.id),
                        )
                        .map((device) => (
                          <LivePreview
                            key={device.id}
                            device={device}
                            enabled={selectedIds.includes(device.id)}
                            paused={previewPaused}
                            connected={connected && previewConnected}
                          />
                        ))
                    ) : (
                      <div className="preview-loading">
                        <Loader2
                          size={23}
                          className={connected ? "spin" : ""}
                        />
                        <h3>准备多模态预览</h3>
                        <p>连接采集引擎后，四路数据将在这里汇集。</p>
                      </div>
                    )}
                  </div>
                </section>
              </div>

              <section className="metrics-strip" aria-label="采集运行指标">
                <div className="metric">
                  <span className="metric-label">
                    <HardDrive size={14} />
                    已写入数据
                  </span>
                  <strong className="mono">
                    {formatBytes(status.bytes_written)}
                  </strong>
                  <small className="mono">
                    {formatBytes(writeRate)}/s <span>当前写入</span>
                  </small>
                </div>
                <div className="metric">
                  <span className="metric-label">
                    <Layers3 size={14} />
                    已录制数据块
                  </span>
                  <strong className="mono">
                    {totalRecords.toLocaleString()}
                  </strong>
                  <small>按原始数据块计数</small>
                </div>
                <div className="metric">
                  <span className="metric-label">
                    <Cpu size={14} />
                    写入缓冲
                  </span>
                  <strong className="mono">
                    {status.queue_depth ?? 0}
                    <span> / {status.queue_capacity || "—"}</span>
                  </strong>
                  <small>有界队列 · 独立写盘</small>
                </div>
                <div
                  className={`metric ${status.dropped_records > 0 ? "metric-warning" : ""}`}
                >
                  <span className="metric-label">
                    <ShieldCheck size={14} />
                    丢弃数据块
                  </span>
                  <strong className="mono">
                    {status.dropped_records ?? 0}
                    <span className="metric-tag">
                      {status.dropped_records > 0 ? "需要检查" : "当前统计"}
                    </span>
                  </strong>
                  <small>
                    {status.dropped_records > 0
                      ? "缓冲溢出或录制异常，请检查会话"
                      : "以引擎记录的队列丢弃数为准"}
                  </small>
                </div>
              </section>

              <section className={`event-log ${logExpanded ? "expanded" : ""}`}>
                <button
                  className="event-log-heading"
                  onClick={() => setLogExpanded(!logExpanded)}
                  aria-expanded={logExpanded}
                >
                  <span>
                    <span className="log-pulse" />
                    运行日志<span className="mono">{logs.length}</span>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <div className="log-lines">
                  {logs.slice(0, logExpanded ? 12 : 1).map((entry) => (
                    <div className={`log-line ${entry.level}`} key={entry.id}>
                      <time className="mono">{entry.time}</time>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                  {logs.length === 0 && (
                    <div className="log-line">
                      <time className="mono">—</time>
                      <span>等待采集引擎连接…</span>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {page === "devices" && (
            <div className="devices-page">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>可用数据源</h2>
                    <p>当前提供模拟适配器，所有数据均为生成的测试信号。</p>
                  </div>
                  <span className="neutral-badge">{devices.length} 个设备</span>
                </div>
                <div className="table-scroll">
                  <table className="data-table device-table">
                    <thead>
                      <tr>
                        <th>设备</th>
                        <th>数据类型</th>
                        <th>采样配置</th>
                        <th>连接方式</th>
                        <th>加入组合</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map((device) => {
                        const Icon = kindIcons[device.kind] ?? Radio;
                        return (
                          <tr key={device.id}>
                            <td>
                              <div className="table-device">
                                <span
                                  className={`device-icon modality-${device.kind}`}
                                >
                                  <Icon size={19} />
                                </span>
                                <div>
                                  <strong>{device.name}</strong>
                                  <small className="mono">{device.id}</small>
                                </div>
                              </div>
                            </td>
                            <td>
                              {getDeviceLabel(device.kind)}
                              <small className="cell-subtext">
                                {device.dtype ??
                                  (device.kind === "camera"
                                    ? "RGB8"
                                    : "FLOAT32")}
                              </small>
                            </td>
                            <td className="mono">
                              {sampleRate(device)}
                              <small className="cell-subtext">
                                {device.channels} 通道
                              </small>
                            </td>
                            <td>
                              <span className="simulation-pill compact">
                                模拟信号
                              </span>
                            </td>
                            <td>
                              <label className="switch">
                                <input
                                  type="checkbox"
                                  checked={selectedIds.includes(device.id)}
                                  disabled={recording}
                                  onChange={() => toggleDevice(device.id)}
                                  aria-label={`将${device.name}加入采集组合`}
                                />
                                <span />
                              </label>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {devices.length === 0 && (
                    <EmptyState
                      icon={Unplug}
                      title="尚未连接采集引擎"
                      description="请先启动本机采集服务，再扫描数据源。"
                    />
                  )}
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>我的采集组合</h2>
                    <p>组合保存在当前工作台浏览器中，可重复使用。</p>
                  </div>
                  <button
                    className="button secondary small"
                    disabled={recording || selectedDevices.length === 0}
                    onClick={() => setSaveDialog(true)}
                  >
                    <Plus size={15} />
                    保存当前组合
                  </button>
                </div>
                <div className="profile-grid">
                  {profiles.map((profile) => (
                    <article
                      className={`profile-card ${profileId === profile.id ? "profile-active" : ""}`}
                      key={profile.id}
                    >
                      <div className="profile-card-heading">
                        <span className="profile-symbol">
                          <Layers3 size={21} />
                        </span>
                        <button
                          className="icon-button quiet"
                          disabled={recording}
                          aria-label={`删除组合${profile.name}`}
                          title="删除组合"
                          onClick={() => {
                            setProfiles((previous) =>
                              previous.filter((item) => item.id !== profile.id),
                            );
                            if (profileId === profile.id) setProfileId("");
                            setNotice("采集组合已删除");
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      <h3>{profile.name}</h3>
                      <p>{profile.device_ids.length} 个数据源</p>
                      <div className="profile-kind-list">
                        {profile.device_ids.map((id) => {
                          const device = devices.find((item) => item.id === id);
                          return (
                            <span key={id}>
                              {device
                                ? getDeviceLabel(device.kind)
                                : id.replace("sim-", "")}
                            </span>
                          );
                        })}
                      </div>
                      <button
                        className={`button small ${profileId === profile.id ? "subtle" : "secondary"}`}
                        disabled={recording}
                        onClick={() => {
                          chooseProfile(profile.id);
                          setNotice(`已应用「${profile.name}」`);
                        }}
                      >
                        {profileId === profile.id ? (
                          <Check size={14} />
                        ) : (
                          <ArrowRight size={14} />
                        )}
                        {profileId === profile.id ? "当前组合" : "应用组合"}
                      </button>
                    </article>
                  ))}
                </div>
                {profiles.length === 0 && (
                  <EmptyState
                    icon={Layers3}
                    title="创建第一个采集组合"
                    description="选择需要的设备后，点击保存当前组合。"
                  />
                )}
              </section>
              <section className="integration-note">
                <span className="integration-icon">
                  <Plus size={21} />
                </span>
                <div>
                  <h3>准备接入你的真实设备</h3>
                  <p>
                    适配器统一设备发现、参数描述、采集与停止接口。摄像头、麦克风和传感器协议接入后，可以沿用现有组合、录制和导出流程。
                  </p>
                </div>
                <button
                  className="button secondary small"
                  onClick={() => navigate("settings")}
                >
                  查看接入说明
                  <ArrowRight size={14} />
                </button>
              </section>
            </div>
          )}

          {page === "sessions" && (
            <section className="panel session-library">
              <div className="panel-heading">
                <div className="library-heading">
                  <h2>
                    全部录制
                    <span className="count-label mono">{sessions.length}</span>
                  </h2>
                  <span className="library-description">
                    保留原始采样率与会话信息
                  </span>
                </div>
                <label className="search-input">
                  <Search size={15} />
                  <input
                    value={sessionQuery}
                    onChange={(event) => setSessionQuery(event.target.value)}
                    placeholder="搜索实验名称或会话 ID"
                    aria-label="搜索录制记录"
                  />
                </label>
              </div>
              {sessions.length === 0 ? (
                <EmptyState
                  icon={FolderOpen}
                  title="你的第一段数据，从这里开始"
                  description="在数据采集页选择设备组合，完成录制后会自动保存到这里。"
                  action={
                    <button
                      className="button primary"
                      onClick={() => navigate("acquisition")}
                    >
                      <Play size={15} />
                      前往数据采集
                    </button>
                  }
                />
              ) : (
                <div className="table-scroll">
                  <table className="data-table session-table">
                    <thead>
                      <tr>
                        <th>实验 / 会话</th>
                        <th>数据源</th>
                        <th>录制时长</th>
                        <th>数据大小</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions
                        .filter((session) =>
                          `${session.name} ${session.id}`
                            .toLowerCase()
                            .includes(sessionQuery.toLowerCase()),
                        )
                        .map((session) => (
                          <tr key={session.id}>
                            <td>
                              <button
                                className="session-name-button"
                                onClick={() => void showDetails(session)}
                              >
                                {session.name || "未命名实验"}
                              </button>
                              <small className="cell-subtext">
                                {formatDate(session.started_at)}
                                <span className="dot-separator">·</span>
                                <span className="mono">{session.id}</span>
                              </small>
                            </td>
                            <td>
                              <div className="stream-icons">
                                {(session.device_ids ?? []).map((id) => {
                                  const kind = id.replace(
                                    "sim-",
                                    "",
                                  ) as DeviceKind;
                                  const Icon = kindIcons[kind] ?? Radio;
                                  return (
                                    <span
                                      className={`stream-icon modality-${kind}`}
                                      key={id}
                                      title={getDeviceLabel(kind)}
                                    >
                                      <Icon size={15} />
                                    </span>
                                  );
                                })}
                              </div>
                            </td>
                            <td className="mono">
                              {formatDuration(session.duration_s)}
                            </td>
                            <td className="mono">
                              {formatBytes(session.bytes_written)}
                            </td>
                            <td>
                              <span
                                className={`state-badge ${session.status === "complete" ? "complete" : session.status === "recording" ? "recording" : "failed"}`}
                              >
                                <i />
                                {session.status === "complete"
                                  ? "已保存"
                                  : session.status === "recording"
                                    ? "录制中"
                                    : session.status}
                              </span>
                            </td>
                            <td>
                              <div className="row-actions">
                                <button
                                  className="icon-button"
                                  title="查看会话详情"
                                  aria-label={`查看${session.name}详情`}
                                  onClick={() => void showDetails(session)}
                                >
                                  <FileJson size={17} />
                                </button>
                                <button
                                  className="button subtle small"
                                  disabled={session.status !== "complete"}
                                  onClick={() => openExport(session)}
                                >
                                  <Download size={14} />
                                  导出
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {sessions.filter((session) =>
                    `${session.name} ${session.id}`
                      .toLowerCase()
                      .includes(sessionQuery.toLowerCase()),
                  ).length === 0 && (
                    <EmptyState
                      icon={Search}
                      title="没有匹配的录制"
                      description="试试其他实验名称或会话 ID。"
                    />
                  )}
                </div>
              )}
            </section>
          )}

          {page === "exports" && (
            <div className="exports-page">
              <section className="panel export-create">
                <div className="panel-heading">
                  <div>
                    <h2>新建导出任务</h2>
                    <p>选择录制与格式，生成包含数据和元信息的 ZIP 数据包。</p>
                  </div>
                  <span
                    className={`state-badge ${exportOnline ? "complete" : "failed"}`}
                  >
                    <i />
                    {exportOnline ? "导出服务在线" : "导出服务离线"}
                  </span>
                </div>
                {!exportOnline && (
                  <div className="inline-notice">
                    <Unplug size={16} />
                    请启动 Python 导出服务（本机 8766 端口），随后将自动连接。
                  </div>
                )}
                <form onSubmit={(event) => void submitExport(event)}>
                  <div className="export-source">
                    <label className="field-label" htmlFor="export-session">
                      选择录制
                      <div className="select-wrap">
                        <select
                          id="export-session"
                          value={
                            exportSessionId || completeSessions[0]?.id || ""
                          }
                          onChange={(event) =>
                            setExportSessionId(event.target.value)
                          }
                          disabled={completeSessions.length === 0}
                        >
                          <option value="" disabled>
                            请先完成一次录制
                          </option>
                          {completeSessions.map((session) => (
                            <option value={session.id} key={session.id}>
                              {session.name} · {formatDate(session.started_at)}{" "}
                              · {formatDuration(session.duration_s)}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={14} />
                      </div>
                    </label>
                  </div>
                  <fieldset className="format-fieldset">
                    <legend>目标格式</legend>
                    <div className="format-grid">
                      {formats.map((format) => (
                        <label
                          className={`format-option ${exportFormatId === format.id ? "selected" : ""} ${!format.available ? "unavailable" : ""}`}
                          key={format.id}
                        >
                          <input
                            type="radio"
                            name="export-format"
                            value={format.id}
                            checked={exportFormatId === format.id}
                            disabled={!format.available}
                            onChange={() => setExportFormatId(format.id)}
                          />
                          <div className="format-option-top">
                            <strong className="mono">{format.label}</strong>
                            <span className="format-radio">
                              {exportFormatId === format.id && <span />}
                            </span>
                          </div>
                          <p>{format.description}</p>
                          {!format.available && <small>当前环境不可用</small>}
                        </label>
                      ))}
                    </div>
                    {formats.length === 0 && (
                      <p className="muted">连接导出服务后显示可用格式。</p>
                    )}
                  </fieldset>
                  <div className="export-footer">
                    <p>
                      <ShieldCheck size={15} />
                      保留原始时间戳、阵列形状与设备元信息
                    </p>
                    <button
                      className="button primary"
                      type="submit"
                      disabled={
                        !exportOnline ||
                        completeSessions.length === 0 ||
                        exportBusy ||
                        !availableFormat?.available
                      }
                    >
                      {exportBusy ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <ArrowDownToLine size={16} />
                      )}
                      创建导出任务
                    </button>
                  </div>
                </form>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      导出任务
                      <span className="count-label mono">{jobs.length}</span>
                    </h2>
                    <p>格式转换独立运行，进度会自动更新。</p>
                  </div>
                </div>
                {jobs.length === 0 ? (
                  <EmptyState
                    icon={FileCheck2}
                    title="还没有导出任务"
                    description="完成一次录制，选择适合你的分析流程的数据格式。"
                  />
                ) : (
                  <div className="export-job-list">
                    {[...jobs].reverse().map((job) => (
                      <div className="export-job" key={job.id}>
                        <span className={`export-job-icon ${job.status}`}>
                          {job.status === "running" ||
                          job.status === "pending" ? (
                            <Loader2 size={21} className="spin" />
                          ) : job.status === "complete" ? (
                            <FileCheck2 size={22} />
                          ) : (
                            <X size={21} />
                          )}
                        </span>
                        <div className="export-job-body">
                          <strong>
                            {sessions.find(
                              (session) => session.id === job.session_id,
                            )?.name ?? job.session_id}
                            <span className="neutral-badge mono">
                              {job.format.toUpperCase()}
                            </span>
                          </strong>
                          <p>
                            {job.status === "complete"
                              ? (job.filename ?? "数据包已就绪")
                              : job.status === "error"
                                ? (job.error ?? "导出失败")
                                : job.status === "pending"
                                  ? "等待导出…"
                                  : `正在转换 · ${Math.round(Math.max(0, Math.min(1, job.progress)) * 100)}%`}
                          </p>
                          {(job.status === "running" ||
                            job.status === "pending") && (
                            <progress
                              value={job.progress || 0}
                              max={1}
                              aria-label="导出进度"
                            />
                          )}
                        </div>
                        <span
                          className={`state-badge ${job.status === "complete" ? "complete" : job.status === "error" ? "failed" : "recording"}`}
                        >
                          <i />
                          {job.status === "complete"
                            ? "已完成"
                            : job.status === "error"
                              ? "失败"
                              : job.status === "pending"
                                ? "排队中"
                                : "导出中"}
                        </span>
                        {job.status === "complete" && job.download_url && (
                          <a
                            className="button secondary small"
                            href={downloadUrl(job.download_url)}
                            download
                          >
                            <Download size={15} />
                            下载数据包
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {page === "settings" && (
            <div className="settings-page">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>预览设置</h2>
                    <p>仅影响界面显示，原始采集频率由设备适配器决定。</p>
                  </div>
                  <SlidersHorizontal size={21} className="muted" />
                </div>
                <div className="setting-row">
                  <div>
                    <strong>界面刷新频率</strong>
                    <p>预览经过抽取，采集和写盘保持独立。</p>
                  </div>
                  <div className="segmented-control" aria-label="预览刷新频率">
                    {[2, 5, 10].map((rate) => (
                      <button
                        key={rate}
                        className={previewRate === rate ? "active" : ""}
                        onClick={() => setPreviewRate(rate)}
                        aria-pressed={previewRate === rate}
                      >
                        {rate} Hz
                      </button>
                    ))}
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>实时预览</strong>
                    <p>暂停显示可以降低界面负载，录制继续运行。</p>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!previewPaused}
                      onChange={() => setPreviewPaused(!previewPaused)}
                      aria-label="启用实时预览"
                    />
                    <span />
                  </label>
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>本地服务</h2>
                    <p>设备数据留在本机，服务只监听回环地址。</p>
                  </div>
                </div>
                <div className="service-row">
                  <span className="service-icon">
                    <Cpu size={22} />
                  </span>
                  <div>
                    <strong>原生采集引擎</strong>
                    <p className="mono">127.0.0.1:8765 · C++20</p>
                  </div>
                  <span
                    className={`state-badge ${connected ? "complete" : "failed"}`}
                  >
                    <i />
                    {connected ? "已连接" : "离线"}
                  </span>
                </div>
                <div className="service-row">
                  <span className="service-icon">
                    <ArrowDownToLine size={22} />
                  </span>
                  <div>
                    <strong>独立导出服务</strong>
                    <p className="mono">127.0.0.1:8766 · Python</p>
                  </div>
                  <span
                    className={`state-badge ${exportOnline ? "complete" : "failed"}`}
                  >
                    <i />
                    {exportOnline ? "已连接" : "离线"}
                  </span>
                </div>
                <div className="storage-note">
                  <HardDrive size={17} />
                  <span>
                    录制默认保存在 <code>data/sessions</code>，导出保存在{" "}
                    <code>data/exports</code>。启动参数可以更改目录。
                  </span>
                </div>
              </section>
              <section className="panel help-panel">
                <div className="panel-heading">
                  <div>
                    <h2>开始使用</h2>
                    <p>当前版本已经贯通模拟采集、原始录制和格式导出。</p>
                  </div>
                </div>
                <div className="help-steps">
                  <article>
                    <span className="step-number mono">01</span>
                    <h3>选择设备组合</h3>
                    <p>
                      在数据采集页勾选数据源，也可以保存组合，供后续实验重复使用。
                    </p>
                  </article>
                  <article>
                    <span className="step-number mono">02</span>
                    <h3>开始并保存录制</h3>
                    <p>
                      点击开始采集，数据直接写入原生二进制文件。停止时等待缓冲排空后保存会话。
                    </p>
                  </article>
                  <article>
                    <span className="step-number mono">03</span>
                    <h3>导出给你的工具</h3>
                    <p>
                      在导出中心生成数据包。摄像头附带无损 PNG
                      帧与时间索引，音频附带 WAV。
                    </p>
                  </article>
                </div>
                <div className="help-callout">
                  <CircleHelp size={19} />
                  <div>
                    <strong>接入真实设备前，需要准备什么？</strong>
                    <p>
                      提供设备型号、连接方式、厂商 SDK
                      或串口/网口协议，以及采样率和同步要求。新增适配器后可沿用现有录制流程。当前模拟数据不代表真实设备性能或同步精度。
                    </p>
                  </div>
                </div>
                <div className="help-callout neutral">
                  <FileJson size={19} />
                  <div>
                    <strong>关于原始数据与格式兼容</strong>
                    <p>
                      本版原始录制为带版本的 MDAQBIN1 二进制流和
                      manifest.json。所有导出保留原始时间信息，不自动重采样。ROS
                      2、LeRobot 等数据集规范尚未接入；MP4
                      编码器未配置时不可用。
                    </p>
                  </div>
                </div>
              </section>
            </div>
          )}

          <footer className="page-footer">
            <span>Synapse / 多模态数据采集</span>
            <span>
              <span className="mono">LOCAL FIRST</span>
              <i />
              模拟适配器 · 开发预览版
            </span>
          </footer>
        </div>
      </main>

      {notice && (
        <div className="toast" role="status">
          <span>
            <Check size={16} />
          </span>
          {notice}
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="关闭提示"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {saveDialog && (
        <Modal title="保存采集组合" onClose={() => setSaveDialog(false)}>
          <form onSubmit={saveProfile}>
            <p className="modal-description">
              将当前选择的 {selectedDevices.length} 个数据源保存为可复用组合。
            </p>
            <label className="field-label" htmlFor="profile-name">
              组合名称
              <input
                id="profile-name"
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
                placeholder="例如：步态多模态实验"
                maxLength={40}
                required
                autoFocus
              />
            </label>
            <div className="modal-device-list">
              {selectedDevices.map((device) => (
                <span key={device.id}>{device.name}</span>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setSaveDialog(false)}
              >
                取消
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={
                  !newProfileName.trim() || selectedDevices.length === 0
                }
              >
                <Save size={15} />
                保存组合
              </button>
            </div>
          </form>
        </Modal>
      )}
      {detailSession && (
        <Modal title="录制会话详情" onClose={() => setDetailSession(null)} wide>
          <div className="session-detail-summary">
            <h3>{detailSession.name}</h3>
            <span className="simulation-pill compact">模拟数据</span>
          </div>
          <div className="detail-metrics">
            <div>
              <span>录制时长</span>
              <strong className="mono">
                {formatDuration(detailSession.duration_s)}
              </strong>
            </div>
            <div>
              <span>原始数据大小</span>
              <strong className="mono">
                {formatBytes(detailSession.bytes_written)}
              </strong>
            </div>
            <div>
              <span>数据源</span>
              <strong className="mono">
                {detailSession.device_ids?.length ??
                  detailSession.streams?.length ??
                  0}
              </strong>
            </div>
          </div>
          <p className="detail-id mono">{detailSession.id}</p>
          <details className="manifest-details">
            <summary>
              查看完整会话元信息
              <ChevronDown size={14} />
            </summary>
            <pre>{JSON.stringify(detailSession, null, 2)}</pre>
          </details>
          <div className="modal-actions">
            <a
              className="button secondary"
              href={downloadUrl(
                `/api/files/${encodeURIComponent(detailSession.id)}/manifest.json`,
              )}
              download
            >
              <FileJson size={15} />
              下载元信息
            </a>
            <button
              className="button primary"
              disabled={detailSession.status !== "complete"}
              onClick={() => {
                openExport(detailSession);
                setDetailSession(null);
              }}
            >
              <Download size={15} />
              导出数据
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
