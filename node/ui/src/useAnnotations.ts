import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import type { AnnotationDocument, AnnotationMutation, Experiment, LabelDefinition } from "./workflow";

export function useAnnotations(sessionId: string | null, live = false) {
  const [document, setDocument] = useState<AnnotationDocument | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef<AnnotationDocument | null>(null);
  const generation = useRef(0);
  const serial = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const endpoint = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}` : "";

  const call = useCallback(async (suffix: string, input?: unknown) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const response = await fetch(`${API_BASE}${endpoint}${suffix}`, { method: input === undefined ? "GET" : "POST", headers: input === undefined ? undefined : { "Content-Type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error ?? `请求失败 (${response.status})`), { status: response.status });
      return data as AnnotationDocument;
    } finally { controllers.current.delete(controller); }
  }, [endpoint]);
  const accept = useCallback((value: AnnotationDocument, mine: number) => {
    if (mine !== generation.current || value.session_id !== sessionId) return;
    if (current.current && value.revision < current.current.revision) return;
    current.current = value; setDocument(value);
  }, [sessionId]);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const mine = generation.current;
    const value = await call("/annotations");
    accept(value, mine);
  }, [sessionId, call, accept]);
  useEffect(() => {
    generation.current++; current.current = null; setDocument(null); setError(""); setBusy(false); serial.current = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await refresh(); } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : "标签加载失败"); }
      if (!stopped && live) timer = setTimeout(poll, 1500);
    }
    if (sessionId) void poll();
    return () => { stopped = true; generation.current++; clearTimeout(timer); for (const controller of controllers.current) controller.abort(); controllers.current.clear(); };
  }, [sessionId, live, refresh]);

  const write = useCallback(async (suffix: string, payload: unknown): Promise<boolean> => {
    if (!sessionId || !current.current || serial.current) return false;
    const mine = generation.current;
    serial.current = true; setBusy(true); setError("");
    try {
      const value = await call(suffix, { revision: current.current.revision, ...(payload as object) });
      accept(value, mine); return mine === generation.current;
    } catch (cause) {
      if (mine !== generation.current) return false;
      if ((cause as { status?: number }).status === 409) {
        await refresh().catch(() => {});
        setError("标签已被更新，已读取最新版本，请检查后重试。");
      } else {
        await refresh().catch(() => {});
        setError(`${cause instanceof Error ? cause.message : "标签保存失败"}；请检查最新标注记录后再操作。`);
      }
      return false;
    } finally { if (mine === generation.current) { serial.current = false; setBusy(false); } }
  }, [sessionId, call, accept, refresh]);
  const mutate = useCallback((payload: AnnotationMutation) => write("/annotations", payload), [write]);
  const updateContext = useCallback((payload: { experiment?: Experiment; labels?: LabelDefinition[] }) => write("/context", payload), [write]);
  return { document, error, busy, refresh, mutate, updateContext };
}
