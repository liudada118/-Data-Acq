import type { Device, DeviceKind, Profile } from "./types";
import type { PluginConfig, SensorPlugin } from "./plugin-types";
import { INSOLE_BAUD_RATES, sdkHasImu } from "./sdk-types";
import type { GloveProtocol, InsoleBaudRate, InsoleProtocol, SdkInstanceInfo, SdkProduct } from "./sdk-types";

export const WORKSPACE_STORAGE_KEY = "synapse-node.workspace.v1";
export const MAX_WORKSPACE_CARDS = 16;
export const SIMULATION_CATALOG: {
  id: string;
  name: string;
  kind: DeviceKind;
  detail: string;
}[] = [
  {
    id: "sim-camera",
    name: "模拟摄像头",
    kind: "camera",
    detail: "RGB · 160 × 90 · 15 fps",
  },
  {
    id: "sim-audio",
    name: "模拟麦克风",
    kind: "audio",
    detail: "单声道 · 48 kHz",
  },
  {
    id: "sim-pressure",
    name: "模拟压力阵列",
    kind: "pressure",
    detail: "16 × 16 · 100 Hz",
  },
  {
    id: "sim-imu",
    name: "模拟六轴 IMU",
    kind: "imu",
    detail: "加速度 / 角速度 · 200 Hz",
  },
];
export const SDK_CATALOG: {
  product: SdkProduct;
  name: string;
  detail: string;
}[] = [
  {
    product: "hand-pad",
    name: "压力阵列",
    detail: "32 × 32 · 串口连接",
  },
  {
    product: "glove",
    name: "触觉手套",
    detail: "分包 / 整包 · 压力 + 原始 IMU",
  },
  {
    product: "body",
    name: "人体全身",
    detail: "10 分区 · 400 点 · 1024 原始通道",
  },
  {
    product: "insole",
    name: "鞋垫 A 版",
    detail: "112 真实点 + IMU · 左 / 右脚",
  },
];

export interface SimWorkspaceCard {
  id: string;
  source: "simulation";
  deviceId: string;
  expanded: boolean;
}
export interface SdkWorkspaceCard {
  id: string;
  source: "sdk";
  product: SdkProduct;
  path: string;
  side: "left" | "right";
  protocol?: InsoleProtocol;
  gloveProtocol?: GloveProtocol;
  baudRate?: InsoleBaudRate;
  view: "primary" | "imu";
  expanded: boolean;
}
export interface BrowserCameraWorkspaceCard {
  id: string;
  source: "camera";
  deviceId: string;
  quality: "720p" | "1080p";
  expanded: boolean;
}
export interface BrowserMicrophoneWorkspaceCard {
  id: string;
  source: "microphone";
  deviceId: string;
  expanded: boolean;
}
export interface PluginWorkspaceCard {
  id: string; source: "plugin"; pluginId: string; name: string;
  streams: { id: string; name: string; kind: DeviceKind }[];
  config: PluginConfig; selectedStream: string; expanded: boolean;
  previewMode?: "single" | "cameras";
  cameraLayout?: "auto" | "horizontal" | "vertical";
  cameraSplit?: number;
}
export type WorkspaceCard =
  | SimWorkspaceCard
  | SdkWorkspaceCard
  | BrowserCameraWorkspaceCard
  | BrowserMicrophoneWorkspaceCard
  | PluginWorkspaceCard;
export interface WorkspaceState {
  version: 1;
  cards: WorkspaceCard[];
  layout: "grid" | "stack";
}
const SAFE_INSTANCE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SAFE_CAMERA_INSTANCE = /^c-[a-z0-9][a-z0-9_-]{0,45}$/;
const SAFE_MICROPHONE_INSTANCE = /^m-[a-z0-9][a-z0-9_-]{0,45}$/;
const PRODUCTS = new Set(SDK_CATALOG.map((item) => item.product));
const SIM_IDS = new Set(SIMULATION_CATALOG.map((item) => item.id));

