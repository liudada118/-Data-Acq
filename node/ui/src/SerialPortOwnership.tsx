import { useEffect, useRef, useState } from "react";
import { Loader2, Search, Unlock } from "lucide-react";
import { request } from "./api";

export interface SerialPortOwner {
  id: string;
  kind: "internal" | "external";
  name: string;
  pid?: number;
  instance_id?: string;
  executable?: string;
  can_release: boolean;
  release_reason?: string;
  release_token?: string;
}

interface Inspection {
  port: string;
  owners: SerialPortOwner[];
  complete: boolean;
  reason?: string;
}

interface Props {
  port: string;
  online: boolean;
  recording: boolean;
  disabled?: boolean;
  onReleased: () => Promise<void>;
}

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : "请求失败，请重试。";
const samePort = (left: string, right: string) => left.trim().toUpperCase() === right.trim().toUpperCase();
const releasable = (owner: SerialPortOwner) => owner.can_release === true &&
  typeof owner.release_token === "string" && owner.release_token.length > 0 &&
  (owner.kind === "internal" || (Number.isInteger(owner.pid) && owner.pid! > 0));

/** Ownership is queried on demand; release credentials exist only for this mounted port view. */
export function SerialPortOwnership({ port, online, recording, disabled = false, onReleased }: Props) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState<"inspect" | "release" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentPort = useRef(port);
  currentPort.current = port;

  useEffect(() => {
    generation.current++;
    setInspection(null); setBusy(null); setError(""); setSuccess(""); setConfirmId(null);
    return () => {
      generation.current++;
      operation.current?.abort();
      operation.current = null;
    };
  }, [port]);

  const releaseBlocked = !online || recording || disabled;
  const currentInspection = inspection && samePort(inspection.port, port) ? inspection : null;
  const blockedReason = !online ? "采集服务离线，恢复连接后才能释放串口。"
    : recording ? "录制期间不能释放串口，请先停止录制。"
      : disabled ? "设备正在处理其他操作，请完成后再释放串口。" : "";

  async function inspect() {
    if (!online || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const run = generation.current;
    const isCurrent = () => generation.current === run && currentPort.current === port;
    setBusy("inspect"); setInspection(null); setConfirmId(null); setSuccess("");
    try {
      const result = await request<Inspection>("/api/sdk/port/inspect", { port },
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
      if (!isCurrent()) return;
      if (!result || typeof result.port !== "string" || !samePort(result.port, port) || !Array.isArray(result.owners) ||
        result.owners.some(owner => !owner || typeof owner.id !== "string" || typeof owner.name !== "string" ||
          (owner.kind !== "internal" && owner.kind !== "external"))) {
        throw new Error("未收到有效的串口占用信息，请重新查询。");
      }
      setInspection(result); setError("");
    } catch (cause) {
      if (isCurrent()) setError(`查询占用程序失败：${messageOf(cause)}`);
    } finally {
      if (operation.current === controller) operation.current = null;
      if (isCurrent()) setBusy(null);
    }
  }

  async function release(owner: SerialPortOwner) {
    if (releaseBlocked || operation.current || confirmId !== owner.id || !releasable(owner) ||
      !currentInspection?.owners.includes(owner)) return;
    const controller = new AbortController();
    operation.current = controller;
    const run = generation.current;
    const isCurrent = () => generation.current === run && currentPort.current === port;
    let released = false;
    setBusy("release"); setSuccess("");
    try {
      const result = await request<{ released: boolean; port: string; message: string }>("/api/sdk/port/release",
        { port, release_token: owner.release_token, confirm: true },
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
      if (!isCurrent()) return;
      if (result?.released !== true || typeof result.port !== "string" || !samePort(result.port, port))
        throw new Error("尚未确认串口释放结果，请重新查询占用情况。");
      released = true;
      setInspection(null); setConfirmId(null); setError("");
      setSuccess(`${result.message || "串口已释放。"} 请重新连接传感器。`);
      await onReleased();
    } catch (cause) {
      if (isCurrent()) {
        // A timeout may have followed a successful server action. Require a fresh inspection before another release.
        setInspection(null); setConfirmId(null);
        setError(released ? `串口已释放，但连接状态刷新失败：${messageOf(cause)}`
          : `释放串口失败：${messageOf(cause)} 请重新查询占用情况后重试。`);
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (isCurrent()) setBusy(null);
    }
  }

  return <section className="serial-port-ownership" aria-label={`${port}占用程序`}>
    <div className="serial-owner-toolbar">
      <button type="button" className="button secondary small" disabled={!online || busy !== null} onClick={() => void inspect()}>
        {busy === "inspect" ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
        <span>{busy === "inspect" ? "正在查询占用程序" : currentInspection ? "重新查询占用程序" : "查看占用程序"}</span>
      </button>
      <span className="mono">{port}</span>
    </div>
    {!online && <p className="serial-owner-note">采集服务离线，暂时无法查询占用程序。</p>}
    {error && <p className="serial-owner-error" role="alert">{error}</p>}
    {success && <p className="serial-owner-success" role="status">{success}</p>}
    {currentInspection && <>
      {currentInspection.owners.length === 0 && <p className="serial-owner-note">
        {currentInspection.complete ? "未发现可确认的占用程序。若连接仍失败，请检查设备连接或重新检测串口。" : "暂时无法确认占用程序。"}
      </p>}
      {(currentInspection.reason || !currentInspection.complete) && <p className="serial-owner-note">
        {currentInspection.reason || "检测尚未完整，可能还有未识别的占用程序。"}
      </p>}
      <ul className="serial-owner-list">
        {currentInspection.owners.map(owner => <li key={owner.id}>
          <div className="serial-owner-name"><strong>{owner.name}</strong><span>{owner.kind === "internal" ? "本工作站连接" : "外部程序"}</span></div>
          {owner.pid !== undefined && <p className="serial-owner-note mono">PID {owner.pid}</p>}
          {owner.executable && <p className="serial-owner-executable">{owner.executable}</p>}
          {!releasable(owner) ? <p className="serial-owner-note">{owner.release_reason || "暂不能安全释放，请重新查询或手动关闭对应程序后重试。"}</p>
            : confirmId === owner.id ? <div className="serial-owner-confirm" role="group" aria-label={`确认释放${owner.name}`}>
              <p>{owner.kind === "internal"
                ? `将断开本工作站的「${owner.name}」连接，释放 ${port}。`
                : `将结束「${owner.name}」程序（PID ${owner.pid}），未保存数据可能丢失。`}</p>
              <div>
                <button type="button" className="button secondary small" disabled={busy !== null} onClick={() => setConfirmId(null)}>取消</button>
                <button type="button" className="button small serial-owner-confirm-release" disabled={releaseBlocked || busy !== null} onClick={() => void release(owner)}>
                  {busy === "release" && <Loader2 size={14} className="spin" />}
                  {busy === "release" ? "正在释放串口" : owner.kind === "internal" ? "断开连接并释放" : "结束程序并释放"}
                </button>
              </div>
            </div> : <button type="button" className="button secondary small" disabled={releaseBlocked || busy !== null}
              onClick={() => setConfirmId(owner.id)}><Unlock size={14} />释放串口</button>}
        </li>)}
      </ul>
      {currentInspection.owners.some(releasable) && blockedReason && <p className="serial-owner-note">{blockedReason}</p>}
    </>}
  </section>;
}
