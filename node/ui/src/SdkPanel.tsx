import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, Loader2, RefreshCw, Unplug } from "lucide-react";
import { request } from "./api";
import { sdkConnectionErrorMessage } from "./sdk-feedback";
import { INSOLE_BAUD_RATES, SDK_PRODUCTS, sdkHasImu } from "./sdk-types";
import type { GloveProtocol, InsoleBaudRate, InsoleProtocol, SdkInfo, SdkProduct, SerialPort } from "./sdk-types";

export function SdkPanel({
  recording,
  online,
  onDevicesChanged,
}: {
  recording: boolean;
  online: boolean;
  onDevicesChanged: () => Promise<void>;
}) {
  const [info, setInfo] = useState<SdkInfo | null>(null);
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [product, setProduct] = useState<SdkProduct>("hand-pad");
  const [path, setPath] = useState("");
  const [side, setSide] = useState<"left" | "right">("left");
  const [gloveProtocol, setGloveProtocol] = useState<GloveProtocol>("segmented");
  const [protocol, setProtocol] = useState<InsoleProtocol>("12bit");
  const [baudRate, setBaudRate] = useState<InsoleBaudRate>(921600);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [serviceError, setServiceError] = useState("");
  const previousConnection = useRef<string | null>(null);

  const refreshInfo = useCallback(async () => {
    const next = await request<SdkInfo>("/api/sdk/info");
    setInfo(next);
    const connectionKey = JSON.stringify([next.connected, next.ready, next.device_id, next.product, next.path, next.side, next.protocol, next.baudRate]);
    if (previousConnection.current !== connectionKey) {
      previousConnection.current = connectionKey;
      if (next.connected) {
        if (next.product && SDK_PRODUCTS.includes(next.product))
          setProduct(next.product);
        if (next.path) setPath(next.path);
        if (next.side === "left" || next.side === "right") setSide(next.side);
        if (next.product === "glove" && (next.protocol === "segmented" || next.protocol === "full-packet")) setGloveProtocol(next.protocol);
        if (next.protocol === "12bit" || next.protocol === "8bit") setProtocol(next.protocol);
        if (next.baudRate && INSOLE_BAUD_RATES.includes(next.baudRate)) setBaudRate(next.baudRate);
      }
      await onDevicesChanged();
    }
    return next;
  }, [onDevicesChanged]);

  useEffect(() => {
    if (!online) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refreshInfo();
        if (!stopped) setServiceError("");
      } catch (cause) {
        if (!stopped)
          setServiceError(cause instanceof Error ? cause.message : "无法读取 SDK 状态");
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refreshInfo, online]);

  async function scanPorts() {
    if (!online || busy || recording || scanning) return;
    setScanning(true);
    setError("");
    try {
      const response = await request<{ ports: SerialPort[] }>(
        "/api/sdk/ports", undefined, AbortSignal.timeout(15000),
      );
      setPorts(Array.isArray(response.ports)
        ? response.ports.filter((port) => !!port && typeof port.path === "string")
        : []);
      await refreshInfo();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "串口扫描失败");
    } finally {
      setScanning(false);
    }
  }

  async function changeConnection() {
    if (!online || busy || recording) return;
    setBusy(true);
    setError("");
    try {
      if (info?.connected || info?.has_device) {
        await request("/api/sdk/disconnect", {}, AbortSignal.timeout(15000));
      } else {
        await request(
          "/api/sdk/connect",
          {
            product,
            ...(product === "mock" ? { mode: "mock" } : { path: path.trim() }),
            ...(sdkHasImu(product) ? { side } : {}),
            ...(product === "glove" ? { gloveProtocol } : {}),
            ...(product === "insole" ? { protocol, baudRate } : {}),
          },
          AbortSignal.timeout(60000),
        );
      }
      await refreshInfo();
      await onDevicesChanged();
    } catch (cause) {
      setError(sdkConnectionErrorMessage(cause, path));
      void refreshInfo().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  const disabled = !online || busy || !!info?.connecting || recording || !info?.loaded;
  const canDisconnect = !!(info?.connected || info?.has_device);
  const activeMock = info?.product === "mock";
  return (
    <section className="panel sdk-panel" aria-label="连接传感器">
      <div className="panel-heading">
        <div>
          <h2>连接传感器</h2>
          <p>选择设备型号和连接参数；连接后在下方勾选本次要采集的传感器。</p>
        </div>
        <span className={`state-badge ${online && info?.connected ? "complete" : ""}`}>
          <span>{!online
            ? "采集服务离线"
            : info?.connecting
            ? "正在连接 SDK…"
            : info?.connected
            ? info.ready === false
              ? "已连接 · 等待首帧"
              : activeMock
              ? "SDK 模拟运行"
              : "SDK 已连接"
            : info?.loaded
              ? "已加载 · 未连接"
              : "等待 SDK"}</span>
        </span>
      </div>
      <div className="sdk-body">
        {!online && (
          <div className="sdk-note" role="status">
            <Unplug size={19} />
            <p>暂时无法连接传感器。请启动或重启本地采集服务；恢复后这里会自动更新。</p>
          </div>
        )}
        {online && !info?.loaded && (
          <div className="sdk-note">
            <Cable size={19} />
            <p>SDK 尚未加载。请在 node 目录安装 shroom-sdk 后重启服务；现有模拟采集仍可使用。</p>
          </div>
        )}
        {info?.loaded && (
          <div className="sdk-summary">
            <span>{`Shroom SDK ${info.version || "已加载"}${info.source === "npm" ? " · npm" : ""}`}</span>
            <span>{`许可证：${info.license_configured ? "已配置" : "未配置"}`}</span>
          </div>
        )}
        <div className="sdk-fields">
          <label className="field-label" htmlFor="sdk-product">
            <span>设备型号</span>
            <div className="select-wrap">
              <select
                id="sdk-product"
                value={product}
                onChange={(event) => setProduct(event.target.value as SdkProduct)}
                disabled={disabled || canDisconnect}
              >
                <option value="hand-pad">压力阵列 / Hand Pad</option>
                <option value="glove">触觉手套</option>
                <option value="body">人体全身 / 10 分区</option>
                <option value="insole">鞋垫 A 版 / 112 点</option>
                <option value="mock">SDK 模拟（不连接硬件）</option>
              </select>
            </div>
          </label>
          {product !== "mock" && (
            <label className="field-label sdk-port-field" htmlFor="sdk-port">
              <span>串口</span>
              <input
                id="sdk-port"
                className="text-input mono"
                list="sdk-serial-ports"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="选择或输入端口，例如 COM3"
                disabled={disabled || canDisconnect}
              />
              <datalist id="sdk-serial-ports">
                {ports.map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.friendlyName ?? port.manufacturer ?? port.path}
                  </option>
                ))}
              </datalist>
            </label>
          )}
          {sdkHasImu(product) && (
            <label className="field-label" htmlFor="sdk-side">
              <span>{product === "insole" ? "左右脚" : "左右手"}</span>
              <div className="select-wrap">
                <select
                  id="sdk-side"
                  value={side}
                  onChange={(event) => setSide(event.target.value as "left" | "right")}
                  disabled={disabled || canDisconnect}
                >
                  <option value="left">{product === "insole" ? "左脚" : "左手"}</option>
                  <option value="right">{product === "insole" ? "右脚" : "右手"}</option>
                </select>
              </div>
            </label>
          )}
          {product === "glove" && (
            <label className="field-label" htmlFor="sdk-glove-protocol">
              <span>手套协议</span>
              <div className="select-wrap">
                <select id="sdk-glove-protocol" value={gloveProtocol} disabled={disabled || canDisconnect}
                  onChange={(event) => setGloveProtocol(event.target.value as GloveProtocol)}>
                  <option value="segmented">分包（0.4+）</option>
                  <option value="full-packet">整包（兼容旧设备）</option>
                </select>
              </div>
            </label>
          )}
          {product === "insole" && (<>
            <label className="field-label" htmlFor="sdk-protocol">
              <span>数据格式</span>
              <div className="select-wrap">
                <select id="sdk-protocol" value={protocol} disabled={disabled || canDisconnect}
                  onChange={(event) => setProtocol(event.target.value as InsoleProtocol)}>
                  <option value="12bit">12 bit · 整帧</option>
                  <option value="8bit">8 bit · 分包</option>
                </select>
              </div>
            </label>
            <label className="field-label" htmlFor="sdk-baud-rate">
              <span>波特率</span>
              <div className="select-wrap">
                <select id="sdk-baud-rate" value={baudRate} disabled={disabled || canDisconnect}
                  onChange={(event) => setBaudRate(Number(event.target.value) as InsoleBaudRate)}>
                  {INSOLE_BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                </select>
              </div>
            </label>
          </>)}
        </div>
        {product === "insole" && <p className="sdk-hint">脚侧、数据格式和波特率需与设备固件一致；12 bit 原始 ADC 完整保留。</p>}
        <div className="sdk-actions">
          <button
            className="button secondary"
            onClick={() => void scanPorts()}
            disabled={disabled || scanning || canDisconnect}
          >
            <RefreshCw size={15} className={scanning ? "spin" : ""} />
            <span>{scanning ? "扫描中…" : "刷新串口"}</span>
          </button>
          <button
            className="button primary"
            onClick={() => void changeConnection()}
            disabled={disabled || (!canDisconnect && product !== "mock" && !path.trim())}
          >
            <span className="button-icon" aria-hidden="true">
              {busy || info?.connecting ? <Loader2 size={15} className="spin" /> : canDisconnect ? <Unplug size={15} /> : <Cable size={15} />}
            </span>
            <span>{busy || info?.connecting ? "处理中…" : canDisconnect ? "断开传感器" : product === "mock" ? "启动 SDK 模拟" : "连接传感器"}</span>
          </button>
          <span className="sdk-hint">
            {recording ? "录制期间无法更改 SDK 连接。" : "连接后需在设备列表勾选，才会加入采集组合。"}
          </span>
        </div>
        {online && info?.connected && (
          <div className="sdk-status-line" role="status">
            <span>{activeMock ? "SDK 模拟数据" : info.path || info.product || "SDK 数据源"}</span>
            <span>{`收到 ${(info.frames ?? 0).toLocaleString()} 帧`}</span>
            {(info.frames ?? 0) === 0 && <span>等待设备数据；连接成功不代表已收到有效数据。</span>}
          </div>
        )}
        {(error || serviceError || info?.error) && (
          <p className="sdk-error" role="alert"><span>{error || serviceError || info?.error}</span></p>
        )}
      </div>
    </section>
  );
}