/** Simulation adapters remain available to developer fixtures, never to live workspace selection. */
export function isRealWorkspaceCard(card: WorkspaceCard): boolean {
  return card.source === "camera" || card.source === "microphone" || card.source === "plugin" ||
    (card.source === "sdk" && PRODUCTS.has(card.product));
}
export function isRealCaptureDevice(device: Device): boolean {
  return !device.id.startsWith("sim-") &&
    !["simulated", "simulation", "sdk-mock", "mock"].includes(device.mode) &&
    (device as Device & { simulated?: boolean }).simulated !== true && device.metadata?.product !== "mock";
}
const isMockInstance = (instance: SdkInstanceInfo) => instance.product === "mock" || instance.mode === "sdk-mock";

export function createSimCard(deviceId: string): SimWorkspaceCard {
  if (!SIM_IDS.has(deviceId)) throw new Error("未知的模拟传感器");
  return { id: deviceId, source: "simulation", deviceId, expanded: false };
}
export function createSdkCard(
  product: SdkProduct,
  id = `s-${crypto.randomUUID().slice(0, 12)}`,
): SdkWorkspaceCard {
  if (!PRODUCTS.has(product) || !SAFE_INSTANCE.test(id))
    throw new Error("无效的传感器实例");
  return {
    id,
    source: "sdk",
    product,
    path: "",
    side: "left",
    ...(product === "insole" ? { protocol: "12bit" as const, baudRate: 921600 as const } : {}),
    ...(product === "glove" ? { gloveProtocol: "segmented" as const } : {}),
    view: "primary",
    expanded: false,
  };
}
export function createCameraCard(
  id = `c-${crypto.randomUUID().slice(0, 12)}`,
): BrowserCameraWorkspaceCard {
  if (!SAFE_CAMERA_INSTANCE.test(id)) throw new Error("无效的摄像头实例");
  return { id, source: "camera", deviceId: "", quality: "720p", expanded: false };
}
/** Create an independent, initially disconnected browser microphone card. */
export function createMicrophoneCard(
  id = `m-${crypto.randomUUID().slice(0, 12)}`,
): BrowserMicrophoneWorkspaceCard {
  if (!SAFE_MICROPHONE_INSTANCE.test(id)) throw new Error("无效的麦克风实例");
  return { id, source: "microphone", deviceId: "", expanded: false };
}
export function cardStreamIds(card: WorkspaceCard): string[] {
  if (!isRealWorkspaceCard(card) || card.source === "simulation") return [];
  if (card.source === "camera") return [`camera-${card.id}`];
  if (card.source === "microphone") return [`microphone-${card.id}`];
  if (card.source === "plugin") return card.streams.map(stream => `plugin-${card.id}-${stream.id}`);
  const prefix = card.id === "default" ? "sdk" : `sdk-${card.id}`;
  return sdkHasImu(card.product)
    ? [`${prefix}-pressure`, `${prefix}-imu-raw`]
    : [`${prefix}-pressure`];
}
export function createPluginCard(plugin: SensorPlugin, id = `p-${crypto.randomUUID().slice(0, 12)}`): PluginWorkspaceCard {
  return { id, source: "plugin", pluginId: plugin.id, name: plugin.name,
    streams: plugin.streams.map(stream => ({ id: stream.id, name: stream.name, kind: stream.kind })),
    config: Object.fromEntries((plugin.config_fields ?? []).filter(field => field.default !== undefined).map(field => [field.key, field.default!])),
    selectedStream: plugin.streams[0]?.id ?? "", expanded: false,
    previewMode: plugin.streams.filter(stream => stream.kind === "camera").length > 1 ? "cameras" : "single",
    cameraLayout: "auto", cameraSplit: 0.5 };
}
export function pluginCardMatchesManifest(card: PluginWorkspaceCard, plugin: SensorPlugin | undefined): boolean {
  return !!plugin && plugin.id === card.pluginId && card.streams.length === plugin.streams.length &&
    card.streams.every(stream => plugin.streams.some(current => current.id === stream.id && current.kind === stream.kind));
}
export function workspaceStreamIds(cards: WorkspaceCard[]): string[] {
  return [...new Set(cards.flatMap(cardStreamIds))];
}
export function parseWorkspace(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<WorkspaceState>;
  if (stored.version !== 1 || !Array.isArray(stored.cards)) return null;
  const cards: WorkspaceCard[] = [];
  const seen = new Set<string>();
  for (const candidate of stored.cards.slice(0, MAX_WORKSPACE_CARDS)) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.id !== "string" ||
      seen.has(candidate.id)
    )
      continue;
    if (candidate.source === "plugin" && SAFE_INSTANCE.test(candidate.id) &&
      typeof candidate.pluginId === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate.pluginId) &&
      typeof candidate.name === "string" && Array.isArray(candidate.streams) && candidate.streams.length > 0 && candidate.streams.length <= 8 &&
      candidate.streams.every(stream => !!stream && typeof stream.id === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(stream.id) &&
        typeof stream.name === "string" && ["camera", "audio", "pressure", "imu"].includes(stream.kind)) &&
      candidate.config && typeof candidate.config === "object" && !Array.isArray(candidate.config)) {
      const config = Object.fromEntries(Object.entries(candidate.config).filter(([key, value]) =>
        /^[a-z][a-z0-9_-]{0,31}$/.test(key) && !["constructor", "prototype", "__proto__"].includes(key) &&
        ["string", "number", "boolean"].includes(typeof value) && (typeof value !== "number" || Number.isFinite(value))));
      cards.push({ id: candidate.id, source: "plugin", pluginId: candidate.pluginId, name: candidate.name.slice(0, 120),
        streams: candidate.streams.map(stream => ({ id: stream.id, name: stream.name.slice(0, 120), kind: stream.kind })),
        config, expanded: candidate.expanded === true,
        previewMode: candidate.previewMode === "single" || candidate.streams.filter(stream => stream.kind === "camera").length < 2 ? "single" : "cameras",
        cameraLayout: candidate.cameraLayout === "horizontal" || candidate.cameraLayout === "vertical" ? candidate.cameraLayout : "auto",
        cameraSplit: typeof candidate.cameraSplit === "number" && Number.isFinite(candidate.cameraSplit) ? Math.max(0.2, Math.min(0.8, candidate.cameraSplit)) : 0.5,
        selectedStream: candidate.streams.some(stream => stream.id === candidate.selectedStream) ? candidate.selectedStream : candidate.streams[0].id });
    } else if (
      candidate.source === "microphone" &&
      SAFE_MICROPHONE_INSTANCE.test(candidate.id) &&
      typeof candidate.deviceId === "string" &&
      candidate.deviceId.length <= 1024
    ) {
      cards.push({
        ...createMicrophoneCard(candidate.id),
        deviceId: candidate.deviceId,
        expanded: candidate.expanded === true,
      });
    } else if (
      candidate.source === "camera" &&
      SAFE_CAMERA_INSTANCE.test(candidate.id) &&
      typeof candidate.deviceId === "string" &&
      candidate.deviceId.length <= 1024 &&
      (candidate.quality === "720p" || candidate.quality === "1080p")
    ) {
      cards.push({
        ...createCameraCard(candidate.id),
        deviceId: candidate.deviceId,
        quality: candidate.quality,
        expanded: candidate.expanded === true,
      });
    } else if (
      candidate.source === "sdk" &&
      SAFE_INSTANCE.test(candidate.id) &&
      PRODUCTS.has(candidate.product)
    ) {
      if (candidate.product === "insole" &&
        ((candidate.protocol !== undefined && !["12bit", "8bit"].includes(candidate.protocol)) ||
          (candidate.baudRate !== undefined && !INSOLE_BAUD_RATES.includes(candidate.baudRate)))) continue;
      if (candidate.product === "glove" && candidate.gloveProtocol !== undefined &&
        !["segmented", "full-packet"].includes(candidate.gloveProtocol)) continue;
      cards.push({
        ...createSdkCard(candidate.product, candidate.id),
        path:
          typeof candidate.path === "string"
            ? candidate.path.slice(0, 240)
            : "",
        side: candidate.side === "right" ? "right" : "left",
        ...(candidate.product === "insole" ? {
          protocol: candidate.protocol ?? "12bit", baudRate: candidate.baudRate ?? 921600,
        } : {}),
        ...(candidate.product === "glove" ? { gloveProtocol: candidate.gloveProtocol ?? "segmented" } : {}),
        view:
          sdkHasImu(candidate.product) && candidate.view === "imu"
            ? "imu"
            : "primary",
        expanded: candidate.expanded === true,
      });
    } else continue;
    seen.add(candidate.id);
  }
  return {
    version: 1,
    cards,
    layout: stored.layout === "stack" ? "stack" : "grid",
  };
}

