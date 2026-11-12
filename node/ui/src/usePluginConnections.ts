import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./api";
import type { PluginCatalog, PluginConfig } from "./plugin-types";

export function usePluginConnections(options: { online: boolean; recording: boolean; onDevicesChanged: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<PluginCatalog>({ plugins: [], instances: [] });
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const current = useRef(options); current.current = options;
  const version = useRef(0), live = useRef(true), locks = useRef(new Set<string>()), signature = useRef("");
  const refresh = useCallback(async () => {
    if (!current.current.online) return;
    const revision = version.current;
    const next = await request<PluginCatalog>("/api/plugins/catalog", undefined, AbortSignal.timeout(10000));
    if (!live.current || revision !== version.current) return;
    setCatalog(next); setError("");
    const nextSignature = JSON.stringify(next.instances);
    if (signature.current !== nextSignature) { signature.current = nextSignature; await current.current.onDevicesChanged(); }
  }, []);
  useEffect(() => {
    live.current = true; let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : "插件服务不可用"); }
      if (!disposed && options.online) timer = setTimeout(() => void poll(), 2500);
    };
    if (options.online) void poll();
    return () => { disposed = true; live.current = false; version.current++; clearTimeout(timer); };
  }, [options.online, refresh]);
  const mutate = useCallback(async (action: "connect" | "disconnect", instanceId: string, input: object) => {
    if (!current.current.online) throw new Error("采集服务离线");
    if (current.current.recording) throw new Error("请先停止采集，再调整插件连接。");
    if (locks.current.has(instanceId)) throw new Error("正在处理此设备，请稍候。");
    locks.current.add(instanceId); setBusyIds([...locks.current]); version.current++;
    try {
      await request(`/api/plugins/${action}`, input, AbortSignal.timeout(45000));
      version.current++;
      await refresh(); await current.current.onDevicesChanged();
    } finally { locks.current.delete(instanceId); if (live.current) setBusyIds([...locks.current]); }
  }, [refresh]);
  return { ...catalog, busyIds, error, refresh,
    connect: (pluginId: string, instanceId: string, config: PluginConfig) => mutate("connect", instanceId, { plugin_id: pluginId, instance_id: instanceId, config }),
    disconnect: (instanceId: string) => mutate("disconnect", instanceId, { instance_id: instanceId }),
  };
}
