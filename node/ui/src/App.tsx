import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Activity,
  Bot,
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
  Flag,
  HardDrive,
  Layers3,
  LayoutDashboard,
  Loader2,
  Mic,
  Monitor,
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
import { getDeviceLabel } from "./LivePreview";
import { startPreviewPolling } from "./preview";
import { AcquisitionWorkspace } from "./AcquisitionWorkspace";
import type { CardUpdate } from "./AcquisitionWorkspace";
import { useSdkConnections } from "./useSdkConnections";
import { usePluginConnections } from "./usePluginConnections";
import { SdkAgentWorkbench } from "./SdkAgentWorkbench";
import type { SensorPlugin } from "./plugin-types";
import { useCameraCapture } from "./useCameraCapture";
import { useMicrophoneCapture } from "./useMicrophoneCapture";
import { useDesktopBeforeClose } from "./desktop";
import type { DesktopCloseResult } from "./desktop";
import { useAnnotations } from "./useAnnotations";
import { AnnotationPanel, AnnotationTimeline } from "./AnnotationPanel";
import { ExperimentDialog } from "./ExperimentDialog";
import { SessionReplay } from "./SessionReplay";
import { RecoveryInspection } from "./RecoveryInspection";
import { ContinuityReport } from "./ContinuityReport";
import { readDraft, saveDraft } from "./workflow";
import type { SdkProduct } from "./sdk-types";
import {
  cardsFromDeviceIds,
  cardStreamIds,
  createCameraCard,
  createMicrophoneCard,
  createSdkCard,
  createPluginCard,
  pluginCardMatchesManifest,
  isCardReady,
  isRealCaptureDevice,
  isRealWorkspaceCard,
  MAX_WORKSPACE_CARDS,
  mergeConnectedCards,
  normalizeCaptureProfile,
  parseWorkspace,
  SDK_CATALOG,
  WORKSPACE_STORAGE_KEY,
  workspaceStreamIds,
} from "./workspace";
import type { WorkspaceCard, WorkspaceState } from "./workspace";
import {
  deviceModeLabel,
  deviceSampleRate,
  isSimulatedDevice,
} from "./devices";
import type {
  Device,
  DeviceKind,
  ExportFormat,
  ExportJob,
  LogEntry,
  Profile,
  RecoveryReport,
  Session,
  Status,
} from "./types";