/** Convert saved/active stream selections into cards without opening any device. */
export function cardsFromDeviceIds(
  ids: readonly string[],
  current: WorkspaceCard[] = [],
  instances: SdkInstanceInfo[] = [],
): WorkspaceCard[] {
  const selected = new Set(ids);
  const result: WorkspaceCard[] = [];
  const seen = new Set<string>();
  for (const id of selected) {
    if (id.startsWith("sim-")) continue;
    const pluginCard = current.find(card => card.source === "plugin" && cardStreamIds(card).includes(id));
    if (pluginCard) { if (!seen.has(pluginCard.id)) { result.push(pluginCard); seen.add(pluginCard.id); } continue; }
    const microphoneMatch = /^microphone-(m-[a-z0-9][a-z0-9_-]{0,45})$/.exec(id);
    if (microphoneMatch) {
      const instanceId = microphoneMatch[1];
      if (seen.has(instanceId)) continue;
      seen.add(instanceId);
      const existing = current.find(
        (card) => card.source === "microphone" && card.id === instanceId,
      );
      result.push(existing ?? createMicrophoneCard(instanceId));
      continue;
    }
    const cameraMatch = /^camera-(c-[a-z0-9][a-z0-9_-]{0,45})$/.exec(id);
    if (cameraMatch) {
      const instanceId = cameraMatch[1];
      if (seen.has(instanceId)) continue;
      seen.add(instanceId);
      const existing = current.find(
        (card) => card.source === "camera" && card.id === instanceId,
      );
      result.push(existing ?? createCameraCard(instanceId));
      continue;
    }
    const match =
      /^sdk(?:-([a-z0-9][a-z0-9_-]{0,47}))?-(pressure|imu-raw)$/.exec(id);
    if (!match) continue;
    const instanceId = match[1] ?? "default";
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const existing = current.find(
      (card): card is SdkWorkspaceCard =>
        card.source === "sdk" && card.id === instanceId,
    );
    const known = instances.find(instance => instance.instance_id === instanceId);
    if (known && isMockInstance(known)) {
      if (existing && isRealWorkspaceCard(existing)) result.push(existing);
      continue;
    }
    if (existing?.product === "mock" && !known) continue;
    const rawId =
      instanceId === "default" ? "sdk-imu-raw" : `sdk-${instanceId}-imu-raw`;
    const product = known?.product ?? existing?.product ?? (selected.has(rawId) ? "glove" : "hand-pad");
    if (!PRODUCTS.has(product)) continue;
    result.push(
      existing ? { ...existing, product } : createSdkCard(product, instanceId),
    );
  }
  return result.slice(0, MAX_WORKSPACE_CARDS);
}

