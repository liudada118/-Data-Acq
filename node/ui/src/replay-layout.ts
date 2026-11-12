import type { Device } from "./types";

export interface ReplaySensorGroup {
  id: string;
  name: string;
  streams: Device[];
}

function sdkInstance(stream: Device): string | null {
  if (stream.kind !== "pressure" && stream.kind !== "imu") return null;
  const explicit = stream.metadata?.instance_id;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const match = /^sdk(?:-([a-z0-9][a-z0-9_-]{0,47}))?-(pressure|imu-raw)$/.exec(stream.id);
  if (!match || (stream.kind === "pressure") !== (match[2] === "pressure")) return null;
  return match[1] ?? "default";
}

/** Pair only an unambiguous SDK pressure/IMU pair; annotation IDs remain untouched. */
export function groupReplayStreams(streams: readonly Device[]): ReplaySensorGroup[] {
  const candidates = new Map<string, Device[]>();
  for (const stream of streams) {
    const instance = sdkInstance(stream);
    if (instance !== null) candidates.set(instance, [...(candidates.get(instance) ?? []), stream]);
  }
  const pairs = new Map<string, Device[]>();
  for (const [instance, group] of candidates) {
    if (group.length === 2 && group.filter(stream => stream.kind === "pressure").length === 1 &&
        group.filter(stream => stream.kind === "imu").length === 1 && group[0].id !== group[1].id)
      pairs.set(instance, [...group].sort((a, b) => Number(a.kind === "imu") - Number(b.kind === "imu")));
  }
  const seen = new Set<string>();
  const result: ReplaySensorGroup[] = [];
  for (const stream of streams) {
    const instance = sdkInstance(stream);
    const pair = instance === null ? undefined : pairs.get(instance);
    if (pair && instance !== null) {
      if (!seen.has(instance)) result.push({ id: `instance:${instance}`, name: pair[0].name, streams: pair });
      seen.add(instance);
    } else result.push({ id: `stream:${stream.id}`, name: stream.name, streams: [stream] });
  }
  return result;
}
