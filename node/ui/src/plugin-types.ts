import type { Device, DeviceKind } from "./types";

export interface PluginConfigField {
  key: string; label: string; type: "string" | "number" | "boolean";
  required?: boolean; default?: string | number | boolean;
}
export interface SensorPlugin {
  api_version?: 1;
  id: string; name: string; version: string; entry: string;
  description?: string;
  streams: (Partial<Device> & { id: string; name: string; kind: DeviceKind })[];
  config_fields: PluginConfigField[];
}
export interface PluginInstance {
  instance_id: string; plugin_id: string; connected: boolean;
  stream_ids: string[]; error?: string;
}
export interface PluginCatalog { plugins: SensorPlugin[]; instances: PluginInstance[] }
export type PluginConfig = Record<string, string | number | boolean>;
