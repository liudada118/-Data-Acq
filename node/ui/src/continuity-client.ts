import { request } from "./api";
import type { ContinuityJob } from "./continuity-types";

const route = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/continuity`;

export async function getContinuityJob(sessionId: string, signal?: AbortSignal): Promise<ContinuityJob | null> {
  const response = await request<{ job: ContinuityJob | null }>(route(sessionId), undefined,
    signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : undefined);
  return response.job;
}
export async function startContinuityJob(sessionId: string, thresholdMs: number): Promise<ContinuityJob> {
  const response = await request<{ job: ContinuityJob | null }>(route(sessionId), { threshold_ms: thresholdMs });
  if (!response.job) throw new Error("未收到检查任务，请刷新任务状态。");
  return response.job;
}
export async function cancelContinuityJob(sessionId: string): Promise<ContinuityJob> {
  const response = await request<{ job: ContinuityJob | null }>(`${route(sessionId)}/cancel`, {});
  if (!response.job) throw new Error("未收到取消后的任务状态，请刷新任务状态。");
  return response.job;
}
