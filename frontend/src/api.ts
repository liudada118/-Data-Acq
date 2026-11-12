import type { ExportFormat, ExportJob, Session } from "./types";

export const NATIVE_BASE = import.meta.env.VITE_NATIVE_BASE ?? "";
// Development uses Vite's local proxy. Packaged/static UI talks to the same host's exporter.
export const EXPORT_BASE =
  import.meta.env.VITE_EXPORT_BASE ??
  (import.meta.env.DEV
    ? ""
    : `${window.location.protocol}//${window.location.hostname || "127.0.0.1"}:8766`);

export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const base = path.startsWith("/api/export") ? EXPORT_BASE : NATIVE_BASE;
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(6000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data as { error?: string; message?: string } | null;
    throw new Error(
      error?.error ?? error?.message ?? `请求失败 (${response.status})`,
    );
  }
  return data as T;
}

export function downloadUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${path.startsWith("/api/export") ? EXPORT_BASE : NATIVE_BASE}${path}`;
}

export async function getSessions(): Promise<Session[]> {
  const data = await request<{ sessions: Session[] }>("/api/sessions");
  return data.sessions ?? [];
}

export async function getFormats(): Promise<ExportFormat[]> {
  const data = await request<{ formats: ExportFormat[] }>(
    "/api/export/formats",
  );
  return data.formats ?? [];
}

export async function getJobs(): Promise<ExportJob[]> {
  const data = await request<{ jobs: ExportJob[] }>("/api/export/jobs");
  return data.jobs ?? [];
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** exponent).toFixed(exponent > 0 ? 1 : 0)} ${units[exponent]}`;
}

export function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}

export function formatDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}