type Page = "acquisition" | "devices" | "sessions" | "replay" | "exports" | "settings" | "agent";
type SavedProfile = Profile & { workspace?: WorkspaceState };
function hardwareProfile(id: string, name: string, cards: WorkspaceCard[]): SavedProfile {
  return { id, name, device_ids: workspaceStreamIds(cards), workspace: { version: 1, cards, layout: "grid" } };
}
const defaultProfiles: SavedProfile[] = [
  hardwareProfile("real-multimodal", "全模态研究组合", [
    createCameraCard("c-multimodal"), createMicrophoneCard("m-multimodal"), createSdkCard("glove", "s-multimodal"),
  ]),
  hardwareProfile("real-tactile-motion", "触觉与动作", [createSdkCard("glove", "s-tactile")]),
  hardwareProfile("real-audio-visual", "音视频记录", [createCameraCard("c-audiovisual"), createMicrophoneCard("m-audiovisual")]),
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
  replay: "回放与标注",
  exports: "导出中心",
  settings: "设置与帮助",
  agent: "SDK 接入 Agent",
};
const pageSubtitles: Record<Page, string> = {
  acquisition: "选择传感器组合，让每一种感知在同一会话中汇集。",
  devices: "管理数据源，保存适合不同实验的采集组合。",
  sessions: "每次录制独立保存，原始数据、设备配置和时间信息始终关联。",
  replay: "沿录制时间回看数据，补充与修订标注。",
  exports: "从原始录制生成适合分析和训练的数据包。",
  settings: "配置工作台，了解采集链路与设备接入方式。",
  agent: "导入 SDK、对话适配并测试安装，让新设备进入你的采集工作台。",
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
  return deviceSampleRate(device);
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
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
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (!busy && event.target === ref.current) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          disabled={busy}
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

const isSavedSession = (session: Session) => ["complete", "completed"].includes(session.status) || session.status === "incomplete" && session.finalized === true;

export default function App() {
  const [page, setPage] = useState<Page>("acquisition");
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState<Status>(emptyStatus);
  const [connected, setConnected] = useState(false);
  const [previewConnected, setPreviewConnected] = useState(false);
  const [previewPaused, setPreviewPaused] = useState(false);
  const [previewRate, setPreviewRate] = useState(() => {
    const rate = readStorage<number>("synapse-node.preview-rate", 5);
    return [2, 5, 10].includes(rate) ? rate : 5;
  });
  const [profiles, setProfiles] = useState<SavedProfile[]>(() => {
    const saved = readStorage<SavedProfile[]>(
      "synapse-node.profiles.v1",
      defaultProfiles,
    );
    return Array.isArray(saved)
      ? saved.filter(
          (profile) =>
            !!profile &&
            typeof profile === "object" &&
            typeof profile.id === "string" &&
            typeof profile.name === "string" &&
            Array.isArray(profile.device_ids) &&
            profile.device_ids.every((id) => typeof id === "string"),
        ).flatMap(profile => {
          const normalized = normalizeCaptureProfile(profile);
          return normalized ? [normalized] : [];
        })
      : defaultProfiles;
  });
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => {
    const saved = parseWorkspace(
      readStorage<unknown>(WORKSPACE_STORAGE_KEY, null),
    );
    if (saved) return saved;
    const legacy = readStorage<unknown>("synapse-node.selection.v1", []);
    const ids = Array.isArray(legacy)
      ? legacy.filter((id): id is string => typeof id === "string")
      : [];
    return { version: 1, cards: cardsFromDeviceIds(ids), layout: "grid" };
  });
  const legacyMigrated = useRef(
    parseWorkspace(readStorage<unknown>(WORKSPACE_STORAGE_KEY, null)) !== null,
  );
  const selectedIds = workspaceStreamIds(workspace.cards);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const workspaceMutation = useRef(false);
  const mediaAutoStop = useRef<string | null>(null);
  const sessionOperation = useRef(false);
  const desktopClosePending = useRef(false);
  const statusGeneration = useRef(0);
  const [profileId, setProfileId] = useState(() => {
    const saved = readStorage<unknown>("synapse-node.active-profile.v1", "");
    return typeof saved === "string" ? saved : "";
  });
  const [sessionName, setSessionName] = useState(defaultName);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [formats, setFormats] = useState<ExportFormat[]>([]);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [exportOnline, setExportOnline] = useState(false);
  const [exportSessionId, setExportSessionId] = useState("");
  const [incompleteExportConfirmed, setIncompleteExportConfirmed] = useState(false);
  const exportSubmission = useRef(false);
  const [exportFormatId, setExportFormatId] = useState("npz");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveDialog, setSaveDialog] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [detailSession, setDetailSession] = useState<Session | null>(null);
  const [recoverySession, setRecoverySession] = useState<Session | null>(null);
  const [continuitySession, setContinuitySession] = useState<Session | null>(null);
  const [replaySeekRequest, setReplaySeekRequest] = useState<{ time_s: number; key: number }>();
  const [recoveryReport, setRecoveryReport] = useState<RecoveryReport | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryExportError, setRecoveryExportError] = useState("");
  const recoveryOperation = useRef(false);
  const [replaySession, setReplaySession] = useState<Session | null>(null);
  const [workflowDraft, setWorkflowDraft] = useState(readDraft);
  const [experimentOpen, setExperimentOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [annotationSessionId, setAnnotationSessionId] = useState<string | null>(null);
  const [lastRecordedSession, setLastRecordedSession] = useState<Session | null>(null);
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
  const liveAnnotations = useAnnotations(status.session_id ?? annotationSessionId, recording);
  useEffect(() => { if (status.session_id) setAnnotationSessionId(status.session_id); }, [status.session_id]);
  useEffect(() => { saveDraft(workflowDraft); }, [workflowDraft]);
  const selectedDevices = devices.filter((device) =>
    selectedIds.includes(device.id),
  );
  const selectionMode = workspace.cards.some(isRealWorkspaceCard) ? "真实设备组合" : "未选择数据源";
  const exportableSessions = sessions.filter(isSavedSession);
  const exportSource = exportableSessions.find(session => session.id === exportSessionId) ?? exportableSessions[0];
  useEffect(() => { setIncompleteExportConfirmed(false); }, [exportSource?.id]);
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
      const validDevices = Array.isArray(data.devices)
        ? data.devices.filter(
            (device) =>
              !!device &&
              typeof device === "object" &&
              typeof device.id === "string" &&
              typeof device.name === "string" &&
              typeof device.kind === "string" &&
              ["camera", "audio", "pressure", "imu"].includes(device.kind) &&
              typeof device.mode === "string" &&
              typeof device.unit === "string" &&
              typeof device.connected === "boolean" &&
              isRealCaptureDevice(device),
          )
        : [];
      setDevices(validDevices);
      if (announce)
        addLog(
          `设备列表已刷新，共 ${validDevices.length} 个数据源。`,
          "success",
        );
    },
    [addLog],
  );

  const sdk = useSdkConnections({
    online: connected,
    recording: recording || busy,
    onDevicesChanged: loadDevices,
  });
  const sdkInstancesRef = useRef(sdk.instances);
  const plugins = usePluginConnections({ online: connected, recording: recording || busy, onDevicesChanged: loadDevices });
  sdkInstancesRef.current = sdk.instances;
  const camera = useCameraCapture({
    online: connected,
    recording: recording || busy,
    onDevicesChanged: loadDevices,
  });
  const microphone = useMicrophoneCapture({
    online: connected,
    recording: recording || busy,
    onDevicesChanged: loadDevices,
  });
  const allCardsReady =
    workspace.cards.length > 0 &&
    workspace.cards.every((card) =>
      isCardReady(card, devices, sdk.instances, connected) &&
      (card.source !== "plugin" || pluginCardMatchesManifest(card, plugins.plugins.find(item => item.id === card.pluginId))) &&
      (card.source !== "camera" || camera.connections[card.id]?.connected === true) &&
      (card.source !== "microphone" || microphone.connections[card.id]?.connected === true),
    ) &&
    sdk.busyIds.length === 0 &&
    plugins.busyIds.length === 0 &&
    camera.busyIds.length === 0 &&
    microphone.busyIds.length === 0 &&
    !camera.scanning &&
    !microphone.scanning &&
    !workspaceBusy;

  useEffect(() => {
    if (!sdk.info || !connected) return;
    const migrating = !legacyMigrated.current;
    legacyMigrated.current = true;
    setWorkspace((current) => {
      const visibleInstances = migrating
        ? sdk.instances
        : sdk.instances.filter((instance) =>
            current.cards.some(
              (card) =>
                card.source === "sdk" && card.id === instance.instance_id,
            ),
          );
      const cards = mergeConnectedCards(current.cards, visibleInstances);
      return JSON.stringify(cards) === JSON.stringify(current.cards)
        ? current
        : { ...current, cards };
    });
  }, [sdk.info, sdk.instances, connected]);

  useEffect(() => {
    if (!sdk.info || !connected) return;
    setProfiles(current => {
      const next = current.flatMap(profile => {
        const normalized = normalizeCaptureProfile(profile, sdk.instances);
        return normalized ? [normalized] : [];
      });
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, [sdk.info, sdk.instances, connected]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const generation = statusGeneration.current;
      try {
        const next = await request<Status & { engine_alive?: boolean }>(
          "/api/status",
        );
        if (stopped || sessionOperation.current || generation !== statusGeneration.current) return;
        setStatus(next);
        if (next.session_id && Array.isArray(next.selected_ids)) {
          setWorkspace((current) => {
            const cards = cardsFromDeviceIds(next.selected_ids, current.cards, sdkInstancesRef.current);
            return JSON.stringify(cards) === JSON.stringify(current.cards)
              ? current
              : { ...current, cards };
          });
        }
        const engineAlive = next.engine_alive !== false;
        setConnected(engineAlive);
        if (engineAlive && connectionRef.current !== true) {
          addLog("本地 Node.js 采集服务已连接。", "success");
          void loadDevices().catch(() => {});
          void refreshSessions().catch(() => {});
        } else if (!engineAlive) {
          setPreviewConnected(false);
          if (connectionRef.current !== false) {
            addLog(
              "采集引擎已退出，预览与采集已禁用。请重启本地服务。",
              "error",
            );
            void loadDevices().catch(() => {});
          }
        }
        connectionRef.current = engineAlive;
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
        if (stopped || sessionOperation.current || generation !== statusGeneration.current) return;
        setConnected(false);
        setPreviewConnected(false);
        setWriteRate(0);
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
    if (previewPaused || !connected) return;
    return startPreviewPolling(1000 / previewRate, setPreviewConnected);
  }, [previewPaused, previewRate, connected]);

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
    storeValue("synapse-node.profiles.v1", profiles);
  }, [profiles]);
  useEffect(() => {
    storeValue("synapse-node.selection.v1", selectedIds);
    storeValue(WORKSPACE_STORAGE_KEY, workspace);
  }, [workspace]);
  useEffect(() => {
    storeValue("synapse-node.active-profile.v1", profileId);
  }, [profileId]);
  useEffect(() => {
    if (profileId && !profiles.some(profile => profile.id === profileId)) setProfileId("");
  }, [profileId, profiles]);
  useEffect(() => {
    storeValue("synapse-node.preview-rate", previewRate);
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
  async function replaceWorkspaceCards(
    cards: WorkspaceCard[],
    layout = workspace.layout,
  ) {
    cards = cards.filter(isRealWorkspaceCard);
    if (
      recording ||
      busy ||
      workspaceMutation.current ||
      sdk.busyIds.length > 0 ||
      plugins.busyIds.length > 0 ||
      camera.busyIds.length > 0 ||
      microphone.busyIds.length > 0
    )
      throw new Error("请等待当前操作完成后再更改传感器。");
    workspaceMutation.current = true;
    setWorkspaceBusy(true);
    try {
      for (const old of workspace.cards) {
        if (old.source === "plugin") {
          const replacement = cards.find(card => card.id === old.id);
          if ((!replacement || replacement.source !== "plugin" || replacement.pluginId !== old.pluginId ||
            JSON.stringify(replacement.config) !== JSON.stringify(old.config)) && plugins.instances.some(item => item.instance_id === old.id))
            await plugins.disconnect(old.id);
          continue;
        }
        if (old.source === "microphone") {
          const replacement = cards.find((card) => card.id === old.id);
          if (!replacement || replacement.source !== "microphone" || replacement.deviceId !== old.deviceId)
            await microphone.disconnect(old.id);
          continue;
        }
        if (old.source === "camera") {
          const replacement = cards.find((card) => card.id === old.id);
          if (!replacement || replacement.source !== "camera" ||
              replacement.deviceId !== old.deviceId || replacement.quality !== old.quality) {
            await camera.disconnect(old.id);
          }
          continue;
        }
        if (
          old.source !== "sdk" ||
          cards.some((card) => card.id === old.id && card.source === "sdk")
        )
          continue;
        const instance = sdk.instances.find(
          (item) => item.instance_id === old.id,
        );
        if (instance?.has_device || instance?.connected)
          await sdk.disconnect(old.id);
      }
      legacyMigrated.current = true;
      setWorkspace({ version: 1, cards, layout });
    } finally {
      workspaceMutation.current = false;
      setWorkspaceBusy(false);
    }
  }
  async function chooseProfile(id: string) {
    if (recording || busy || workspaceBusy) return;
    const profile = profiles.find((item) => item.id === id);
    if (!profile) {
      setProfileId("");
      return;
    }
    const normalized = normalizeCaptureProfile(profile, sdk.instances);
    if (!normalized) return;
    const savedWorkspace = normalized.workspace;
    const cards =
      savedWorkspace?.cards ??
      cardsFromDeviceIds(normalized.device_ids, workspace.cards, sdk.instances);
    const known = sdk.instances.filter((instance) =>
      cards.some((card) => card.id === instance.instance_id),
    );
    try {
      await replaceWorkspaceCards(
        mergeConnectedCards(cards, known),
        savedWorkspace?.layout ?? workspace.layout,
      );
      setProfileId(id);
      setNotice(
        `已应用「${profile.name}」，请在展示卡片内连接未就绪的传感器。`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function toggleDevice(id: string) {
    if (recording || busy || workspaceBusy || !devices.some(device => device.id === id)) return;
    const existing = workspace.cards.find((card) =>
      cardStreamIds(card).includes(id),
    );
    try {
      if (existing) await removeWorkspaceCard(existing.id);
      else {
        const cards = cardsFromDeviceIds([...selectedIds, id], workspace.cards, sdk.instances);
        await replaceWorkspaceCards(
          mergeConnectedCards(
            cards,
            sdk.instances.filter((instance) =>
              cards.some((card) => card.id === instance.instance_id),
            ),
          ),
        );
      }
      setProfileId("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  function addSdkCard(product: SdkProduct) {
    if (
      recording ||
      busy ||
      workspaceBusy ||
      workspace.cards.length >= MAX_WORKSPACE_CARDS ||
      !SDK_CATALOG.some(item => item.product === product)
    )
      return;
    legacyMigrated.current = true;
    const card = createSdkCard(product);
    setWorkspace((current) =>
      current.cards.length >= MAX_WORKSPACE_CARDS
        ? current
        : { ...current, cards: [...current.cards, card] },
    );
    setProfileId("");
  }
  function updateWorkspaceCard(id: string, patch: CardUpdate) {
    if (
      (recording || busy || workspaceBusy) &&
      (patch.path !== undefined || patch.side !== undefined ||
        patch.protocol !== undefined || patch.baudRate !== undefined ||
        patch.deviceId !== undefined || patch.quality !== undefined || patch.config !== undefined)
    )
      return;
    setWorkspace((current) => ({
      ...current,
      cards: current.cards.map((card) => {
        if (card.id !== id) return card;
        if (card.source === "simulation")
          return { ...card, expanded: patch.expanded ?? card.expanded };
        if (card.source === "plugin") return { ...card, config: patch.config ?? card.config,
          previewMode: patch.previewMode ?? card.previewMode,
          cameraLayout: patch.cameraLayout ?? card.cameraLayout,
          cameraSplit: patch.cameraSplit !== undefined && Number.isFinite(patch.cameraSplit) ? Math.max(0.2, Math.min(0.8, patch.cameraSplit)) : card.cameraSplit,
          selectedStream: patch.selectedStream ?? card.selectedStream, expanded: patch.expanded ?? card.expanded };
        if (card.source === "camera")
          return { ...card, deviceId: patch.deviceId ?? card.deviceId,
            quality: patch.quality ?? card.quality, expanded: patch.expanded ?? card.expanded };
        if (card.source === "microphone")
          return { ...card, deviceId: patch.deviceId ?? card.deviceId, expanded: patch.expanded ?? card.expanded };
        return { ...card, ...patch };
      }),
    }));
  }
  function addCameraCard() {
    if (recording || busy || workspaceBusy || workspace.cards.length >= MAX_WORKSPACE_CARDS) return;
    legacyMigrated.current = true;
    const card = createCameraCard();
    setWorkspace((current) => current.cards.length >= MAX_WORKSPACE_CARDS ? current :
      { ...current, cards: [...current.cards, card] });
    setProfileId("");
  }
  function addPluginCard(plugin: SensorPlugin) {
    if (recording || busy || workspaceBusy || workspace.cards.length >= MAX_WORKSPACE_CARDS) return;
    const card = createPluginCard(plugin);
    setWorkspace(current => current.cards.length >= MAX_WORKSPACE_CARDS ? current : { ...current, cards: [...current.cards, card] });
    setProfileId("");
  }
  function addMicrophoneCard() {
    if (recording || busy || workspaceBusy || workspace.cards.length >= MAX_WORKSPACE_CARDS) return;
    legacyMigrated.current = true;
    const card = createMicrophoneCard();
    setWorkspace((current) => current.cards.length >= MAX_WORKSPACE_CARDS ? current :
      { ...current, cards: [...current.cards, card] });
    setProfileId("");
  }
  async function removeWorkspaceCard(id: string) {
    await replaceWorkspaceCards(
      workspace.cards.filter((card) => card.id !== id),
    );
    setProfileId("");
  }
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    const name = newProfileName.trim();
    if (!name || workspace.cards.length === 0) return;
    const profile = {
      id: `profile-${Date.now()}`,
      name,
      device_ids: [...selectedIds],
      workspace,
    };
    setProfiles((previous) => [...previous, profile]);
    setProfileId(profile.id);
    setSaveDialog(false);
    setNewProfileName("");
    setNotice(`采集组合「${name}」已保存`);
    addLog(
      `保存采集组合「${name}」，包含 ${workspace.cards.length} 张传感器卡片。`,
    );
  }
  async function startRecording() {
    if (!connected || busy || recording || !allCardsReady || sessionOperation.current || desktopClosePending.current) return;
    sessionOperation.current = true;
    statusGeneration.current++;
    setBusy(true);
    setError("");
    let started = false;
    let startedSessionId: string | null = null;
    const startRequestId = crypto.randomUUID();
    try {
      const cameraSources = await camera.prepareRecording(
        workspace.cards.filter((card) => card.source === "camera").map((card) => card.id),
      );
      const microphoneSources = await microphone.prepareRecording(
        workspace.cards.filter((card) => card.source === "microphone").map((card) => card.id),
      );
      const response = await request<{ session_id: string; status: Status }>(
        "/api/sessions/start",
        {
          name: sessionName.trim() || defaultName(),
          device_ids: selectedIds,
          camera_sources: [...cameraSources, ...microphoneSources],
          experiment: workflowDraft.experiment,
          labels: workflowDraft.labels,
          profile: {
            name: activeProfile?.name ?? "自定义组合",
            device_ids: selectedIds,
            client_request_id: startRequestId,
          },
        },
        AbortSignal.timeout(30000),
      );
      started = true;
      startedSessionId = response.session_id;
      setAnnotationSessionId(response.session_id);
      setLastRecordedSession(null);
      if (response.status) setStatus(response.status);
      // Schedule both browser capture lanes before waiting for either one to acknowledge.
      const mediaStarts = await Promise.allSettled([
        camera.startRecording(response.session_id), microphone.startRecording(response.session_id),
      ]);
      const failedStart = mediaStarts.find(result => result.status === "rejected");
      if (failedStart?.status === "rejected") throw failedStart.reason;
      addLog(
        `开始录制「${sessionName.trim() || defaultName()}」，${selectedDevices.length} 路数据。`,
        "success",
      );
      setNotice(cameraSources.length + microphoneSources.length > 0
        ? "录制已开始，视频、WAV 音频与传感器分别保存到同一会话；请保持本页面打开"
        : "录制已开始，原始数据由采集引擎直接写盘");
    } catch (cause) {
      // A lost response does not prove that the server failed to start. Only
      // recover a session carrying this attempt's ID, never another tab's one.
      if (!started) {
        try {
          const latest = await request<Status>("/api/status");
          if (latest.session_id) {
            const active = await request<Session>(`/api/sessions/${encodeURIComponent(latest.session_id)}`);
            const profile = active.profile as { client_request_id?: string } | undefined;
            if (profile?.client_request_id === startRequestId) {
              started = true;
              startedSessionId = latest.session_id;
              setStatus(latest);
            }
          }
        } catch {
          addLog("暂时无法确认启动结果；服务恢复后请检查录制状态。", "error");
        }
      }
      // A browser media source can still fail after the backend has opened a session.
      // Close every prepared recorder and preserve the partial session on disk.
      await Promise.allSettled([camera.cancelPrepared(), microphone.cancelPrepared()]);
      if (started) {
        await Promise.allSettled([camera.stopRecording(), microphone.stopRecording()]);
        try {
          const stopped = await request<{ status: Status }>("/api/sessions/stop", { session_id: startedSessionId }, AbortSignal.timeout(30000));
          if (stopped.status) setStatus(stopped.status);
          await refreshSessions();
        } catch (cleanupError) {
          addLog(`启动失败后的停止请求未完成：${errorMessage(cleanupError)}，请再次停止录制。`, "error");
        }
      }
      setError(errorMessage(cause));
      addLog(`录制启动失败：${errorMessage(cause)}`, "error");
    } finally {
      sessionOperation.current = false;
      statusGeneration.current++;
      setBusy(false);
    }
  }
  async function stopRecording(verifiedStatus?: Status): Promise<DesktopCloseResult> {
    if (busy || sessionOperation.current) return { ok: false, message: "采集操作正在进行，请完成后再退出。" };
    if (!connected && !verifiedStatus) return { ok: false, message: "采集服务离线，暂时无法停止并保存。" };
    const stoppingStatus = verifiedStatus ?? status;
    const stoppingSessionId = stoppingStatus.session_id;
    if (!stoppingSessionId) return { ok: false, message: "无法确认需要停止的录制会话，请刷新状态后重试。" };
    const hasCamera = stoppingStatus.selected_ids.some(id => id.startsWith("camera-"));
    const hasMicrophone = stoppingStatus.selected_ids.some(id => id.startsWith("microphone-"));
    if (stoppingStatus.camera_stop_requires_owner !== false &&
        ((hasCamera && camera.recordingSessionId() !== stoppingSessionId) ||
         (hasMicrophone && microphone.recordingSessionId() !== stoppingSessionId))) {
      const message = "这段录制的摄像头或麦克风由另一个页面控制，请回到开始录制的页面点击「停止并保存」，以便收齐最后一段音视频。";
      setError(message);
      return { ok: false, message };
    }
    sessionOperation.current = true;
    statusGeneration.current++;
    setBusy(true);
    setError("");
    try {
      const mediaStops = await Promise.allSettled([camera.stopRecording(), microphone.stopRecording()]);
      const failedMedia = mediaStops.find(result => result.status === "rejected");
      const mediaError = failedMedia?.status === "rejected" ? failedMedia.reason : undefined;
      if (mediaError) addLog(`音视频保存异常：${errorMessage(mediaError)}`, "error");
      // Always stop raw capture, even if a browser track or upload failed.
      const response = await request<{ session: Session; status: Status }>(
        "/api/sessions/stop",
        { session_id: stoppingSessionId },
        AbortSignal.timeout(30000),
      );
      if (response.status) setStatus(response.status);
      await refreshSessions();
      if (response.session?.id) setExportSessionId(response.session.id);
      setLastRecordedSession(response.session);
      if (response.session.status === "complete" && !mediaError) {
        addLog(
          `录制已保存：${response.session?.name ?? sessionName}。`,
          "success",
        );
        setNotice("录制已保存，可在录制记录中查看或导出");
        return { ok: true };
      } else {
        const message = `录制已停止，但数据不完整：${mediaError ? errorMessage(mediaError) : String(response.session.error ?? "存在丢弃或写盘异常，请查看会话详情")}`;
        setError(message);
        addLog("录制不完整，请查看会话详情。", "error");
        return { ok: false, message };
      }
    } catch (cause) {
      setError(errorMessage(cause));
      addLog(`停止录制失败：${errorMessage(cause)}`, "error");
      return { ok: false, message: `停止录制失败：${errorMessage(cause)}` };
    } finally {
      sessionOperation.current = false;
      statusGeneration.current++;
      setBusy(false);
    }
  }
  useDesktopBeforeClose(async () => {
    if (busy || sessionOperation.current || workspaceBusy || workspaceMutation.current ||
        sdk.busyIds.length > 0 || camera.busyIds.length > 0 || microphone.busyIds.length > 0 ||
        sdk.scanning || camera.scanning || microphone.scanning)
      return { ok: false, message: "采集或设备操作正在进行，请完成后再退出。" };
    desktopClosePending.current = true;
    const expectedSessionId = status.session_id;
    const inactive = (value: Status) => value.session_id === null && (value.state === "idle" || value.state === "error");
    try {
      const before = await request<Status>("/api/status");
      if (sessionOperation.current) return { ok: false, message: "采集操作正在进行，请完成后再退出。" };
      if (inactive(before)) return { ok: true };
      const hasCamera = before.selected_ids?.some(id => id.startsWith("camera-"));
      const hasMicrophone = before.selected_ids?.some(id => id.startsWith("microphone-"));
      if (before.camera_stop_requires_owner !== false &&
          ((hasCamera && camera.recordingSessionId() !== before.session_id) ||
           (hasMicrophone && microphone.recordingSessionId() !== before.session_id)))
        return { ok: false, message: "摄像头或麦克风正在另一个页面录制，请回到开始录制的页面点击「停止并保存」，再退出桌面应用。" };
      if (!before.session_id || before.session_id !== expectedSessionId)
        return { ok: false, message: "当前录制会话已变化，请确认采集状态后再退出；其他会话未被停止。" };
      if (camera.recordingSessionId() !== before.session_id)
        return { ok: false, message: "这段录制由其他页面发起，请先在原页面点击「停止并保存」，再退出桌面应用。" };
      if (before.state === "stopping") return { ok: false, message: "录制正在保存，请等待完成后再退出。" };
      const result = await stopRecording(before);
      // stopRecording reports errors to the UI; only a fresh server status proves that capture ended.
      const after = await request<Status>("/api/status");
      if (!inactive(after)) return { ok: false, message: after.session_id && after.session_id !== expectedSessionId
        ? "服务已开始另一段录制，请确认后再退出；新会话未被停止。"
        : "采集服务尚未确认录制结束，请检查保存状态后再退出。" };
      if (!result.ok) return { ok: false, message: `${result.message ?? "录制保存异常。"} 请检查录制记录后再退出。` };
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: `无法确认采集已结束：${errorMessage(cause)}。请恢复服务连接后再退出。` };
    } finally {
      desktopClosePending.current = false;
    }
  });
  useEffect(() => {
    if (!recording) { mediaAutoStop.current = null; return; }
    if (!recording || busy || !connected || (!camera.error && !microphone.error)) return;
    if (!status.session_id || mediaAutoStop.current === status.session_id) return;
    const affected = Object.values(camera.connections).some((connection) =>
      connection.error && status.selected_ids.includes(`camera-${connection.instanceId}`),
    ) || Object.values(microphone.connections).some((connection) =>
      connection.error && status.selected_ids.includes(`microphone-${connection.instanceId}`),
    );
    if (affected) {
      mediaAutoStop.current = status.session_id;
      void stopRecording();
    }
    // Browser media faults stop the whole selected session, preserving its partial data.
    // The busy flag serializes this with user-triggered start/stop operations.
  }, [camera.error, camera.connections, microphone.error, microphone.connections, recording, busy, connected, status.session_id, status.selected_ids]);
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
    setIncompleteExportConfirmed(false);
    navigate("exports");
  }
  async function inspectRecovery(session: Session) {
    if (recoveryOperation.current || recording || busy) return;
    recoveryOperation.current = true;
    setRecoverySession(session);
    setRecoveryReport(null);
    setRecoveryError("");
    setRecoveryExportError("");
    setRecoveryLoading(true);
    setDetailSession(null);
    try {
      const report = await request<RecoveryReport>(`/api/sessions/${encodeURIComponent(session.id)}/recovery`,
        { allow_incomplete: true }, AbortSignal.timeout(125000));
      setRecoveryReport(report);
    } catch (cause) { setRecoveryError(errorMessage(cause)); }
    finally { recoveryOperation.current = false; setRecoveryLoading(false); }
  }
  async function exportRecovery(format: string) {
    if (!recoverySession || !recoveryReport?.has_data || recoveryOperation.current || recording || busy || exportBusy) return;
    recoveryOperation.current = true;
    setExportBusy(true);
    setRecoveryExportError("");
    try {
      const job = await request<ExportJob>("/api/export/jobs", { session_id: recoverySession.id, format, recovery: true });
      setJobs(previous => [...previous.filter(item => item.id !== job.id), job]);
      setRecoverySession(null);
      setNotice("不完整数据包已加入导出队列，包内会保留缺损报告");
      navigate("exports");
    } catch (cause) { setRecoveryExportError(errorMessage(cause)); }
    finally { recoveryOperation.current = false; setExportBusy(false); }
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
  async function openReplay(session: Session) {
    try {
      const full = await request<Session>(`/api/sessions/${encodeURIComponent(session.id)}`);
      setReplaySession(full);
      setReplaySeekRequest(undefined);
      setDetailSession(null);
      navigate("replay");
    } catch (cause) { setError(errorMessage(cause)); }
  }
  async function seekContinuityIssue(timeSeconds: number) {
    if (!continuitySession || !Number.isFinite(timeSeconds)) return;
    try {
      const full = replaySession?.id === continuitySession.id ? replaySession
        : await request<Session>(`/api/sessions/${encodeURIComponent(continuitySession.id)}`);
      setReplaySession(full);
      setReplaySeekRequest(previous => ({ time_s: Math.max(0, timeSeconds), key: (previous?.key ?? 0) + 1 }));
      setContinuitySession(null);
      setDetailSession(null);
      navigate("replay");
    } catch (cause) { setError(errorMessage(cause)); }
  }
  async function submitExport(event: FormEvent) {
    event.preventDefault();
    const sessionId = exportSource?.id;
    const recovery = exportSource?.status === "incomplete";
    if (!sessionId || !exportOnline || exportBusy || exportSubmission.current || recovery && (!incompleteExportConfirmed || recording || busy)) return;
    exportSubmission.current = true;
    setExportBusy(true);
    setError("");
    try {
      await request("/api/export/jobs", {
        session_id: sessionId,
        format: exportFormatId,
        ...(recovery ? { recovery: true } : {}),
      });
      setJobs(await getJobs());
      addLog(`导出任务已创建：${exportFormatId.toUpperCase()}。`);
      setNotice("已加入导出队列");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      exportSubmission.current = false;
      setExportBusy(false);
    }
  }

  const nav = [
    { id: "acquisition" as const, label: "数据采集", icon: LayoutDashboard },
    { id: "devices" as const, label: "设备与组合", icon: Layers3 },
    { id: "sessions" as const, label: "录制记录", icon: FolderOpen },
    { id: "exports" as const, label: "导出中心", icon: ArrowDownToLine },
    { id: "agent" as const, label: "SDK 接入 Agent", icon: Bot },
  ];
  const availableFormat = formats.find(
    (format) => format.id === exportFormatId,
  );

  return (
    <div
      className={`app-shell ${page === "acquisition" || page === "replay" ? "acquisition-mode" : ""} ${page === "replay" ? "replay-mode" : ""} ${page === "acquisition" ? "capture-page" : ""}`}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate("acquisition");
          }}
          aria-label="Synapse Node 采集工作站首页"
        >
          <span className="brand-mark">
            <Activity size={24} strokeWidth={2} />
          </span>
          <span className="brand-word">
            synapse<span>Node.js 采集原型</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-symbol">
            <Monitor size={15} />
          </span>
          <div>
            <strong>Node 原型工作空间</strong>
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
              aria-label={item.label}
              title={item.label}
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
              <strong>Node.js 采集服务</strong>
              <span>
                <i className={`status-dot ${connected ? "green" : "gray"}`} />
                <span>{connected ? "已连接 · 本机运行" : "等待连接"}</span>
              </span>
            </div>
          </div>
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
            aria-label="设置与帮助"
            title="设置与帮助"
            aria-current={page === "settings" ? "page" : undefined}
          >
            <Settings2 size={19} strokeWidth={1.7} />
            <span>设置与帮助</span>
          </button>
          <div className="sidebar-version">
            <span>Synapse</span>
            <span className="mono">v0.1.0 · NODE</span>
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
              <span>{selectionMode}</span>
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
                采集服务未连接。请在 node 文件夹运行 npm
                start；连接中断期间，录制状态需等待服务重新确认。
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
                {`采集引擎异常：${status.error}。${recording ? "请检查当前会话是否完整。" : "请重启采集服务后重试。"}`}
              </span>
            </div>
          )}
          {page === "agent" && <SdkAgentWorkbench recording={recording || busy} onInstalled={plugins.refresh} onCapture={() => navigate("acquisition")} />}
          {page === "replay" && replaySession && <SessionReplay key={replaySession.id} session={replaySession} onClose={() => navigate("sessions")} onExport={() => openExport(replaySession)} onInspectContinuity={() => setContinuitySession(replaySession)} seekRequest={replaySeekRequest} />}
          {page === "acquisition" && (
            <>
              <h1 className="sr-only">数据采集工作区</h1>
              <section
                className={`session-control ${recording ? "is-recording" : ""}`}
                aria-label="录制控制"
              >
                <div className="session-fields">
                  <label className="field-label" htmlFor="session-name">
                    <span>本次录制名称</span>
                    <input
                      id="session-name"
                      value={sessionName}
                      maxLength={100}
                      onChange={(event) => setSessionName(event.target.value)}
                      disabled={recording || busy || workspaceBusy}
                    />
                  </label>
                  <label
                    className="field-label combo-select"
                    htmlFor="profile-select"
                  >
                    <span>采集组合</span>
                    <div className="select-wrap">
                      <select
                        id="profile-select"
                        value={profileId}
                        disabled={recording || busy || workspaceBusy}
                        onChange={(event) =>
                          void chooseProfile(event.target.value)
                        }
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
                    disabled={recording || workspace.cards.length === 0}
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
                          : workspace.cards.length === 0
                            ? "请添加传感器"
                            : !allCardsReady
                              ? "等待连接"
                              : "准备就绪"}
                    </small>
                  </div>
                  <button
                    className={`button recording-button ${recording ? "stop-button" : "primary"}`}
                    disabled={
                      !connected ||
                      busy ||
                      status.state === "stopping" ||
                      workspaceBusy ||
                      (!recording && !allCardsReady)
                    }
                    onClick={() =>
                      void (recording ? stopRecording() : startRecording())
                    }
                  >
                    <span className="button-icon" aria-hidden="true">
                      {busy || status.state === "stopping" ? (
                        <Loader2 size={16} className="spin" />
                      ) : recording ? (
                        <Square size={14} fill="currentColor" />
                      ) : (
                        <span className="record-button-dot" />
                      )}
                    </span>
                    <span>
                      {busy
                        ? "处理中…"
                        : status.state === "stopping"
                          ? "正在保存…"
                          : recording
                            ? "停止并保存"
                            : "开始采集"}
                    </span>
                  </button>
                </div>
              </section>

              <div className="workflow-toolbar">
                <button className="button secondary small" disabled={recording || busy} onClick={() => setExperimentOpen(true)}><Settings2 size={15} />设置采集任务</button>
                <span className="workflow-context-summary" title={workflowDraft.experiment.task || "可直接录制，也可设置这次要采什么"}>{workflowDraft.experiment.task || "自由采集 · 可直接开始"}{workflowDraft.experiment.subject ? ` · ${workflowDraft.experiment.subject}` : ""}</span>
                {lastRecordedSession && !recording && <button className="button subtle small" onClick={() => void openReplay(lastRecordedSession)}><Play size={14} />回放刚才的录制</button>}
                {lastRecordedSession && !recording && <button className="button subtle small" onClick={() => setContinuitySession(lastRecordedSession)}><Activity size={14} />时间连续性</button>}
                <button className="button secondary small" aria-pressed={labelsOpen} title="录制时按一下，记下动作发生的时间；不需要也可以直接录制" onClick={() => setLabelsOpen(!labelsOpen)}><Flag size={15} />{labelsOpen ? "收起动作标记" : "动作标记（可选）"}<span className="workflow-count">{liveAnnotations.document?.annotations.length ?? 0}</span></button>
              </div>
              <div className={`capture-workflow-layout ${labelsOpen ? "with-annotations" : ""}`}>
              <div className="capture-display-column">
              <AcquisitionWorkspace
                cardContentFullscreen
                workspace={workspace}
                devices={devices}
                sdk={sdk}
                plugins={plugins}
                onAddPlugin={addPluginCard}
                onOpenAgent={() => navigate("agent")}
                camera={camera}
                microphone={microphone}
                online={connected}
                previewConnected={previewConnected}
                previewPaused={previewPaused}
                previewRate={previewRate}
                recording={recording}
                busy={busy || workspaceBusy}
                onAddSdk={addSdkCard}
                onAddCamera={addCameraCard}
                onAddMicrophone={addMicrophoneCard}
                onRemove={removeWorkspaceCard}
                onUpdate={updateWorkspaceCard}
                onLayout={(layout) =>
                  setWorkspace((current) => ({ ...current, layout }))
                }
                onTogglePreview={() => setPreviewPaused(!previewPaused)}
                onStopRecording={() => void stopRecording()}
              />
              {labelsOpen && liveAnnotations.document && liveAnnotations.document.annotations.length > 0 && <section className="capture-label-timeline"><div><span><Flag size={13} />{recording ? "动作发生时间" : "上一段录制的动作标记"}</span><small>{liveAnnotations.document.annotations.length} 条</small></div><AnnotationTimeline annotations={liveAnnotations.document.annotations} duration={recording ? status.elapsed_s : lastRecordedSession?.duration_s ?? 0} cursor={recording ? status.elapsed_s : lastRecordedSession?.duration_s ?? 0} /></section>}
              </div>
              <div className="capture-annotation-column" hidden={!labelsOpen}><AnnotationPanel document={liveAnnotations.document} labels={workflowDraft.labels} live={recording} disabled={!recording || !connected || busy} busy={liveAnnotations.busy} error={liveAnnotations.error} streams={selectedDevices} cursor={status.elapsed_s} duration={status.elapsed_s} onMutate={liveAnnotations.mutate} onSettings={() => setExperimentOpen(true)} onClose={() => setLabelsOpen(false)} /></div>
              </div>
              <section
                className="acquisition-statusbar"
                aria-label="采集运行指标"
              >
                <span>
                  <HardDrive size={14} />
                  <span>已写入</span>
                  <strong className="mono">
                    {formatBytes(status.bytes_written)}
                  </strong>
                </span>
                <span className="mono">{formatBytes(writeRate)}/s</span>
                <span>
                  <Layers3 size={14} />
                  <strong className="mono">
                    {totalRecords.toLocaleString()}
                  </strong>
                  <span>数据块</span>
                </span>
                <span>
                  <Cpu size={14} />
                  <span>缓冲</span>
                  <strong className="mono">
                    {[
                      status.queue_depth ?? 0,
                      status.queue_capacity || "—",
                    ].join(" / ")}
                  </strong>
                </span>
                <span
                  className={
                    status.dropped_records > 0 ? "dropped-warning" : ""
                  }
                >
                  <ShieldCheck size={14} />
                  <span>丢弃</span>
                  <strong className="mono">
                    {status.dropped_records ?? 0}
                  </strong>
                </span>
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
              <section className="integration-note">
                <span className="integration-icon">
                  <Layers3 size={21} />
                </span>
                <div>
                  <h3>在展示卡片内连接传感器</h3>
                  <p>
                    前往数据采集页，从列表添加传感器，在每张卡片内设置串口、左右手并连接。
                  </p>
                </div>
                <button
                  className="button secondary small"
                  onClick={() => navigate("acquisition")}
                >
                  <span>前往采集工作区</span>
                  <ArrowRight size={14} />
                </button>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>可用数据源</h2>
                    <p>
                      摄像头、麦克风与 SDK 传感器连接后，可加入采集组合。
                    </p>
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
                              {device.preview_supported === false &&
                              device.kind === "imu"
                                ? "IMU 原始字节"
                                : getDeviceLabel(device.kind)}
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
                                {deviceModeLabel(device)}
                              </span>
                              <small className="cell-subtext">
                                {device.transport}
                              </small>
                            </td>
                            <td>
                              <label className="switch">
                                <input
                                  type="checkbox"
                                  checked={selectedIds.includes(device.id)}
                                  disabled={
                                    recording ||
                                    busy ||
                                    workspaceBusy ||
                                    !connected ||
                                    !device.connected
                                  }
                                  onChange={() => void toggleDevice(device.id)}
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
                    disabled={recording || workspace.cards.length === 0}
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
                                : id}
                            </span>
                          );
                        })}
                      </div>
                      <button
                        className={`button small ${profileId === profile.id ? "subtle" : "secondary"}`}
                        disabled={recording}
                        onClick={() => {
                          void chooseProfile(profile.id);
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
                                    : session.status === "incomplete" ? "数据不完整" : session.status}
                              </span>
                            </td>
                            <td>
                              <div className="row-actions">
                                {session.status === "incomplete" && <button className="button subtle small" disabled={session.finalized !== true || recording || busy || recoveryLoading || exportBusy} onClick={() => void inspectRecovery(session)}>检查异常录制</button>}
                                <button className="button subtle small" disabled={!isSavedSession(session)} onClick={() => void openReplay(session)} aria-label={`回放与标注${session.name}`}><Play size={14} />回放与标注</button>
                                <button className="button subtle small" disabled={!isSavedSession(session)} onClick={() => setContinuitySession(session)} aria-label={`查看${session.name}的时间连续性`}><Activity size={14} />时间连续性</button>
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
                                  disabled={!isSavedSession(session)}
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
                    请在 node 文件夹运行 npm start，采集与导出服务会一同启动。
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
                            exportSource?.id || ""
                          }
                          onChange={(event) =>
                            setExportSessionId(event.target.value)
                          }
                          disabled={exportableSessions.length === 0}
                        >
                          <option value="" disabled>
                            请先停止并保存一次录制
                          </option>
                          {exportableSessions.map((session) => (
                            <option value={session.id} key={session.id}>
                              {session.name} · {formatDate(session.started_at)}{" "}
                              · {formatDuration(session.duration_s)}{session.status === "incomplete" ? " · 数据不完整" : ""}
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
                  {exportSource?.status === "incomplete" && <div className="recovery-check-panel">
                    <p className="recovery-warning">这段录制不完整。导出将在后台校验并保留可用部分与缺损报告；不修复原文件，也不会将它标为完整。无需先完成全量检查。</p>
                    {exportSource.error && <p className="recovery-warning">录制错误：{exportSource.error}</p>}
                    <p className="workflow-help">大录制打包需要额外磁盘空间；也可在会话详情中逐个下载媒体文件。</p>
                    <label className="recovery-confirmation"><input type="checkbox" checked={incompleteExportConfirmed} onChange={event => setIncompleteExportConfirmed(event.target.checked)} />我了解数据不完整，导出可用部分和缺损报告。</label>
                  </div>}
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
                        exportableSessions.length === 0 ||
                        exportBusy ||
                        exportSource?.status === "incomplete" && (!incompleteExportConfirmed || recording || busy) ||
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
                            {job.recovery && <span className="recovery-package-badge">不完整数据包</span>}
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
                    <strong>Node.js 采集服务</strong>
                    <p className="mono">Node.js · 本机 API</p>
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
                    <strong>后台格式导出</strong>
                    <p className="mono">Node.js · 独立工作线程</p>
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
                    录制默认保存在 <code>node/data/sessions</code>，导出保存在{" "}
                    <code>node/data/exports</code>。启动参数可以更改目录。
                  </span>
                </div>
              </section>
              <section className="panel help-panel">
                <div className="panel-heading">
                  <div>
                    <h2>开始使用</h2>
                    <p>连接真实传感器，完成多模态录制、回放与格式导出。</p>
                  </div>
                </div>
                <div className="help-steps">
                  <article>
                    <span className="step-number mono">01</span>
                    <h3>选择设备组合</h3>
                    <p>
                      从左侧目录添加传感器，在展示卡片内连接设备，也可以保存组合供后续实验使用。
                    </p>
                  </article>
                  <article>
                    <span className="step-number mono">02</span>
                    <h3>开始并保存录制</h3>
                    <p>
                      点击开始采集，传感器原始数据与摄像头视频保存到同一会话。停止时等待写盘完成；录制摄像头时请保持页面打开。
                    </p>
                  </article>
                  <article>
                    <span className="step-number mono">03</span>
                    <h3>导出给你的工具</h3>
                    <p>
                      在导出中心生成数据包。系统摄像头附带原始 WebM / MP4 视频，麦克风附带 PCM16 WAV 音频。
                    </p>
                  </article>
                </div>
                <div className="help-callout">
                  <CircleHelp size={19} />
                  <div>
                    <strong>接入真实设备前，需要准备什么？</strong>
                    <p>
                      提供设备型号、连接方式、厂商 SDK
                      或串口/网口协议，以及采样率和同步要求。摄像头与麦克风可直接选择系统设备；新增传感器适配器后可沿用现有录制流程。
                    </p>
                  </div>
                </div>
                <div className="help-callout neutral">
                  <FileJson size={19} />
                  <div>
                    <strong>关于原始数据与格式兼容</strong>
                    <p>
                      传感器保存为 MDAQBIN1 二进制流，系统摄像头保存为浏览器支持的视频格式，由 manifest.json 关联。视频与传感器的开始时间均有记录，但不保证硬件同步。
                      HDF5、MAT、视频转码、ROS 2 和 LeRobot 等格式尚未接入。
                    </p>
                  </div>
                </div>
              </section>
            </div>
          )}

          <footer className="page-footer">
            <span>Synapse Node / 多模态数据采集</span>
            <span>
              <span className="mono">LOCAL FIRST</span>
              <i />
              {selectionMode} · Node 原型版
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
              {`将展示区的 ${workspace.cards.length} 张传感器卡片及连接参数保存为可复用组合。`}
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
              {workspace.cards.map((card) => (
                <span key={card.id}>
                  {card.source === "sdk"
                    ? SDK_CATALOG.find((item) => item.product === card.product)
                        ?.name
                    : card.source === "camera" ? "安卓 / 系统摄像头" : card.source === "microphone" ? "麦克风" : card.source === "plugin" ? card.name : "传感器"}
                </span>
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
                  !newProfileName.trim() || workspace.cards.length === 0
                }
              >
                <Save size={15} />
                保存组合
              </button>
            </div>
          </form>
        </Modal>
      )}
      {experimentOpen && <ExperimentDialog value={workflowDraft} allowTemplates onClose={() => setExperimentOpen(false)} onSave={draft => {
        setWorkflowDraft(draft);
        if (draft.experiment.task.trim() && (!sessionName.trim() || sessionName.startsWith("多模态实验 "))) setSessionName(draft.experiment.task.trim());
        setExperimentOpen(false);
        setNotice("采集任务已保存，动作标记可以按需使用");
      }} />}
      {detailSession && (
        <Modal title="录制会话详情" onClose={() => setDetailSession(null)} wide>
          <div className="session-detail-summary">
            <h3>{detailSession.name}</h3>
            <span className="simulation-pill compact">
              {detailSession.media_streams?.length ? "含实采音视频" : detailSession.streams?.length &&
              detailSession.streams.every(isSimulatedDevice)
                ? "模拟数据"
                : detailSession.source === "mixed"
                  ? "SDK 与模拟混合"
                  : detailSession.source === "shroom-sdk"
                    ? "SDK 数据"
                    : "模拟数据"}
            </span>
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
          {detailSession.status === "incomplete" && <div className="recovery-warning" role="status"><strong>数据不完整 · 已保存部分仍可查看</strong><p>{detailSession.error ?? "部分采集未完整收尾。"}</p><p>文件清单不代表逐条校验通过。可进入回放查看可读部分，或快速检查各路文件；原始录制状态保持不变。</p></div>}
          {(detailSession.streams?.length ?? 0) > 0 && <details className="session-video-files"><summary>原始传感器文件 · {detailSession.streams?.length} 路</summary><div className="session-media-downloads">
            {detailSession.streams?.map(stream => <div key={stream.id} className="session-video-file"><span>{stream.name} · 清单记录 {stream.records ?? "未知"} 条{stream.error && <small>{stream.error}</small>}</span>
              {stream.file && <a className="button secondary small" download href={downloadUrl(`/api/files/${encodeURIComponent(detailSession.id)}/${encodeURIComponent(stream.file)}`)}>下载原始文件</a>}
            </div>)}
          </div></details>}
          {(detailSession.media_streams?.length ?? 0) > 0 && (
            <div className="session-video-files">
              <p>视频、WAV 音频与传感器分别保存在同一会话。时间线记录浏览器采集与服务端接收时间，不保证硬件同步。</p>
              {detailSession.media_streams?.map((media) => (
                <div key={media.id}>
                <div className="session-video-file">
                  {media.kind === "audio" ? <Mic size={17} /> : <Video size={17} />}
                  <span>{media.name} · {media.kind === "audio" ? `${media.sample_rate} Hz · WAV` : `${media.width} × ${media.height}`} · {formatBytes(media.bytes)}
                    {!media.finalized && " · 未完成"}{media.segments?.length ? ` · ${media.segments.length} 段` : ""}
                    {media.error && <small>{media.error}</small>}</span>
                  {media.file && !media.segments?.length && (
                    <a className="button secondary" download href={downloadUrl(
                      `/api/files/${encodeURIComponent(detailSession.id)}/${media.file.split("/").map(encodeURIComponent).join("/")}`,
                    )}>
                      <Download size={14} />{media.kind === "audio" ? "下载 WAV" : "下载视频"}
                    </a>
                  )}
                </div>
                {!!media.segments?.length && <details><summary>逐段下载 WAV（{media.segments.length} 段）</summary><div className="session-media-downloads">
                  {media.segments.map((segment, index) => <div key={segment.index} className="session-video-file"><span>第 {index + 1} 段 · {formatDuration(segment.duration_ms / 1000)} · {formatBytes(segment.bytes)}{!segment.finalized && " · 未完成"}{segment.error && <small>{segment.error}</small>}</span>
                    <a className="button secondary small" download href={downloadUrl(`/api/files/${encodeURIComponent(detailSession.id)}/${encodeURIComponent(segment.file)}`)} aria-label={`下载${media.name}第 ${index + 1} 段 WAV`}><Download size={14} />下载 WAV</a>
                  </div>)}
                </div></details>}
                </div>
              ))}
            </div>
          )}
          <details className="manifest-details">
            <summary>
              查看完整会话元信息
              <ChevronDown size={14} />
            </summary>
            <pre>{JSON.stringify(detailSession, null, 2)}</pre>
          </details>
          <div className="modal-actions">
            {detailSession.status === "incomplete" && <button className="button secondary" disabled={detailSession.finalized !== true || recording || busy || recoveryLoading || exportBusy} onClick={() => void inspectRecovery(detailSession)}>检查异常录制与可用部分</button>}
            <button className="button secondary" disabled={!isSavedSession(detailSession)} onClick={() => void openReplay(detailSession)}><Play size={15} />回放与标注</button>
            <button className="button secondary" disabled={!isSavedSession(detailSession)} onClick={() => setContinuitySession(detailSession)}><Activity size={15} />时间连续性</button>
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
              disabled={!isSavedSession(detailSession)}
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
      {recoverySession && <Modal title={`异常录制检查 · ${recoverySession.name}`} wide busy={recoveryLoading || exportBusy} onClose={() => setRecoverySession(null)}>
        <RecoveryInspection key={recoverySession.id} report={recoveryReport} loading={recoveryLoading} error={recoveryError} exportError={recoveryExportError} exporting={exportBusy} formats={formats}
          onRetry={() => void inspectRecovery(recoverySession)} onExport={format => void exportRecovery(format)} />
      </Modal>}
      {continuitySession && <ContinuityReport key={continuitySession.id} session={continuitySession} onClose={() => setContinuitySession(null)} onSeek={timeSeconds => void seekContinuityIssue(timeSeconds)} />}
    </div>
  );
}
