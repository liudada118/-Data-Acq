import { useEffect, useRef } from "react";

export interface DesktopCloseResult {
  ok: boolean;
  message?: string;
}

export type DesktopBeforeCloseHandler = () => Promise<DesktopCloseResult>;
export interface AgentModelSettings { baseUrl: string; model: string; hasKey: boolean }
export interface AgentModelProvider {
  id: string; label: string; baseUrl: string; defaultModel: string;
  models: { id: string; label: string }[]; hint?: string;
}
export interface AgentModelCatalog {
  schemaVersion: 1; version: string; providers: AgentModelProvider[];
  source: "remote" | "cache" | "default"; updatedAt: number | null; warning?: string;
}
export interface AgentModelSettingsInput { baseUrl: string; model: string; apiKey?: string; clearApiKey?: boolean }
export interface DesktopIntegration {
  invoke(action: string, args?: Record<string, unknown>): Promise<unknown>;
  chooseSdkDirectory(): Promise<unknown | null>;
  modelSettings: {
    get(): Promise<AgentModelSettings>;
    save(settings: AgentModelSettingsInput): Promise<AgentModelSettings>;
    catalog?(options?: { refresh?: boolean }): Promise<AgentModelCatalog>;
  };
}

declare global {
  interface Window {
    synapseDesktop?: {
      onBeforeClose(handler: DesktopBeforeCloseHandler): () => void;
      integration?: DesktopIntegration;
    };
  }
}

/** The preload owns IPC; browser builds have no desktop subscription. */
export function useDesktopBeforeClose(handler: DesktopBeforeCloseHandler): void {
  const latest = useRef(handler);
  latest.current = handler;
  const pending = useRef(false);
  useEffect(() => {
    const desktop = typeof window === "undefined" ? undefined : window.synapseDesktop;
    if (!desktop) return;
    return desktop.onBeforeClose(async () => {
      if (pending.current) return { ok: false, message: "正在确认退出，请稍候。" };
      pending.current = true;
      try {
        return await latest.current();
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : "无法确认采集已安全结束，请稍后再退出。" };
      } finally {
        pending.current = false;
      }
    });
  }, []);
}
