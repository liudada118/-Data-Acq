import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Activity,
  AlertCircle,
  Cable,
  CircleHelp,
  ChevronRight,
  ChevronLeft,
  Grid2X2,
  LayoutList,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Settings2,
  Square,
  Unplug,
  Video,
  X,
} from "lucide-react";
import { LivePreview } from "./LivePreview";
import { PluginCameraFeeds } from "./PluginCameraFeeds";
import { CameraPreview } from "./CameraPreview";
import { MicrophonePreview } from "./MicrophonePreview";
import { MicrophoneDialog } from "./MicrophoneDialog";
import { SerialPortOwnership } from "./SerialPortOwnership";
import { SdkReceiveHealthStatus } from "./SdkReceiveHealth";
import { sensorDisplayName } from "./devices";
import { workspaceViewportLayout } from "./viewport-layout";
import { useCardPositions } from "./useCardPositions";
import { CardMoveHandle } from "./CardMoveHandle";
import { useMediaLayout } from "./useMediaLayout";
import { useCardSizes } from "./useCardSizes";
import { CardResizeControls } from "./CardResizeControls";
import type { UseCameraCaptureResult } from "./camera-types";
import type { UseMicrophoneCaptureResult } from "./microphone-types";
import type { Device } from "./types";
import type { useSdkConnections } from "./useSdkConnections";
import type { usePluginConnections } from "./usePluginConnections";
import type { PluginConfig, SensorPlugin } from "./plugin-types";
import type { GloveProtocol, InsoleBaudRate, InsoleProtocol, SdkProduct } from "./sdk-types";
import { INSOLE_BAUD_RATES, sdkHasImu } from "./sdk-types";
import {
  MAX_WORKSPACE_CARDS,
  SDK_CATALOG,
  SIMULATION_CATALOG,
  cardStreamIds,
  createCameraCard,
  createMicrophoneCard,
  createSdkCard,
  createPluginCard,
  pluginCardMatchesManifest,
  isCardReady,
} from "./workspace";
import type {
  BrowserCameraWorkspaceCard,
  BrowserMicrophoneWorkspaceCard,
  SdkWorkspaceCard,
  PluginWorkspaceCard,
  WorkspaceCard,
  WorkspaceState,
} from "./workspace";

export type CardUpdate = Partial<
  Pick<SdkWorkspaceCard, "path" | "side" | "protocol" | "gloveProtocol" | "baudRate" | "view" | "expanded"> &
  Pick<BrowserCameraWorkspaceCard, "deviceId" | "quality">
> & { config?: PluginConfig; selectedStream?: string; previewMode?: PluginWorkspaceCard["previewMode"];
  cameraLayout?: PluginWorkspaceCard["cameraLayout"]; cameraSplit?: number };

export interface AcquisitionWorkspaceProps {
  workspace: WorkspaceState;
  onAddSim?: (deviceId: string) => void;
  onAddSdk: (product: SdkProduct) => void;
  onAddCamera: () => void;
  onAddMicrophone?: () => void;
  onRemove: (id: string) => Promise<void>;
  onUpdate: (id: string, patch: CardUpdate) => void;
  onLayout: (layout: WorkspaceState["layout"]) => void;
  devices: Device[];
  sdk: ReturnType<typeof useSdkConnections>;
  plugins?: ReturnType<typeof usePluginConnections>;
  onAddPlugin?: (plugin: SensorPlugin) => void;
  onOpenAgent?: () => void;
  camera: UseCameraCaptureResult;
  microphone?: UseMicrophoneCaptureResult;
  online: boolean;
  recording: boolean;
  busy: boolean;
  previewPaused: boolean;
  previewConnected: boolean;
  previewRate: number;
  onTogglePreview: () => void;
  onStopRecording?: () => void;
  cardContentFullscreen?: boolean;
}

const kindIcons = {
  camera: Video,
  audio: Mic,
  pressure: ScanLine,
  imu: Activity,
};
const CAMERA_NAME = "安卓 / 系统摄像头";
const MICROPHONE_NAME = "麦克风";
const EMPTY_MICROPHONES: Pick<UseMicrophoneCaptureResult, "devices" | "connections" | "busyIds" | "scanning" | "error"> = {
  devices: [], connections: {}, busyIds: [], scanning: false, error: "",
};