/** Adopt already-open legacy connections on first migration; never connect ports. */
export function mergeConnectedCards(
  cards: WorkspaceCard[],
  instances: SdkInstanceInfo[],
): WorkspaceCard[] {
  const result = cards.filter(isRealWorkspaceCard);
  for (const instance of instances) {
    if (
      (!instance.has_device && !instance.connected) ||
      !instance.product ||
      isMockInstance(instance) ||
      !PRODUCTS.has(instance.product) ||
      !SAFE_INSTANCE.test(instance.instance_id) ||
      result.some((card) => card.id === instance.instance_id && card.source !== "sdk")
    )
      continue;
    const index = result.findIndex(
      (card) => card.source === "sdk" && card.id === instance.instance_id,
    );
    if (index < 0 && result.length >= MAX_WORKSPACE_CARDS) continue;
    const existing =
      index >= 0
        ? (result[index] as SdkWorkspaceCard)
        : createSdkCard(instance.product, instance.instance_id);
    const updated: SdkWorkspaceCard = {
      ...existing,
      product: instance.product,
      path: instance.path ?? existing.path,
      side:
        instance.side === "left" || instance.side === "right"
          ? instance.side
          : existing.side,
      ...(instance.product === "insole" ? {
        protocol: instance.protocol === "8bit" ? "8bit" : instance.protocol === "12bit" ? "12bit" : existing.protocol ?? "12bit",
        baudRate: instance.baudRate && INSOLE_BAUD_RATES.includes(instance.baudRate) ? instance.baudRate : existing.baudRate ?? 921600,
      } : {}),
      ...(instance.product === "glove" ? {
        gloveProtocol: instance.protocol === "full-packet" || instance.protocol === "segmented"
          ? instance.protocol : existing.gloveProtocol ?? "segmented",
      } : {}),
    };
    if (index < 0) result.push(updated);
    else result[index] = updated;
  }
  return result;
}

