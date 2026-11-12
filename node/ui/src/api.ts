import type { ExportFormat, ExportJob, Session } from "./types";

// Capture and export use the same API contract and origin in the Node prototype.
// Switching to another backend only requires changing its API base.
export const API_BASE = import.meta.env?.VITE_API_BASE ?? "";

export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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
  return `${API_BASE}${path}`;
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