export function AcquisitionWorkspace({
  workspace,
  onAddSdk,
  onAddCamera,
  onAddMicrophone,
  onRemove,
  onUpdate,
  onLayout,
  devices,
  sdk,
  plugins,
  onAddPlugin,
  onOpenAgent,
  camera,
  microphone,
  online,
  recording,
  busy,
  previewPaused,
  previewConnected,
  previewRate,
  onTogglePreview,
  onStopRecording,
  cardContentFullscreen = false,
}: AcquisitionWorkspaceProps) {
  const microphones = microphone ?? EMPTY_MICROPHONES;
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const catalogRef = useRef<HTMLElement>(null);
  const catalogReturnFocus = useRef<HTMLElement | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [connectionActions, setConnectionActions] = useState<Record<string, "connect" | "disconnect" | undefined>>({});
  const configurationPanels = useRef(new Map<string, HTMLDivElement>());
  const [displaySettingsContainers, setDisplaySettingsContainers] = useState<Record<string, HTMLDivElement>>({});
  const displaySettingsRefs = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const [summaryContainers, setSummaryContainers] = useState<Record<string, HTMLSpanElement>>({});
  const summaryRefs = useRef(new Map<string, (element: HTMLSpanElement | null) => void>());
  const [removing, setRemoving] = useState<string[]>([]);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const sensorGridRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [boardHeight, setBoardHeight] = useState(540);
  const [viewport, setViewport] = useState({ width: 1100, height: 500 });
  const [page, setPage] = useState(0);
  const [resizingSensorId, setResizingSensorId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<Record<string, boolean>>({});
  const [microphoneDialog, setMicrophoneDialog] = useState<{ id: string; mode: "help" | "settings" } | null>(null);
  const previousIds = useRef(workspace.cards.map(card => card.id));
  const expandedCard = workspace.cards.find(card => card.expanded);
  const mediaCards = workspace.cards.filter(card => card.source === "camera" || card.source === "microphone");
  const sensorCards = workspace.cards.filter(card => card.source !== "camera" && card.source !== "microphone");
  const mediaFocused = !!expandedCard && mediaCards.some(card => card.id === expandedCard.id);
  const mediaLayout = useMediaLayout({ ...viewport, cameraCount: mediaCards.filter(card => card.source === "camera").length,
    audioCount: mediaCards.filter(card => card.source === "microphone").length, sensorCount: sensorCards.length, focused: !!expandedCard });
  const sensorViewport = mediaLayout.metrics.sensorViewport;
  const layout = workspaceViewportLayout(sensorViewport.width, sensorViewport.height, sensorCards.length, workspace.layout === "stack");
  const sensorDefaultWidth = Math.max(1, (sensorViewport.width - (layout.columns - 1) * 10) / layout.columns - 1);
  const sensorDefaultHeight = Math.max(1, (sensorViewport.height - (layout.rows - 1) * 10) / layout.rows - 1);
  const sensorSizes = useCardSizes({ scope: "live:sensors", onResize: setResizingSensorId, cards: sensorCards.map(card => ({ id: card.id, kind: "sensor" as const,
    defaultWidth: sensorDefaultWidth, defaultHeight: sensorDefaultHeight, maxWidth: Math.max(1, sensorViewport.width - 1), maxHeight: Math.max(1, sensorViewport.height - 1) })) });
  const sensorPositions = useCardPositions({ scope: "live:sensors", gridRef: sensorGridRef, layout,
    cards: sensorCards.map(card => ({ id: card.id, width: sensorSizes.getSize(card.id).width, height: sensorSizes.getSize(card.id).height })),
    viewportWidth: sensorViewport.width, viewportHeight: sensorViewport.height, disabled: !!expandedCard || catalogOpen });
  const sensorGrid = sensorPositions.plan;
  const sensorPage = Math.max(0, Math.min(sensorGrid.pages.length - 1, (resizingSensorId ? sensorGrid.placements[resizingSensorId]?.page : undefined) ?? page));
  const pageRange = { ...sensorGrid.pages[sensorPage], page: sensorPage, pages: sensorGrid.pages.length };
  const shownIds = new Set(expandedCard ? [expandedCard.id] : [...mediaCards.map(card => card.id), ...sensorCards.slice(pageRange.start, pageRange.end).map(card => card.id)]);
  const locked = recording || busy;
  const hasSerialCards = workspace.cards.some((card) => card.source === "sdk" && card.product !== "mock");
  const sdkLoaded = sdk.info?.loaded === true;
  const autoScanned = useRef(false);
  const { scanPorts, scanning } = sdk;
  const serialPorts = [...new Map(sdk.ports.filter((port) => port.path.trim()).map((port) => [port.path, port])).values()]
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const readyIds = useMemo(() => new Set(workspace.cards.filter((card) =>
    isCardReady(card, devices, sdk.instances, online) &&
    (card.source !== "plugin" || pluginCardMatchesManifest(card, plugins?.plugins.find(item => item.id === card.pluginId))) &&
    (card.source !== "camera" || camera.connections[card.id]?.connected === true) &&
    (card.source !== "microphone" || microphones.connections[card.id]?.connected === true),
  ).map(card => card.id)), [workspace.cards, devices, sdk.instances, online, camera.connections, microphones.connections, plugins?.plugins]);
  const readyCount = readyIds.size;
  const previousReadyIds = useRef(readyIds);
  const hiddenIssues = workspace.cards.filter(card => !shownIds.has(card.id) &&
    (errors[card.id] || (card.source === "camera" ? camera.connections[card.id]?.error :
      card.source === "microphone" ? microphones.connections[card.id]?.error :
      card.source === "sdk" ? sdk.instances.find(instance => instance.instance_id === card.id)?.error : false)));

  function displaySettingsSlot(id: string) {
    let callback = displaySettingsRefs.current.get(id);
    if (!callback) {
      callback = element => setDisplaySettingsContainers(current => {
        if (current[id] === element || !element && !current[id]) return current;
        const next = { ...current };
        if (element) next[id] = element; else delete next[id];
        return next;
      });
      displaySettingsRefs.current.set(id, callback);
    }
    return callback;
  }

  function summarySlot(id: string) {
    let callback = summaryRefs.current.get(id);
    if (!callback) {
      callback = element => setSummaryContainers(current => {
        if (current[id] === element || !element && !current[id]) return current;
        const next = { ...current };
        if (element) next[id] = element; else delete next[id];
        return next;
      });
      summaryRefs.current.set(id, callback);
    }
    return callback;
  }

  useEffect(() => {
    const ids = new Set(workspace.cards.map(card => card.id));
    for (const id of displaySettingsRefs.current.keys()) if (!ids.has(id)) displaySettingsRefs.current.delete(id);
    for (const id of summaryRefs.current.keys()) if (!ids.has(id)) summaryRefs.current.delete(id);
  }, [workspace.cards]);

  useEffect(() => {
    const changed = workspace.cards.filter(card => previousReadyIds.current.has(card.id) !== readyIds.has(card.id));
    previousReadyIds.current = readyIds;
    if (!changed.length) return;
    // A new connection state restores the default: configure until ready, then
    // show the data. Polling the same state must preserve a manual toggle.
    setSettingsOpen(current => {
      const next = { ...current };
      for (const card of changed) delete next[card.id];
      return next;
    });
  }, [readyIds, workspace.cards]);

  useEffect(() => {
    for (const [id, message] of Object.entries(errors)) {
      if (message && settingsOpen[id]) {
        const panel = configurationPanels.current.get(id);
        if (panel) panel.scrollTop = 0;
      }
    }
  }, [errors, settingsOpen]);

  useEffect(() => {
    const measure = () => {
      const root = workspaceRef.current;
      if (!root) return;
      // Desktop capture owns the height budget, including timelines, alerts and
      // expanded logs. Only standalone/narrow layouts need a viewport fallback.
      const constrained = !focused && window.innerWidth >= 900 && window.innerHeight >= 600 && !!root.closest(".capture-page");
      if (!constrained) {
        const page = root.closest<HTMLElement>(".page-content");
        const bottomPadding = page ? parseFloat(window.getComputedStyle(page).paddingBottom) || 0 : 0;
        const available = focused ? window.innerHeight - 16 : window.innerHeight - root.getBoundingClientRect().top - 66 - bottomPadding;
        setBoardHeight(previous => Math.abs(previous - available) > 1 ? Math.max(300, available) : previous);
      }
      const bounds = gridRef.current?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0) setViewport(previous => previous.width === bounds.width && previous.height === bounds.height ? previous : { width: bounds.width, height: bounds.height });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (workspaceRef.current) observer?.observe(workspaceRef.current);
    if (workspaceRef.current?.parentElement) observer?.observe(workspaceRef.current.parentElement);
    if (gridRef.current) observer?.observe(gridRef.current);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [focused, workspace.cards.length > 0]);

  useEffect(() => {
    const addedIndex = sensorCards.findIndex(card => !previousIds.current.includes(card.id));
    previousIds.current = workspace.cards.map(card => card.id);
    if (addedIndex >= 0) { setResizingSensorId(null); setPage(sensorGrid.placements[sensorCards[addedIndex].id]?.page ?? 0); }
    else if (page !== pageRange.page) setPage(pageRange.page);
  }, [workspace.cards, layout.pageSize, page, pageRange.page]);

  useEffect(() => {
    if (!focused) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target as Element | null)?.closest?.("dialog")) return;
      if (event.key === "Escape" && !catalogOpen) { event.preventDefault(); setFocused(false); }
      if (event.key === "Tab" && !catalogOpen) {
        const items = [...(workspaceRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])]
          .filter(element => !element.closest("[hidden], .sensor-catalog") && element.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = overflow; };
  }, [focused, catalogOpen]);

  useEffect(() => {
    if (!cardContentFullscreen || catalogOpen) return;
    const closePanels = (returnFocus = false, target?: Element | null) => {
      const open = workspace.cards.filter(card => {
        const panel = configurationPanels.current.get(card.id);
        return panel?.hidden === false && !panel.closest("[hidden]");
      });
      const targetId = (target?.closest?.("[data-instance-id]") ?? document.activeElement?.closest("[data-instance-id]"))?.getAttribute("data-instance-id");
      const targeted = returnFocus ? open.find(card => card.id === targetId) ?? (open.length === 1 ? open[0] : undefined) : undefined;
      const closing = targeted ? [targeted] : open.filter(card => readyIds.has(card.id));
      if (!closing.length) return false;
      setSettingsOpen(current => ({ ...current, ...Object.fromEntries(closing.map(card => [card.id, false])) }));
      if (returnFocus) workspaceRef.current?.querySelector<HTMLButtonElement>(`[data-settings-for="${closing[0].id}"]`)?.focus();
      return true;
    };
    const pointerdown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest || target.closest("dialog, .workspace-config-panel, .workspace-settings-toggle, .microphone-help-toggle, .catalog-toggle, .card-move-control")) return;
      closePanels();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || workspaceRef.current?.querySelector('.preview-display-toggle[aria-expanded="true"]')) return;
      if ((event.target as Element | null)?.closest?.("dialog, .preview-display-settings:not(.preview-settings-embedded), .preview-display-toggle, .card-move-control")) return;
      if (event.key !== "Escape" || !closePanels(true, event.target as Element | null)) return;
      event.preventDefault(); event.stopPropagation();
    };
    document.addEventListener("pointerdown", pointerdown);
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("pointerdown", pointerdown); document.removeEventListener("keydown", keydown, true); };
  }, [cardContentFullscreen, catalogOpen, settingsOpen, workspace.cards, readyIds]);

  useEffect(() => {
    if (!cardContentFullscreen || !expandedCard) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || catalogOpen || (event.target as Element | null)?.closest?.("dialog")) return;
      event.preventDefault(); onUpdate(expandedCard.id, { expanded: false });
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [cardContentFullscreen, expandedCard, catalogOpen, onUpdate]);

  useEffect(() => {
    if (!online || !sdkLoaded || !hasSerialCards) {
      autoScanned.current = false;
      return;
    }
    if (locked || scanning || autoScanned.current) return;
    // Let the parent SDK hook finish its online lifecycle before requesting ports.
    const timer = setTimeout(() => {
      autoScanned.current = true;
      void scanPorts().catch(() => {}); // The SDK hook exposes scan errors in the page status.
    }, 0);
    return () => clearTimeout(timer);
  }, [online, sdkLoaded, hasSerialCards, locked, scanning, scanPorts]);

  useEffect(() => {
    if (!catalogOpen) return;
    // Save the trigger before its containing workspace becomes inert.
    const previousFocus = catalogReturnFocus.current ?? document.activeElement as HTMLElement | null;
    const catalog = catalogRef.current;
    catalog?.querySelector<HTMLElement>("button, input")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCatalogOpen(false);
      }
      if (event.key !== "Tab" || !catalog) return;
      const items = [
        ...catalog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled)",
        ),
      ];
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      const target = previousFocus?.isConnected ? previousFocus : workspaceRef.current?.querySelector<HTMLElement>(".catalog-toggle");
      target?.focus({ preventScroll: true });
    };
  }, [catalogOpen]);

  function openCatalog(trigger: HTMLElement) {
    catalogReturnFocus.current = trigger;
    setCatalogOpen(true);
  }

  function patchCard(id: string, patch: CardUpdate) {
    onUpdate(id, patch);
  }
  function resetSettings(id: string) {
    setSettingsOpen(current => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  function addCard(card: WorkspaceCard) {
    if (locked) return;
    if (card.source === "simulation" || (card.source === "sdk" && card.product === "mock")) return;
    else if (card.source === "camera") onAddCamera();
    else if (card.source === "microphone") onAddMicrophone?.();
    else if (card.source === "plugin") { const plugin = plugins?.plugins.find(item => item.id === card.pluginId); if (plugin) onAddPlugin?.(plugin); }
    else onAddSdk(card.product);
    setCatalogOpen(false);
  }
  function showError(id: string, cause: unknown) {
    setErrors((current) => ({
      ...current,
      [id]: cause instanceof Error ? cause.message : "操作失败，请重试。",
    }));
    setSettingsOpen(current => ({ ...current, [id]: true }));
  }
  async function connection(card: WorkspaceCard, disconnect = false) {
    if (card.source !== "sdk" || locked) return;
    setErrors((current) => ({ ...current, [card.id]: "" }));
    setConnectionActions(current => ({ ...current, [card.id]: disconnect ? "disconnect" : "connect" }));
    try {
      if (disconnect) await sdk.disconnect(card.id);
      else
        await sdk.connect({
          instance_id: card.id,
          product: card.product,
          ...(card.product === "mock"
            ? { mode: "mock" as const }
            : { path: card.path.trim() }),
          ...(sdkHasImu(card.product) ? { side: card.side } : {}),
          ...(card.product === "insole" ? { protocol: card.protocol ?? "12bit", baudRate: card.baudRate ?? 921600 } : {}),
          ...(card.product === "glove" ? { gloveProtocol: card.gloveProtocol ?? "segmented" } : {}),
        });
      resetSettings(card.id);
    } catch (cause) {
      showError(card.id, cause);
    } finally {
      setConnectionActions(current => ({ ...current, [card.id]: undefined }));
    }
  }
  async function pluginConnection(card: PluginWorkspaceCard, disconnect = false) {
    if (locked || !plugins) return;
    setErrors(current => ({ ...current, [card.id]: "" }));
    setConnectionActions(current => ({ ...current, [card.id]: disconnect ? "disconnect" : "connect" }));
    try {
      if (disconnect) await plugins.disconnect(card.id);
      else {
        if (!pluginCardMatchesManifest(card, plugins.plugins.find(item => item.id === card.pluginId)))
          throw new Error("插件数据流已更新，请移除此卡片并从传感器列表重新添加。");
        await plugins.connect(card.pluginId, card.id, card.config);
      }
      resetSettings(card.id);
    } catch (cause) { showError(card.id, cause); }
    finally { setConnectionActions(current => ({ ...current, [card.id]: undefined })); }
  }
  async function cameraConnection(card: BrowserCameraWorkspaceCard, disconnect: boolean) {
    if (locked) return;
    setErrors((current) => ({ ...current, [card.id]: "" }));
    setConnectionActions(current => ({ ...current, [card.id]: disconnect ? "disconnect" : "connect" }));
    try {
      if (disconnect) await camera.disconnect(card.id);
      else {
        if (!card.deviceId || !camera.devices.some((item) => item.deviceId === card.deviceId))
          throw new Error("请先检测并选择摄像头；安卓手机请选择 DroidCam Video。");
        const result = await camera.connect(card.id, card.deviceId, card.quality);
        patchCard(card.id, { deviceId: result.deviceId });
      }
      resetSettings(card.id);
    } catch (cause) {
      showError(card.id, cause);
    } finally {
      setConnectionActions(current => ({ ...current, [card.id]: undefined }));
    }
  }
  async function scanCameras(id: string) {
    if (locked) return;
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      await camera.scan();
    } catch (cause) {
      showError(id, cause);
    }
  }
  /** Connect only the microphone explicitly selected in this card. */
  async function microphoneConnection(card: BrowserMicrophoneWorkspaceCard, disconnect: boolean) {
    if (locked || !microphone) return;
    setErrors(current => ({ ...current, [card.id]: "" }));
    setConnectionActions(current => ({ ...current, [card.id]: disconnect ? "disconnect" : "connect" }));
    try {
      if (disconnect) await microphone.disconnect(card.id);
      else {
        if (!card.deviceId || !microphone.devices.some(item => item.deviceId === card.deviceId))
          throw new Error("请先检测并选择麦克风；手机声音请选择 DroidCam Audio。");
        const result = await microphone.connect(card.id, card.deviceId);
        patchCard(card.id, { deviceId: result.deviceId });
      }
      resetSettings(card.id);
    } catch (cause) {
      showError(card.id, cause);
    } finally {
      setConnectionActions(current => ({ ...current, [card.id]: undefined }));
    }
  }
  /** Refresh microphone choices without changing an active capture source. */
  async function scanMicrophones(id: string) {
    if (locked || !microphone) return;
    setErrors(current => ({ ...current, [id]: "" }));
    try { await microphone.scan(); } catch (cause) { showError(id, cause); }
  }
  async function removeCard(card: WorkspaceCard) {
    if (locked || removing.includes(card.id)) return;
    setRemoving((current) => [...current, card.id]);
    try {
      await onRemove(card.id);
    } catch (cause) {
      showError(card.id, cause);
    } finally {
      setRemoving((current) => current.filter((id) => id !== card.id));
    }
  }

  function renderCard(card: WorkspaceCard) {
    const index = workspace.cards.findIndex(item => item.id === card.id);
              const pluginDefinition = card.source === "plugin" ? plugins?.plugins.find(item => item.id === card.pluginId) : undefined;
              const pluginCompatible = card.source !== "plugin" || pluginCardMatchesManifest(card, pluginDefinition);
              const pluginInstance = card.source === "plugin" ? plugins?.instances.find(item => item.instance_id === card.id) : undefined;
              const browserCamera = card.source === "camera" ? camera.connections[card.id] : undefined;
              const browserMicrophone = card.source === "microphone" ? microphones.connections[card.id] : undefined;
              const instance =
                card.source === "sdk"
                  ? sdk.instances.find((item) => item.instance_id === card.id)
                  : undefined;
              const streams = cardStreamIds(card);
              const pluginCameras = card.source === "plugin" ? card.streams.filter(stream => stream.kind === "camera") : [];
              const showAllCameras = card.source === "plugin" && pluginCameras.length > 1 && card.previewMode !== "single";
              const visiblePluginCameras = card.source === "plugin" ? pluginCameras.filter(stream => showAllCameras || stream.id === card.selectedStream) : [];
              const streamId = card.source === "plugin" ? `plugin-${card.id}-${card.selectedStream}` :
                card.source === "sdk" &&
                sdkHasImu(card.product) &&
                card.view === "imu"
                  ? streams[1]
                  : streams[0];
              const device = devices.find((item) => item.id === streamId);
              const isReady = readyIds.has(card.id);
              const active = card.source === "camera"
                ? browserCamera?.connected === true
                : card.source === "microphone"
                  ? browserMicrophone?.connected === true
                : card.source === "plugin" ? pluginInstance?.connected === true : !!(instance?.has_device || instance?.connected);
              const selectedPort = card.source === "sdk" ? (active ? instance?.path || card.path : card.path) : "";
              const portDetected = serialPorts.some((port) => port.path === selectedPort);
              const cardBusy =
                !!connectionActions[card.id] ||
                (card.source === "camera" ? camera.busyIds : card.source === "microphone" ? microphones.busyIds : card.source === "plugin" ? plugins?.busyIds ?? [] : sdk.busyIds).includes(card.id) ||
                !!instance?.connecting ||
                removing.includes(card.id);
              const definition =
                card.source === "camera"
                  ? { name: CAMERA_NAME }
                  : card.source === "microphone"
                    ? { name: MICROPHONE_NAME }
                  : card.source === "plugin" ? { name: card.name } : card.source === "sdk"
                  ? SDK_CATALOG.find((item) => item.product === card.product)
                  : SIMULATION_CATALOG.find(
                      (item) => item.id === card.deviceId,
                    );
              const name = sensorDisplayName(definition?.name ?? device?.name ?? "传感器");
              const gloveSide = card.source === "sdk" && card.product === "glove"
                ? (instance?.connected && instance.side ? instance.side : card.side) : undefined;
              const kind =
                card.source === "camera"
                  ? "camera"
                  : card.source === "microphone"
                    ? "audio"
                  : card.source === "plugin" ? card.streams.find(stream => stream.id === card.selectedStream)?.kind ?? "pressure" : card.source === "sdk"
                  ? "pressure"
                  : (SIMULATION_CATALOG.find(
                      (item) => item.id === card.deviceId,
                    )?.kind ?? "pressure");
              const Icon = kindIcons[kind];
              const cardError = errors[card.id] || browserCamera?.error || browserMicrophone?.error || instance?.error || pluginInstance?.error;
              // The catalog temporarily masks every panel without changing its saved open state.
              const configVisible = !catalogOpen && card.source !== "simulation" && (settingsOpen[card.id] ?? !isReady);
              const pendingLabel = connectionActions[card.id] === "disconnect" ? "断开中" : removing.includes(card.id) ? "移除中" : "连接中";
              const compactMicrophone = card.source === "microphone";
              const microphoneSettingsInDialog = compactMicrophone && (
                (!card.expanded && mediaLayout.metrics.audioHeight < (cardError ? 128 : 112)) ||
                (microphoneDialog?.id === card.id && microphoneDialog.mode === "settings")
              );
              const errorNotice = cardError ? (
                <div id={`connection-error-${card.id}`} className={`workspace-card-error${compactMicrophone ? " microphone-compact-error" : ""}`} role="alert" tabIndex={0}>
                  <AlertCircle size={15} aria-hidden="true" />
                  {compactMicrophone ? <button onClick={() => setMicrophoneDialog({ id: card.id, mode: "help" })}>
                    麦克风异常 · 查看详情
                  </button> : <span>{cardError}</span>}
                </div>
              ) : null;
              const disconnectButton = active && card.source !== "simulation" && (
                <button className="button secondary small workspace-disconnect" aria-label={`断开${name}`}
                  aria-describedby={cardError ? `connection-error-${card.id}` : undefined}
                  title={recording ? "请先停止采集，再断开设备" : "断开连接，保留卡片与连接配置"}
                  disabled={locked || cardBusy || (card.source === "sdk" && (!online || !sdk.info?.loaded)) ||
                    (card.source === "camera" && camera.scanning) ||
                    (card.source === "microphone" && (!microphone || microphones.scanning))}
                  onClick={() => {
                    if (card.source === "camera") void cameraConnection(card, true);
                    else if (card.source === "microphone") void microphoneConnection(card, true);
                    else if (card.source === "plugin") void pluginConnection(card, true);
                    else void connection(card, true);
                  }}>
                  {connectionActions[card.id] === "disconnect" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Unplug size={14} aria-hidden="true" />}
                  <span>{connectionActions[card.id] === "disconnect" ? "断开中" : "断开"}</span>
                </button>
              );
              const removeButton = <button className={cardContentFullscreen && !compactMicrophone ? "button secondary small workspace-remove" : "icon-button workspace-remove"}
                aria-label={`移除${name}展示卡片`} title={active ? "断开并移除" : "移除"}
                disabled={locked || cardBusy || (card.source === "sdk" && active && !online)} onClick={() => void removeCard(card)}>
                <X size={16} />{cardContentFullscreen && !compactMicrophone && <span>{active ? "断开并移除" : "移除卡片"}</span>}
              </button>;
              const microphoneControls = card.source === "microphone" ? (
                      <div className="workspace-connection workspace-microphone-connection">
                        <label className="workspace-microphone-device">
                          <span className="sr-only">音频输入</span>
                          <select aria-label="麦克风设备" value={card.deviceId}
                            disabled={locked || cardBusy || active || microphones.scanning || !online || !microphone}
                            onChange={event => {
                              setErrors(current => ({ ...current, [card.id]: "" }));
                              patchCard(card.id, { deviceId: event.target.value });
                            }}>
                            <option value="" disabled>{microphones.devices.length ? "请选择麦克风" : "先检测并授权麦克风"}</option>
                            {card.deviceId && !microphones.devices.some(item => item.deviceId === card.deviceId) && (
                              <option value={card.deviceId} disabled>{browserMicrophone?.label || "已保存设备不可用，请重新选择"}</option>
                            )}
                            {microphones.devices.map(item => <option key={item.deviceId} value={item.deviceId}>{item.label}</option>)}
                          </select>
                        </label>
                        <button className="button secondary small" aria-label="检测并授权麦克风"
                          title="刷新音频输入列表；尚未授权时请求麦克风访问"
                          disabled={locked || cardBusy || microphones.scanning || !online || !microphone}
                          onClick={() => void scanMicrophones(card.id)}>
                          <RefreshCw size={14} className={microphones.scanning ? "spin" : ""} />
                          <span>{microphones.scanning ? "检测中" : "检测"}</span>
                        </button>
                        <button className={`button small ${active ? "secondary" : "primary"}`}
                          disabled={locked || cardBusy || microphones.scanning || !microphone || (!online && !active) ||
                            (!active && (!card.deviceId || !microphones.devices.some(item => item.deviceId === card.deviceId)))}
                          onClick={() => void microphoneConnection(card, active)}
                          aria-label={`${active ? "断开" : "连接"}麦克风`}
                          aria-describedby={cardError ? microphoneDialog?.id === card.id && microphoneDialog.mode === "settings"
                            ? `microphone-dialog-error-${card.id}` : `connection-error-${card.id}` : undefined}>
                          {cardBusy ? <Loader2 size={14} className="spin" /> : active ? <Unplug size={14} /> : <Mic size={14} />}
                          <span>{cardBusy ? pendingLabel : active ? "断开" : "连接"}</span>
                        </button>
                      </div>
              ) : null;
              const viewTabs = card.source === "sdk" && sdkHasImu(card.product) && isReady && (
                <div className="workspace-view-tabs" role="group" aria-label={card.product === "insole" ? "鞋垫展示数据" : "手套展示数据"}>
                  <button aria-pressed={card.view !== "imu"} onClick={() => patchCard(card.id, { view: "primary" })}>{card.product === "insole" ? "压力点位" : "手部压力"}</button>
                  <button aria-pressed={card.view === "imu"} onClick={() => patchCard(card.id, { view: "imu" })}>IMU 原始字节</button>
                  <span>两路数据同时录制</span>
                </div>
              );
              const sdkFooter = card.source === "sdk" && <footer className="workspace-sdk-footer">
                <span>{isReady ? `${(instance?.frames ?? 0).toLocaleString()} 帧已接收` : instance?.connected && !instance.error ? "等待有效数据 · 暂不能开始录制" : "连接配置保存在当前工作台"}</span>
                <span>{instance?.version ? `SDK ${instance.version}` : "传感器 SDK"}</span>
              </footer>;
              return (
                <article
                  key={card.id}
                  className={`workspace-sensor-card independent-card ${card.source === "plugin" && card.streams.length > 1 ? "workspace-plugin-stream-card" : ""} ${card.source === "camera" || card.source === "microphone" ? "bounded-media-card" : "independent-size-card"} ${card.source === "camera" ? "media-camera-card" : card.source === "microphone" ? "media-audio-card" : ""} ${card.expanded ? "card-expanded" : ""} ${configVisible ? "configuration-open" : ""} ${sensorPositions.draggingId === card.id ? "card-is-moving" : ""}`}
                  style={card.expanded ? { width: Math.max(1, viewport.width - 1), height: Math.max(1, viewport.height - 1) } : card.source === "camera" || card.source === "microphone" ? { width: "100%", height: card.source === "camera" ? mediaLayout.metrics.cameraHeight : mediaLayout.metrics.audioHeight } : {
                    ...sensorSizes.style(card.id), gridColumn: (sensorGrid.placements[card.id]?.columnSpan ?? 1) > 1
                      ? `${sensorGrid.placements[card.id]?.column} / span ${sensorGrid.placements[card.id]?.columnSpan}` : sensorGrid.placements[card.id]?.column,
                    gridRow: `${sensorGrid.placements[card.id]?.row} / span ${sensorGrid.placements[card.id]?.rowSpan}`,
                  }}
                  hidden={!shownIds.has(card.id)}
                  aria-label={`${name}展示卡片`}
                  data-instance-id={card.id}
                  aria-busy={cardBusy}
                >
                  <header className={`workspace-card-heading ${(card.source === "sdk" || card.source === "plugin") && sensorPositions.enabled ? "card-move-header" : ""}`}
                    {...((card.source === "sdk" || card.source === "plugin") && sensorPositions.enabled ? sensorPositions.headerProps(card.id) : {})}>
                    {(card.source === "sdk" || card.source === "plugin") && sensorPositions.enabled && <CardMoveHandle positions={sensorPositions} cardId={card.id}
                      label={`${name}${gloveSide === "left" ? "左手" : gloveSide === "right" ? "右手" : card.source === "sdk" && card.product === "insole" ? card.side === "right" ? "右脚" : "左脚" : ""}`} />}
                    <span className={`catalog-item-icon modality-${kind}`}>
                      <Icon size={19} />
                    </span>
                    <div className={`workspace-card-title ${cardContentFullscreen ? "workspace-card-compact" : ""}`}>
                      <h3 className="workspace-card-label">{name}</h3>
                      {gloveSide && <span className="workspace-card-side" aria-label={gloveSide === "left" ? "左手" : "右手"}>{gloveSide === "left" ? "左" : "右"}</span>}
                      <p className="workspace-card-state">
                        <span
                          className={`status-dot ${cardError && !cardBusy ? "connection-error" : isReady ? "green" : "gray"}`}
                        />
                        <span className={cardError && !cardBusy ? "workspace-error-status" : undefined}>
                          {!online
                            ? "采集服务离线"
                            : cardBusy
                              ? `${pendingLabel}…`
                              : cardError
                                ? active ? "操作失败" : "连接失败"
                              : isReady
                                ? "已连接"
                                : instance?.connected && !instance.error
                                  ? "等待首帧"
                                : "等待连接"}
                        </span>
                        <span className="workspace-source-tag">
                          {card.source === "simulation"
                            ? "模拟"
                            : card.source === "camera"
                              ? "真实视频"
                              : card.source === "microphone"
                                ? "真实音频"
                              : card.source === "plugin" ? "SDK 插件" : card.product === "mock"
                              ? "SDK 模拟"
                              : "SDK 硬件"}
                        </span>
                      </p>
                    </div>
                    <span className="workspace-card-index mono">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {!cardContentFullscreen && disconnectButton}
                    {card.source !== "simulation" && <button className={cardContentFullscreen ? "button secondary small workspace-settings-toggle" : "icon-button workspace-settings-toggle"}
                      data-settings-for={card.id} aria-label={microphoneSettingsInDialog ? "打开麦克风连接设置" : `${configVisible ? "收起" : "展开"}${name}${cardContentFullscreen ? "设置" : "连接设置"}`}
                      aria-expanded={microphoneSettingsInDialog ? microphoneDialog?.id === card.id && microphoneDialog.mode === "settings" : configVisible}
                      aria-haspopup={microphoneSettingsInDialog ? "dialog" : undefined}
                      aria-controls={microphoneSettingsInDialog ? `microphone-dialog-${card.id}` : `connection-${card.id}`} title={cardContentFullscreen ? "设置" : "连接设置"}
                      onClick={() => microphoneSettingsInDialog ? setMicrophoneDialog({ id: card.id, mode: "settings" }) : setSettingsOpen(current => ({ ...current,
                        ...(cardContentFullscreen ? Object.fromEntries(workspace.cards.filter(item => item.id !== card.id && readyIds.has(item.id)).map(item => [item.id, false])) : {}),
                        [card.id]: !configVisible }))}>
                      <Settings2 size={15} />{cardContentFullscreen && <span>设置</span>}
                    </button>}
                    <button
                      className="icon-button"
                      aria-label={`${card.expanded ? "缩小" : "放大"}${name}展示卡片`}
                      onClick={() => {
                        for (const other of workspace.cards) if (other.id !== card.id && other.expanded) patchCard(other.id, { expanded: false });
                        patchCard(card.id, { expanded: !card.expanded });
                      }}
                    >
                      {card.expanded ? (
                        <Minimize2 size={15} />
                      ) : (
                        <Maximize2 size={15} />
                      )}
                    </button>
                    {compactMicrophone && <button className="icon-button microphone-help-toggle"
                      title="麦克风接入帮助" aria-label="麦克风接入帮助" aria-haspopup="dialog"
                      onClick={() => setMicrophoneDialog({ id: card.id, mode: "help" })}>
                      <CircleHelp size={16} />
                    </button>}
                    {(!cardContentFullscreen || compactMicrophone) && removeButton}
                  </header>
                  <div id={`connection-${card.id}`} className={`workspace-config-panel${compactMicrophone ? " microphone-compact-config" : ""}`} hidden={!configVisible || microphoneSettingsInDialog}
                    ref={element => { if (element) configurationPanels.current.set(card.id, element); else configurationPanels.current.delete(card.id); }}>
                  {cardContentFullscreen && !compactMicrophone && <div className="workspace-device-actions">{disconnectButton}{removeButton}</div>}
                  {configVisible && !compactMicrophone && errorNotice}
                  {cardError && card.source === "sdk" && card.product !== "mock" && selectedPort &&
                    <SerialPortOwnership port={selectedPort} online={online} recording={recording}
                      disabled={busy || cardBusy} onReleased={sdk.refresh} />}
                  {compactMicrophone && !microphoneSettingsInDialog && microphoneControls}
                  {configVisible && compactMicrophone && !microphoneSettingsInDialog && errorNotice}
                  {card.source === "plugin" && <>
                    <div className="workspace-connection plugin-connection">
                      {!pluginDefinition && <p role="status">此插件尚未安装，请在 SDK 接入 Agent 中安装对应版本。</p>}
                      {pluginDefinition && !pluginCompatible && <p role="status">插件数据流已更新，请移除此卡片并从传感器列表重新添加，确保采集全部数据流。</p>}
                      {(pluginDefinition?.config_fields ?? []).map(field => <label key={field.key}>
                        <span>{field.label}{field.required ? " *" : ""}</span>
                        {field.type === "boolean" ? <input type="checkbox" checked={card.config[field.key] === true}
                          disabled={active || locked || cardBusy} onChange={event => patchCard(card.id, { config: { ...card.config, [field.key]: event.target.checked } })} /> :
                          <input type={field.type === "number" ? "number" : "text"} value={String(card.config[field.key] ?? "")} required={field.required}
                            disabled={active || locked || cardBusy} onChange={event => patchCard(card.id, { config: { ...card.config,
                              [field.key]: field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value } })} />}
                      </label>)}
                      <button className={`button small ${active ? "secondary" : "primary"}`} disabled={locked || cardBusy || !online || !pluginDefinition || (!active && !pluginCompatible)}
                        onClick={() => void pluginConnection(card, active)}>{cardBusy ? <Loader2 size={14} className="spin" /> : active ? <Unplug size={14} /> : <Cable size={14} />}{active ? "断开" : "连接"}</button>
                    </div>
                    <p className="plugin-validation-note">{pluginDefinition ? `插件 v${pluginDefinition.version} · ` : ""}接收数据后可预览并随统一采集保存。</p>
                    {pluginDefinition?.description && <p className="plugin-validation-note">{pluginDefinition.description}</p>}
                  </>}
                  {card.source === "camera" && (
                    <>
                      <div className="workspace-connection workspace-camera-connection">
                        <label className="workspace-camera-device">
                          <span>系统摄像头</span>
                          <select
                            aria-label={`${name}设备`}
                            value={card.deviceId}
                            disabled={locked || cardBusy || active || camera.scanning || !online}
                            onChange={(event) => {
                              setErrors((current) => ({ ...current, [card.id]: "" }));
                              patchCard(card.id, { deviceId: event.target.value });
                            }}
                          >
                            <option value="" disabled>{camera.devices.length ? "请选择摄像头" : "先检测并授权摄像头"}</option>
                            {card.deviceId && !camera.devices.some((item) => item.deviceId === card.deviceId) && (
                              <option value={card.deviceId} disabled>{browserCamera?.label || "已保存设备不可用，请重新选择"}</option>
                            )}
                            {camera.devices.map((item) => (
                              <option key={item.deviceId} value={item.deviceId}>{item.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="workspace-camera-quality">
                          <span>目标画质</span>
                          <select
                            aria-label={`${name}目标画质`}
                            value={card.quality}
                            disabled={locked || cardBusy || active || !online}
                            onChange={(event) => patchCard(card.id, { quality: event.target.value as "720p" | "1080p" })}
                          >
                            <option value="720p">720p · 30 fps</option>
                            <option value="1080p">1080p · 30 fps</option>
                          </select>
                        </label>
                        <button
                          className="button secondary small camera-scan"
                          aria-label={`检测并授权${name}`}
                          title="刷新摄像头列表；尚未授权时请求摄像头访问"
                          disabled={locked || cardBusy || camera.scanning || !online}
                          onClick={() => void scanCameras(card.id)}
                        >
                          <RefreshCw size={14} className={camera.scanning ? "spin" : ""} />
                          <span>{camera.scanning ? "检测中" : "检测"}</span>
                        </button>
                        <button
                          className={`button small ${active ? "secondary" : "primary"}`}
                          disabled={locked || cardBusy || camera.scanning || (!online && !active) ||
                            (!active && (!card.deviceId || !camera.devices.some((item) => item.deviceId === card.deviceId)))}
                          onClick={() => void cameraConnection(card, active)}
                          aria-label={`${active ? "断开" : "连接"}${name}`}
                          aria-describedby={cardError ? `connection-error-${card.id}` : undefined}
                        >
                          {cardBusy ? <Loader2 size={14} className="spin" /> : active ? <Unplug size={14} /> : <Video size={14} />}
                          <span>{cardBusy ? pendingLabel : active ? "断开" : cardError ? "重试连接" : "连接"}</span>
                        </button>
                      </div>
                      {!active && camera.devices.length > 0 && (
                        <p className="workspace-camera-detected" role="status">
                          已检测到 {camera.devices.length} 个摄像头：{camera.devices.map((item) => item.label).join("、")}。
                          {camera.devices.some((item) => /droidcam/i.test(item.label))
                            ? " 手机画面请选择 DroidCam Video 后连接。"
                            : " 请在上方选择要连接的设备。"}
                        </p>
                      )}
                      <details className="workspace-camera-guide">
                        <summary>安卓手机如何作为摄像头？</summary>
                        <div>
                          <p>Windows 已识别的手机摄像头、USB 摄像头都可以在上方选择。</p>
                          <ol>
                            <li>在安卓手机和这台 Windows 10 电脑安装 <a href="https://droidcam.app/windows/" target="_blank" rel="noreferrer">DroidCam 官方应用与客户端</a>。</li>
                            <li>优先使用 USB 连接，也可让手机和电脑处于同一 Wi-Fi。按 <a href="https://droidcam.app/help/" target="_blank" rel="noreferrer">官方连接指引</a>，先确认电脑客户端已有画面。</li>
                            <li>点击「检测」，允许摄像头访问，选择「DroidCam Video」并连接。</li>
                          </ol>
                          <p>如果 Chrome 提示「重新加载此页面」，请先刷新当前页面使权限生效；若已连接 ToDesk Camera，请先断开，再选择 DroidCam Video。</p>
                          <p>若手机 USB 选项本身支持「网络摄像头」，也可以直接启用后检测。手机配对和客户端连接需在系统中完成。</p>
                        </div>
                      </details>
                    </>
                  )}
                  {card.source === "sdk" && (
                    <div className="workspace-connection">
                      {card.product !== "mock" && (
                        <label className="workspace-port">
                          <span>串口</span>
                          <select
                            aria-label={`${name}串口`}
                            value={selectedPort}
                            disabled={locked || cardBusy || active || !online || !sdkLoaded}
                            onChange={(event) => {
                              patchCard(card.id, { path: event.target.value });
                              setErrors((current) => ({ ...current, [card.id]: "" }));
                            }}
                          >
                            <option value="" disabled>
                              {!online ? "采集服务离线" : !sdkLoaded ? "等待 SDK 加载" : sdk.scanning ? "正在扫描串口…" : serialPorts.length ? "请选择串口" : "未发现串口，请刷新"}
                            </option>
                            {selectedPort && !portDetected && (
                              <option value={selectedPort} disabled>
                                {selectedPort}（{active ? "已连接" : "未检测到，请刷新"}）
                              </option>
                            )}
                            {serialPorts.map((port) => (
                              <option key={port.path} value={port.path}>
                                {port.path}{(port.friendlyName || port.manufacturer) && (port.friendlyName || port.manufacturer) !== port.path
                                  ? ` · ${port.friendlyName || port.manufacturer}` : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {sdkHasImu(card.product) && (
                        <label className="workspace-side">
                          <span>{card.product === "insole" ? "左右脚" : "左右手"}</span>
                          <select
                            aria-label={`${name}${card.product === "insole" ? "左右脚" : "左右手"}`}
                            value={card.side}
                            disabled={locked || cardBusy || active || !online}
                            onChange={(event) =>
                              patchCard(card.id, {
                                side: event.target.value as "left" | "right",
                              })
                            }
                          >
                            <option value="left">{card.product === "insole" ? "左脚" : "左手"}</option>
                            <option value="right">{card.product === "insole" ? "右脚" : "右手"}</option>
                          </select>
                        </label>
                      )}
                      {card.product === "glove" && <label className="workspace-protocol">
                        <span>手套协议</span>
                        <select aria-label={`${name}手套协议`}
                          value={active && (instance?.protocol === "segmented" || instance?.protocol === "full-packet") ? instance.protocol : card.gloveProtocol ?? "segmented"}
                          disabled={locked || cardBusy || active || !online}
                          onChange={event => patchCard(card.id, { gloveProtocol: event.target.value as GloveProtocol })}>
                          <option value="segmented">分包（0.4+）</option>
                          <option value="full-packet">整包（兼容旧设备）</option>
                        </select>
                      </label>}
                      {card.product === "insole" && (<>
                        <label className="workspace-protocol">
                          <span>数据格式</span>
                          <select aria-label={`${name}数据格式`} value={card.protocol ?? "12bit"}
                            disabled={locked || cardBusy || active || !online}
                            onChange={(event) => patchCard(card.id, { protocol: event.target.value as InsoleProtocol })}>
                            <option value="12bit">12 bit · 整帧</option>
                            <option value="8bit">8 bit · 分包</option>
                          </select>
                        </label>
                        <label className="workspace-baud-rate">
                          <span>波特率</span>
                          <select aria-label={`${name}波特率`} value={card.baudRate ?? 921600}
                            disabled={locked || cardBusy || active || !online}
                            onChange={(event) => patchCard(card.id, { baudRate: Number(event.target.value) as InsoleBaudRate })}>
                            {INSOLE_BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                          </select>
                        </label>
                      </>)}
                      {card.product === "mock" && (
                        <span className="workspace-mock-note">
                          32 × 32 模拟矩阵
                        </span>
                      )}
                      {card.product !== "mock" && (
                        <button
                          className="icon-button"
                          aria-label={`刷新${name}串口`}
                          title="刷新串口"
                          disabled={
                            locked || cardBusy || sdk.scanning || !online || !sdkLoaded
                          }
                          onClick={() =>
                            void sdk
                              .scanPorts()
                              .catch((cause) => showError(card.id, cause))
                          }
                        >
                          <RefreshCw
                            size={15}
                            className={sdk.scanning ? "spin" : ""}
                          />
                        </button>
                      )}
                      <button
                        className={`button small ${active ? "secondary" : "primary"}`}
                        disabled={
                          locked ||
                          cardBusy ||
                          !online ||
                          !sdk.info?.loaded ||
                          (!active &&
                            card.product !== "mock" &&
                            (!portDetected || sdk.scanning))
                        }
                        onClick={() => void connection(card, active)}
                        aria-label={`${active ? "断开" : "连接"}${name}`}
                        aria-describedby={cardError ? `connection-error-${card.id}` : undefined}
                      >
                        <span className="button-icon">
                          {cardBusy ? (
                            <Loader2 size={14} className="spin" />
                          ) : active ? (
                            <Unplug size={14} />
                          ) : (
                            <Cable size={14} />
                          )}
                        </span>
                        <span>
                          {cardBusy ? pendingLabel : active ? "断开" : cardError ? "重试连接" : "连接"}
                        </span>
                      </button>
                    </div>
                  )}
                  {cardContentFullscreen && viewTabs}
                  {cardContentFullscreen && <div className="workspace-display-settings-slot" ref={displaySettingsSlot(card.id)} />}
                  {cardContentFullscreen && sdkFooter}
                  </div>
                  {!configVisible && errorNotice}
                  {!cardContentFullscreen && viewTabs}
                  {card.source === "plugin" && card.streams.length > 1 && <div className="workspace-view-tabs" role="group" aria-label="插件数据流">
                    {pluginCameras.length > 1 && <button aria-pressed={showAllCameras}
                      onClick={() => patchCard(card.id, { previewMode: "cameras" })}>{pluginCameras.length === 2 ? "双目同屏" : "多路同屏"}</button>}
                    {card.streams.map(stream => <button key={stream.id} aria-pressed={!showAllCameras && card.selectedStream === stream.id}
                      onClick={() => patchCard(card.id, { selectedStream: stream.id, previewMode: "single" })}>{stream.name}</button>)}<span>所有数据流同时录制</span>
                  </div>}
                  <div className="workspace-visual">
                    {card.source === "plugin" && visiblePluginCameras.length > 0 ? (
                      <PluginCameraFeeds cardId={card.id} streams={visiblePluginCameras} devices={devices}
                        active={active} online={online} previewConnected={previewConnected} paused={previewPaused} visible={shownIds.has(card.id)}
                        cardContentFullscreen={cardContentFullscreen} layout={card.cameraLayout} split={card.cameraSplit}
                        onLayoutChange={patch => patchCard(card.id, patch)} />
                    ) : card.source === "microphone" && browserMicrophone?.connected ? (
                      <MicrophonePreview connection={browserMicrophone} paused={previewPaused}
                        visible={shownIds.has(card.id)} recording={recording}
                        recordingError={recording && microphones.error ? microphones.error : undefined} />
                    ) : card.source === "camera" && browserCamera?.connected ? (
                      <CameraPreview
                        connection={browserCamera}
                        paused={previewPaused}
                        recording={recording}
                        recordingError={recording && camera.error ? camera.error : undefined}
                      />
                    ) : isReady && device ? (
                      <LivePreview
                        key={device.id}
                        device={device}
                        enabled
                        visible={shownIds.has(card.id)}
                        paused={previewPaused}
                        connected={
                          online && previewConnected && device.connected
                        }
                        embedded
                        cardContentFullscreen={cardContentFullscreen}
                        settingsContainer={cardContentFullscreen ? displaySettingsContainers[card.id] ?? null : undefined}
                        summaryContainer={cardContentFullscreen && card.source === "sdk" && device.kind === "pressure" ? summaryContainers[card.id] ?? null : undefined}
                      />
                    ) : (
                      <div className="workspace-card-placeholder">
                        <span className="placeholder-grid" />
                        {card.source === "camera" ? <Video size={34} strokeWidth={1.3} /> : card.source === "microphone" ? <Mic size={34} strokeWidth={1.3} /> : <Cable size={31} strokeWidth={1.3} />}
                        <h4>
                          {!online
                            ? "等待采集服务"
                            : cardBusy
                              ? "正在连接传感器"
                              : instance?.connected && !instance.error
                                ? "串口已连接，等待首个有效数据帧"
                              : card.source === "camera"
                                ? "连接摄像头，开始查看实时画面"
                                : card.source === "microphone"
                                  ? "连接麦克风，查看声音波形"
                                : "等待传感器连接"}
                        </h4>
                        {card.source !== "microphone" && <p>
                          {card.source === "camera"
                            ? camera.devices.length
                              ? "在卡片上方选择系统摄像头并连接。手机请先通过 DroidCam 接入电脑。"
                              : "尚未检测到可用摄像头。点击「检测」并允许访问；手机请先完成上方接入指引。"
                            : card.source === "sdk"
                            ? instance?.connected && !instance.error
                              ? "收到有效数据后显示预览并允许录制；请确认设备型号、数据格式及波特率与固件一致。"
                              : card.product === "mock"
                              ? "点击上方连接，查看 SDK 模拟数据。"
                              : "在卡片上方选择串口并连接，数据将在这里呈现。"
                            : card.source === "plugin" ? "填写插件连接参数并连接设备，收到数据后显示预览。" : "本地采集服务就绪后显示模拟信号。"}
                        </p>}
                      </div>
                    )}
                  </div>
                  {card.source === "sdk" && (
                    <SdkReceiveHealthStatus instance={instance} online={online} serviceError={sdk.serviceError}>
                      {cardContentFullscreen && <span className="sdk-health-preview-summary mono" ref={summarySlot(card.id)} />}
                    </SdkReceiveHealthStatus>
                  )}
                  {!cardContentFullscreen && sdkFooter}
                  {!card.expanded && card.source !== "camera" && card.source !== "microphone" && <CardResizeControls sizes={sensorSizes} cardId={card.id} allowFullHeight label={`${name}${gloveSide === "left" ? "左" : gloveSide === "right" ? "右" : ""}`} />}
                  {compactMicrophone && microphoneDialog?.id === card.id && <MicrophoneDialog
                    id={`microphone-dialog-${card.id}`}
                    title={microphoneDialog.mode === "settings" ? "麦克风连接设置" : "麦克风接入帮助"}
                    onClose={() => setMicrophoneDialog(null)}>
                    {microphoneDialog.mode === "settings" && microphoneControls}
                    {cardError && <p id={`microphone-dialog-error-${card.id}`} className="microphone-dialog-error" role="alert">{cardError}</p>}
                    <ol className="microphone-help-steps">
                      <li>电脑拾音：选择电脑麦克风，点击「连接」。</li>
                      <li>手机拾音：在 DroidCam Client 的手机源属性中启用 Enable Audio，并允许手机应用使用麦克风。</li>
                      <li>点击「检测」，声音选择 DroidCam Audio；画面在摄像头卡片中选择 DroidCam Video，同一台手机可同时提供声音和画面。</li>
                    </ol>
                    <p className="microphone-help-format">单声道 · PCM16 WAV · {browserMicrophone?.sampleRate ? browserMicrophone.sampleRate.toLocaleString() + " Hz" : "采样率在连接后显示"}。音频随统一开始、停止采集单独保存。</p>
                  </MicrophoneDialog>}
                </article>
              );

  }

  return (
    <div ref={workspaceRef} className={`sensor-workspace monitor-workspace ${cardContentFullscreen ? "card-content-workspace" : ""} ${focused ? "monitor-focused" : ""} ${catalogOpen ? "catalog-is-open" : ""}`}
      style={{ "--monitor-height": `${boardHeight}px` } as CSSProperties}>
      {catalogOpen && (
        <button
          className="catalog-backdrop"
          aria-label="关闭传感器列表"
          onClick={() => setCatalogOpen(false)}
        />
      )}
      <aside
        ref={catalogRef}
        id="sensor-catalog"
        className={`sensor-catalog ${catalogOpen ? "catalog-open" : ""}`}
        aria-label="传感器列表"
        role={catalogOpen ? "dialog" : undefined}
        aria-modal={catalogOpen || undefined}
      >
        <div className="catalog-heading">
          <div>
            <h2>传感器列表</h2>
            <p>添加到展示区后连接</p>
          </div>
          <button
            className="icon-button catalog-close"
            aria-label="收起传感器列表"
            onClick={() => setCatalogOpen(false)}
          >
            <X size={17} />
          </button>
        </div>
        <label className="catalog-search">
          <Search size={14} />
          <input
            aria-label="搜索传感器"
            placeholder="搜索传感器"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {search &&
          ![{ name: CAMERA_NAME }, { name: MICROPHONE_NAME }, ...(plugins?.plugins ?? []), ...SDK_CATALOG.filter(item => item.product !== "mock")].some((item) =>
            item.name.toLowerCase().includes(search.toLowerCase()),
          ) && (
            <p className="catalog-empty">没有匹配的传感器，试试其它名称。</p>
          )}
        <div className="catalog-group">
          <h3>摄像设备</h3>
          {CAMERA_NAME.toLowerCase().includes(search.toLowerCase()) && (
            <button
              className="catalog-item"
              disabled={locked || workspace.cards.length >= MAX_WORKSPACE_CARDS}
              onClick={() => addCard(createCameraCard())}
              aria-label={`添加${CAMERA_NAME}`}
            >
              <span className="catalog-item-icon modality-camera"><Video size={19} /></span>
              <span className="catalog-item-text">
                <strong>{CAMERA_NAME}</strong>
                <small>手机 / USB 摄像头 · 真实画面</small>
              </span>
              <Plus size={15} className="catalog-add" />
            </button>
          )}
        </div>
        <div className="catalog-group">
          <h3>音频设备</h3>
          {MICROPHONE_NAME.includes(search.toLowerCase()) && (
            <button className="catalog-item"
              disabled={locked || !microphone || !onAddMicrophone || workspace.cards.length >= MAX_WORKSPACE_CARDS}
              onClick={() => addCard(createMicrophoneCard())} aria-label={`添加${MICROPHONE_NAME}`}>
              <span className="catalog-item-icon modality-audio"><Mic size={19} /></span>
              <span className="catalog-item-text"><strong>{MICROPHONE_NAME}</strong><small>手机 / 电脑 · 单声道 WAV</small></span>
              <Plus size={15} className="catalog-add" />
            </button>
          )}
        </div>
        <div className="catalog-group">
          <h3>传感器设备</h3>
          {SDK_CATALOG.filter((item) =>
            item.product !== "mock" && item.name.toLowerCase().includes(search.toLowerCase()),
          ).map((item) => (
            <button
              key={item.product}
              className="catalog-item"
              disabled={locked || workspace.cards.length >= MAX_WORKSPACE_CARDS}
              onClick={() => addCard(createSdkCard(item.product))}
              aria-label={`添加${item.name}`}
            >
              <span className="catalog-item-icon modality-pressure">
                {item.product === "glove" ? (
                  <Activity size={19} />
                ) : (
                  <ScanLine size={19} />
                )}
              </span>
              <span className="catalog-item-text">
                <strong>{item.name}</strong>
                <small>{item.detail}</small>
              </span>
              <Plus size={15} className="catalog-add" />
            </button>
          ))}
        </div>
        <div className="catalog-group">
          <h3>已安装 SDK 插件</h3>
          {(plugins?.plugins ?? []).filter(item => item.name.toLowerCase().includes(search.toLowerCase())).map(plugin => <button key={plugin.id}
            className="catalog-item" disabled={locked || !onAddPlugin || workspace.cards.length >= MAX_WORKSPACE_CARDS}
            onClick={() => addCard(createPluginCard(plugin))} aria-label={`添加${plugin.name}`}>
            <span className="catalog-item-icon"><Cable size={19} /></span><span className="catalog-item-text"><strong>{plugin.name}</strong><small>v{plugin.version} · {plugin.streams.length} 路数据</small></span><Plus size={15} />
          </button>)}
          {!plugins?.plugins.length && <p className="catalog-empty">导入 SDK 并安装适配器后，将出现在这里。</p>}
          {plugins?.error && <p className="catalog-empty" role="status">{plugins.error}</p>}
          {onOpenAgent && <button className="button secondary small" onClick={() => { setCatalogOpen(false); onOpenAgent(); }}>SDK 接入 Agent</button>}
        </div>
        <div className="catalog-foot">
          <Monitor size={16} />
          <p>
            每张卡片独立连接。
            <br />
            展示区内的传感器一起录制。
          </p>
        </div>
      </aside>

      <section className="display-workspace" aria-label="传感器展示区域" inert={catalogOpen}>
        <div className="display-toolbar">
          <div className="display-toolbar-title">
            <button
              className="button secondary small catalog-toggle"
              aria-controls="sensor-catalog"
              aria-expanded={catalogOpen}
              onClick={event => catalogOpen ? setCatalogOpen(false) : openCatalog(event.currentTarget)}
            >
              <Plus size={15} />
              <span>添加传感器</span>
            </button>
            <h2>实时监看</h2>
            <span className="display-count mono">{`${readyCount} / ${workspace.cards.length} 就绪`}</span>
          </div>
          <div className="display-toolbar-actions">
            {workspace.cards.length > 0 && <button className="button secondary small" onClick={() => { mediaLayout.reset(); sensorCards.forEach(card => sensorSizes.reset(card.id)); setResizingSensorId(null); setPage(0); }} title="恢复一屏布局和默认音视频比例">恢复卡片大小</button>}
            {focused && <span className={`monitor-recording-state ${recording ? "is-recording" : ""}`}>{recording ? "正在录制" : "预览中"}</span>}
            {focused && recording && onStopRecording ? <button className="button danger small" disabled={busy} onClick={onStopRecording}><Square size={13} />停止并保存</button> : focused && <button className="button secondary small" onClick={() => setFocused(false)}>返回录制控制</button>}
            <span className="display-refresh mono">{previewRate} Hz 预览</span>
            <div
              className="display-layout-buttons"
              role="group"
              aria-label="展示布局"
            >
              <button
                aria-label="网格布局"
                aria-pressed={workspace.layout === "grid"}
                onClick={() => onLayout("grid")}
              >
                <Grid2X2 size={15} />
              </button>
              <button
                aria-label="纵向布局"
                aria-pressed={workspace.layout === "stack"}
                onClick={() => onLayout("stack")}
              >
                <LayoutList size={15} />
              </button>
            </div>
            <button
              className="icon-button"
              aria-label={previewPaused ? "恢复预览" : "暂停预览"}
              title={previewPaused ? "恢复预览" : "暂停预览"}
              aria-pressed={previewPaused}
              onClick={onTogglePreview}
            >
              {previewPaused ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button className="button secondary small monitor-focus-toggle" aria-label={focused ? "退出专注模式" : "专注模式"} aria-pressed={focused} onClick={() => setFocused(!focused)} title={focused ? "退出专注模式（Escape）" : "展开监看区域"}>
              {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}<span>{focused ? "退出专注" : "专注模式"}</span>
            </button>
          </div>
        </div>
        {workspace.cards.length === 0 ? (
          <div className="workspace-empty">
            <span className="workspace-empty-icon">
              <Monitor size={36} strokeWidth={1.2} />
            </span>
            <h3>把传感器放进你的展示区</h3>
            <p>
              点击“添加传感器”，在卡片内连接设备。
              <br />
              画面与采集状态会显示在这里。
            </p>
            <button
              className="button secondary catalog-toggle"
              onClick={event => openCatalog(event.currentTarget)}
            >
              <Plus size={16} />
              <span>添加传感器</span>
            </button>
            <div className="workspace-empty-path">
              <span>添加传感器</span>
              <ChevronRight size={14} />
              <span>连接设备</span>
              <ChevronRight size={14} />
              <span>开始采集</span>
            </div>
          </div>
        ) : (
          <div ref={gridRef} style={mediaLayout.style} className={`media-sensor-layout independent-card-layout bounded-board-layout ${mediaLayout.metrics.stacked ? "media-stacked" : ""} ${mediaCards.length ? "has-media-rail" : ""} ${sensorCards.length ? "has-sensor-grid" : ""} ${expandedCard ? mediaFocused ? "media-is-focused" : "sensor-is-focused" : ""}`}>
            <aside className={`media-rail ${mediaCards.some(card => card.source === "camera") ? "has-camera" : "audio-only"}`} aria-label="影像与声音" hidden={!mediaCards.length || !!expandedCard && !mediaFocused}>
              {mediaCards.filter(card => card.source === "camera").map(renderCard)}
              {mediaLayout.metrics.splitHeight && <div className="media-resize-handle media-resize-height" {...mediaLayout.separatorProps("camera")}><span>↕ 麦克风高度</span></div>}
              {mediaCards.filter(card => card.source === "microphone").map(renderCard)}
            </aside>
            {mediaLayout.metrics.splitWidth && <div className="media-resize-handle media-resize-width" {...mediaLayout.separatorProps("width")} />}
            <div ref={sensorGridRef} className={`workspace-card-grid layout-${workspace.layout} ${expandedCard ? "monitor-single-view" : ""} ${sensorCards.length === 1 ? "single-card" : ""}`}
              hidden={!sensorCards.length || mediaFocused}
              style={{ "--monitor-columns": expandedCard ? 1 : layout.columns, "--monitor-rows": expandedCard ? 1 : layout.rows } as CSSProperties}>
              {sensorCards.map(renderCard)}
              {sensorPositions.indicatorStyle && <div className={`card-drop-target ${sensorPositions.swapTargetId ? "card-swap-target" : ""}`} style={sensorPositions.indicatorStyle} aria-hidden="true"><span>{sensorPositions.indicatorLabel}</span></div>}
            </div>
          </div>
        )}
        <span className="card-move-announcement" role="status" aria-live="polite">{sensorPositions.announcement}</span>
        {workspace.cards.length > 0 && <div className="monitor-pagination">
          {expandedCard ? <button className="button secondary small" onClick={() => { for (const card of workspace.cards) if (card.expanded) patchCard(card.id, { expanded: false }); }}><Grid2X2 size={14} />返回全部传感器</button> : <>
            <span>{mediaCards.length > 0 && `影像与声音 ${mediaCards.length} 路 · `}{sensorCards.length > 0 ? `${pageRange.start + 1}–${pageRange.end} / ${sensorCards.length} 路传感器` : "全部媒体已展示"}<span className="monitor-page-note"> · 未显示的设备继续采集</span></span>
            {pageRange.pages > 1 && <div role="group" aria-label="监看分页"><button className="icon-button" aria-label="上一屏传感器" disabled={pageRange.page === 0} onClick={() => { setResizingSensorId(null); setPage(pageRange.page - 1); }}><ChevronLeft size={15} /></button><span>{pageRange.page + 1} / {pageRange.pages}</span><button className="icon-button" aria-label="下一屏传感器" disabled={pageRange.page + 1 === pageRange.pages} onClick={() => { setResizingSensorId(null); setPage(pageRange.page + 1); }}><ChevronRight size={15} /></button></div>}
          </>}
          {hiddenIssues.length > 0 && <button className="button secondary small monitor-hidden-issue" aria-label="查看未显示传感器异常" onClick={() => {
            for (const card of workspace.cards) if (card.expanded && card.id !== hiddenIssues[0].id) patchCard(card.id, { expanded: false });
            patchCard(hiddenIssues[0].id, { expanded: true });
          }}>{hiddenIssues.length} 路未显示设备异常 · 查看</button>}
        </div>}
        {sdk.error && (
          <p className="workspace-service-message" role="status">
            {sdk.error}
          </p>
        )}
        {camera.error && workspace.cards.some((card) => card.source === "camera") && (
          <p className="workspace-service-message" role="status">{camera.error}</p>
        )}
        {microphones.error && workspace.cards.some(card => card.source === "microphone") && (
          <p className="workspace-service-message" role="status">{microphones.error}</p>
        )}
      </section>
    </div>
  );
}