/** Keep user profile metadata while removing retired capture choices and recomputing stream IDs. */
export function normalizeCaptureProfile<T extends Profile & { workspace?: unknown }>(
  profile: T,
  instances?: SdkInstanceInfo[],
): (T & { workspace?: WorkspaceState }) | null {
  const stored = parseWorkspace(profile.workspace);
  // A current connection can reuse a saved instance ID with a different product.
  // Explicit saved hardware configuration is authoritative; consult runtime
  // products only while migrating selections that had no workspace metadata.
  const cards = stored?.cards ?? cardsFromDeviceIds(profile.device_ids, [], instances);
  if (!cards.length) return null;
  const normalized = { ...profile, device_ids: workspaceStreamIds(cards) };
  const unresolvedLegacySdk = !stored && cards.some(card => card.source === "sdk" &&
    !instances?.some(instance => instance.instance_id === card.id && instance.product &&
      PRODUCTS.has(instance.product) && !isMockInstance(instance)));
  if (!stored && (instances === undefined || unresolvedLegacySdk)) {
    delete normalized.workspace;
    return normalized as T & { workspace?: WorkspaceState };
  }
  return { ...normalized, workspace: { version: 1, cards, layout: stored?.layout ?? "grid" } };
}

export function isCardReady(
  card: WorkspaceCard,
  devices: Device[],
  instances: SdkInstanceInfo[],
  online: boolean,
): boolean {
  if (
    !online ||
    !isRealWorkspaceCard(card) ||
    !cardStreamIds(card).every((id) =>
      devices.some((device) => device.id === id && device.connected && isRealCaptureDevice(device)),
    )
  )
    return false;
  if (card.source !== "sdk") return true;
  const instance = instances.find((item) => item.instance_id === card.id);
  return (
    instance?.connected === true &&
    !isMockInstance(instance) &&
    instance.ready !== false &&
    ((card.product !== "body" && card.product !== "insole") || instance.ready === true) &&
    !instance.connecting &&
    !instance.error &&
    instance.product === card.product
  );
}
