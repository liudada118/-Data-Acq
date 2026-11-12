import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./api";
import { sdkConnectionErrorMessage } from "./sdk-feedback";
import type { SdkConnectionInput, SdkInfo, SdkInstanceInfo, SerialPort } from "./sdk-types";
import { INSOLE_BAUD_RATES, SDK_PRODUCTS, sdkHasImu } from "./sdk-types";

interface Options {
  online: boolean;
  recording: boolean;
  onDevicesChanged: () => Promise<void>;
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : "SDK 请求失败";

function instancesOf(info: SdkInfo): SdkInstanceInfo[] {
  if (Array.isArray(info.instances)) return info.instances;
  // Keep older servers usable while the default connection is migrated.
  return [{ ...info, instance_id: info.instance_id ?? "default", stream_ids: info.stream_ids ?? (info.device_id ? [info.device_id] : []) }];
}

function connectionSignature(info: SdkInfo): string {
  return JSON.stringify([info.loaded, instancesOf(info).map(instance => [
    instance.instance_id, instance.loaded, instance.connected, !!instance.connecting,
    !!instance.has_device, instance.product ?? null, instance.path ?? null,
    instance.side ?? null, instance.error ?? null, instance.device_id ?? null,
    instance.ready ?? null, instance.protocol ?? null, instance.baudRate ?? null,
    instance.stream_ids,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))]);
}

export function useSdkConnections(options: Options) {
  const [info, setInfo] = useState<SdkInfo | null>(null);
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [serviceError, setServiceError] = useState("");
  const [scanError, setScanError] = useState("");
  const current = useRef(options);
  current.current = options;
  const infoRef = useRef<SdkInfo | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const mutationVersion = useRef(0);
  const signature = useRef<string | null>(null);
  const locks = useRef(new Map<string, symbol>());
  const scanLock = useRef<symbol | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const inFlight = useRef<{ generation: number; promise: Promise<void> } | null>(null);

  const publish = useCallback((next: SdkInfo) => {
    infoRef.current = next;
    setInfo(next);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (!active.current || !current.current.online) return Promise.reject(new Error("采集服务离线，请恢复连接后重试。"));
    const runGeneration = generation.current;
    if (inFlight.current?.generation === runGeneration) return inFlight.current.promise;
    const controller = new AbortController();
    controllers.current.add(controller);
    const flight = { generation: runGeneration, promise: Promise.resolve() };
    flight.promise = (async () => {
      let seenVersion: number;
      do {
        seenVersion = mutationVersion.current;
        const next = await request<SdkInfo>("/api/sdk/info", undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]));
        if (!active.current || generation.current !== runGeneration) return;
        // A response begun before a connection mutation cannot overwrite its newer result.
        if (seenVersion !== mutationVersion.current) continue;
        publish(next);
        setServiceError("");
        const nextSignature = connectionSignature(next);
        if (signature.current !== nextSignature) {
          await current.current.onDevicesChanged();
          if (!active.current || generation.current !== runGeneration) return;
          signature.current = nextSignature;
        }
      } while (seenVersion !== mutationVersion.current);
    })().finally(() => {
      controllers.current.delete(controller);
      if (inFlight.current === flight) inFlight.current = null;
    });
    inFlight.current = flight;
    return flight.promise;
  }, [publish]);

  useEffect(() => {
    active.current = true;
    const runGeneration = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setBusyIds([]);
    setScanning(false);
    async function poll() {
      try { await refresh(); }
      catch (error) {
        if (active.current && generation.current === runGeneration) setServiceError(messageOf(error));
      }
      if (active.current && generation.current === runGeneration && current.current.online)
        timer = setTimeout(() => void poll(), 2000);
    }
    if (options.online) void poll();
    return () => {
      active.current = false;
      generation.current++;
      clearTimeout(timer);
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      inFlight.current = null;
      locks.current.clear();
      scanLock.current = null;
    };
  }, [options.online, refresh]);

  const assertAvailable = useCallback(() => {
    if (!active.current || !current.current.online) throw new Error("采集服务离线，请恢复连接后重试。");
    if (current.current.recording) throw new Error("录制期间无法更改传感器连接，请先停止录制。");
    if (infoRef.current?.loaded === false) throw new Error(infoRef.current.error || "SDK 尚未加载。");
  }, []);

  const beginOperation = useCallback((instanceId: string) => {
    assertAvailable();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(instanceId)) throw new Error("传感器连接标识无效。");
    if (locks.current.has(instanceId)) throw new Error("此传感器的连接操作正在进行，请稍候。");
    const token = Symbol(instanceId);
    locks.current.set(instanceId, token);
    setBusyIds([...locks.current.keys()]);
    mutationVersion.current++;
    const controller = new AbortController();
    controllers.current.add(controller);
    const runGeneration = generation.current;
    return {
      controller,
      isCurrent: () => active.current && generation.current === runGeneration,
      release: () => {
        controllers.current.delete(controller);
        if (locks.current.get(instanceId) === token) {
          locks.current.delete(instanceId);
          if (active.current && generation.current === runGeneration) setBusyIds([...locks.current.keys()]);
        }
      },
    };
  }, [assertAvailable]);

  const applyInstance = useCallback((instance: SdkInstanceInfo, remove: boolean) => {
    const previous = infoRef.current;
    const instances = previous ? instancesOf(previous).filter(item => item.instance_id !== instance.instance_id) : [];
    if (!remove || instance.instance_id === "default") instances.push(instance);
    publish({ ...(previous ?? { loaded: instance.loaded, connected: false }),
      ...(instance.instance_id === "default" ? instance : {}), instances });
  }, [publish]);

  const connect = useCallback(async (input: SdkConnectionInput): Promise<SdkInstanceInfo> => {
    const operation = beginOperation(input.instance_id);
    try {
      if (!SDK_PRODUCTS.includes(input.product)) throw new Error("请选择有效的传感器型号。");
      if (input.product !== "mock" && !input.path?.trim()) throw new Error("请选择或输入串口。");
      if (sdkHasImu(input.product) && !["left", "right"].includes(input.side ?? "")) throw new Error(input.product === "insole" ? "请选择鞋垫左右脚。" : "请选择手套左右手。");
      if (input.product === "insole" && !["12bit", "8bit"].includes(input.protocol ?? "12bit")) throw new Error("请选择鞋垫数据格式。");
      if (input.product === "insole" && !INSOLE_BAUD_RATES.includes(input.baudRate ?? 921600)) throw new Error("请选择鞋垫支持的波特率。");
      if (input.product === "glove" && !["segmented", "full-packet"].includes(input.gloveProtocol ?? "segmented")) throw new Error("请选择手套协议。");
      const response = await request<SdkInstanceInfo>("/api/sdk/connect", {
        instance_id: input.instance_id, product: input.product,
        ...(input.product === "mock" ? { mode: "mock" } : { path: input.path!.trim() }),
        ...(sdkHasImu(input.product) ? { side: input.side } : {}),
        ...(input.product === "insole" ? { protocol: input.protocol ?? "12bit", baudRate: input.baudRate ?? 921600 } : {}),
        ...(input.product === "glove" ? { gloveProtocol: input.gloveProtocol ?? "segmented" } : {}),
      }, AbortSignal.any([operation.controller.signal, AbortSignal.timeout(60000)]));
      const instance = { ...response, instance_id: response.instance_id ?? input.instance_id, stream_ids: response.stream_ids ?? [] };
      if (operation.isCurrent()) {
        mutationVersion.current++;
        applyInstance(instance, false);
        await refresh();
      }
      return instance;
    } catch (error) {
      if (operation.isCurrent()) void refresh().catch(() => {});
      throw new Error(sdkConnectionErrorMessage(error, input.path), { cause: error });
    } finally { operation.release(); }
  }, [applyInstance, beginOperation, refresh]);

  const disconnect = useCallback(async (instanceId: string): Promise<void> => {
    const operation = beginOperation(instanceId);
    try {
      const response = await request<SdkInstanceInfo>("/api/sdk/disconnect", { instance_id: instanceId },
        AbortSignal.any([operation.controller.signal, AbortSignal.timeout(15000)]));
      if (operation.isCurrent()) {
        mutationVersion.current++;
        applyInstance({ ...response, instance_id: response.instance_id ?? instanceId, stream_ids: response.stream_ids ?? [] }, true);
        await refresh();
      }
    } catch (error) {
      if (operation.isCurrent()) void refresh().catch(() => {});
      throw error;
    } finally { operation.release(); }
  }, [applyInstance, beginOperation, refresh]);

  const scanPorts = useCallback(async (): Promise<void> => {
    assertAvailable();
    if (scanLock.current) throw new Error("正在扫描串口，请稍候。");
    const token = Symbol("ports"), runGeneration = generation.current;
    scanLock.current = token;
    setScanning(true);
    setScanError("");
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const response = await request<{ ports: SerialPort[] }>("/api/sdk/ports", undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
      if (active.current && generation.current === runGeneration) {
        setPorts(Array.isArray(response.ports) ? response.ports.filter(port => !!port && typeof port.path === "string") : []);
      }
    } catch (error) {
      if (active.current && generation.current === runGeneration) setScanError(messageOf(error));
      throw error;
    } finally {
      controllers.current.delete(controller);
      if (scanLock.current === token) {
        scanLock.current = null;
        if (active.current && generation.current === runGeneration) setScanning(false);
      }
    }
  }, [assertAvailable]);

  return { info, instances: info ? instancesOf(info) : [], ports, busyIds, scanning,
    error: scanError || serviceError, serviceError, refresh, scanPorts, connect, disconnect };
}
