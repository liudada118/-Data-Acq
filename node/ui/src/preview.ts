import { request } from "./api";
import type { Preview } from "./types";

type Listener = (preview: Preview) => void;
const listeners = new Set<Listener>();
let latest: Preview | null = null;

export function subscribePreview(listener: Listener): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => {
    listeners.delete(listener);
  };
}

export function startPreviewPolling(
  intervalMs: number,
  onConnection: (connected: boolean) => void,
): () => void {
  let stopped = false;
  let timeout: ReturnType<typeof setTimeout>;
  let controller: AbortController | null = null;
  async function poll() {
    controller = new AbortController();
    const abortTimer = setTimeout(() => controller?.abort(), 4000);
    try {
      const preview = await request<Preview>(
        "/api/preview",
        undefined,
        controller.signal,
      );
      if (stopped) return;
      latest = preview;
      onConnection(true);
      for (const listener of listeners) listener(preview);
    } catch {
      if (!stopped) onConnection(false);
    } finally {
      clearTimeout(abortTimer);
      if (!stopped) timeout = setTimeout(poll, intervalMs);
    }
  }
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timeout);
    controller?.abort();
  };
}
