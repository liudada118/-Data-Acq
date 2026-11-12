import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { sdkReceiveHealth, SdkReceiveHealthStatus } from "../src/SdkReceiveHealth";
import type { SdkInstanceInfo, SdkReceiveHealth } from "../src/sdk-types";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { createSdkCard } from "../src/workspace";

const telemetry: SdkReceiveHealth = { sampled_at_monotonic_ms: 1000, observed_ms: 10000, last_frame_age_ms: 10, receive_rate_hz: 20,
  rate_window_ms: 10000, frames_in_window: 200, expected_interval_ms: 50, interruption_threshold_ms: 10000 };
const connected = (health: Partial<SdkReceiveHealth> = {}): SdkInstanceInfo => ({ instance_id: "sensor", loaded: true,
  connected: true, product: "hand-pad", ready: true, stream_ids: ["sdk-sensor-pressure"], receive_health: { ...telemetry, ...health } });

test("receive health distinguishes first-frame wait, unknown cadence, current frames, and interrupted data", () => {
  assert.equal(sdkReceiveHealth(connected({ last_frame_age_ms: null, expected_interval_ms: null,
    interruption_threshold_ms: null, receive_rate_hz: 0, frames_in_window: 0 }), true, 0).state, "waiting");
  assert.equal(sdkReceiveHealth(connected({ interruption_threshold_ms: null }), true, 0).state, "observing");
  assert.equal(sdkReceiveHealth(connected(), true, 1000).state, "normal");
  assert.equal(sdkReceiveHealth(connected({ last_frame_age_ms: 10000, receive_rate_hz: 0 }), true, 0).state, "interrupted");
  assert.equal(sdkReceiveHealth(connected({ last_frame_age_ms: 100000, interruption_threshold_ms: 120000,
    expected_interval_ms: 30000, receive_rate_hz: 0 }), true, 0).state, "normal", "a slow source is not judged by the empty short-rate window");
  assert.equal(sdkReceiveHealth(connected({ last_frame_age_ms: 100000, interruption_threshold_ms: null }), true, 0).state,
    "unknown", "one old frame cannot prove an unknown-frequency source is broken");
});

test("offline, failed SDK polling, expired snapshots and legacy telemetry cannot assert a device interruption", () => {
  const old = connected({ last_frame_age_ms: 50000 });
  assert.equal(sdkReceiveHealth(old, false, 0).state, "offline");
  assert.equal(sdkReceiveHealth(old, true, 0, "SDK status fetch failed").state, "unknown");
  assert.equal(sdkReceiveHealth(old, true, 10000).state, "unknown");
  assert.equal(sdkReceiveHealth({ ...old, receive_health: undefined }, true, 0).state, "unknown");
  assert.equal(sdkReceiveHealth(connected({ last_frame_age_ms: Number.NaN }), true, 0).state, "unknown");
  assert.equal(sdkReceiveHealth({ ...old, connected: false }, true, 0).state, "disconnected");
  assert.equal(sdkReceiveHealth({ ...old, connected: false, connecting: true }, true, 0).state, "waiting");
  assert.equal(sdkReceiveHealth({ ...old, error: "device removed" }, true, 0).state, "error");
});

test("frame age advances from the received snapshot without a preview subscription or a wall clock", async t => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  let monotonic = 1000, onTick: (() => void) | undefined, cleared = false;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(globalThis, "setInterval", ((callback: () => void, interval: number) => {
    assert.equal(interval, 1000); onTick = callback; return 123;
  }) as unknown as typeof setInterval);
  t.mock.method(globalThis, "clearInterval", (() => { cleared = true; }) as typeof clearInterval);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), instance = connected({ last_frame_age_ms: 9500 });
  t.after(() => host.remove());
  await act(async () => root.render(<SdkReceiveHealthStatus instance={instance} online />));
  assert.equal(host.firstElementChild?.getAttribute("data-health"), "normal");
  assert.match(host.querySelector(".sdk-health-age")!.textContent!, /9 秒前/);
  assert.match(host.querySelector(".sdk-health-rate")!.textContent!, /20\.0 Hz/);
  assert.ok(onTick);
  monotonic += 1000;
  await act(async () => onTick!());
  assert.equal(host.firstElementChild?.getAttribute("data-health"), "interrupted");
  assert.match(host.querySelector(".sdk-health-age")!.textContent!, /10 秒前/);
  await act(async () => root.render(<SdkReceiveHealthStatus instance={connected({ sampled_at_monotonic_ms: 2000 })} online />));
  assert.equal(host.firstElementChild?.getAttribute("data-health"), "normal", "a fresh snapshot replaces the old age baseline");
  monotonic += 11000;
  await act(async () => root.render(<SdkReceiveHealthStatus instance={connected({ sampled_at_monotonic_ms: 2000 })} online />));
  assert.equal(host.firstElementChild?.getAttribute("data-health"), "unknown", "new HTTP objects with the same cached sample do not renew telemetry freshness");
  await act(async () => root.render(<SdkReceiveHealthStatus instance={instance} online serviceError="poll failed" />));
  assert.equal(host.firstElementChild?.getAttribute("data-health"), "unknown");
  assert.match(host.querySelector(".sdk-health-age")!.textContent!, /—/);
  await act(async () => root.unmount());
  assert.equal(cleared, true);
});

test("each SDK card keeps its independent receive status visible when preview is paused or the service goes offline", async t => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  t.mock.method(performance, "now", () => 1000);
  const { createRoot } = await import("react-dom/client");
  const first = connected(), second = { ...connected({ last_frame_age_ms: 15000, receive_rate_hz: 0 }), instance_id: "other",
    stream_ids: ["sdk-other-pressure"] };
  const props: AcquisitionWorkspaceProps = {
    workspace: { version: 1, layout: "grid", cards: [createSdkCard("hand-pad", "sensor"), createSdkCard("hand-pad", "other")] },
    sdk: { instances: [first, second], info: { loaded: true }, serviceError: "", ports: [], busyIds: [], scanning: false,
      scanPorts: async () => {} } as unknown as AcquisitionWorkspaceProps["sdk"],
    camera: { connections: {}, devices: [], busyIds: [], scanning: false } as unknown as AcquisitionWorkspaceProps["camera"],
    devices: [first, second].map(instance => ({ id: instance.stream_ids[0], kind: "pressure", connected: true,
      name: instance.instance_id, channels: 1024, sample_rate: 0, unit: "ADC", mode: "hardware" })),
    online: true, recording: true, busy: false, previewPaused: false, previewConnected: true, previewRate: 10,
    onAddSdk() {}, onAddCamera() {}, onRemove: async () => {}, onUpdate() {}, onLayout() {}, onTogglePreview() {},
  };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<AcquisitionWorkspace {...props} />));
  const firstStatus = host.querySelector('[data-instance-id="sensor"] .sdk-receive-health')!;
  const secondStatus = host.querySelector('[data-instance-id="other"] .sdk-receive-health')!;
  assert.equal(firstStatus.getAttribute("data-health"), "normal");
  assert.equal(secondStatus.getAttribute("data-health"), "interrupted");
  assert.equal(firstStatus.closest("[hidden]"), null);
  await act(async () => root.render(<AcquisitionWorkspace {...props} previewPaused />));
  assert.equal(host.querySelectorAll(".sdk-receive-health").length, 2);
  assert.equal(firstStatus.getAttribute("data-health"), "normal");
  assert.equal(secondStatus.getAttribute("data-health"), "interrupted");
  await act(async () => root.render(<AcquisitionWorkspace {...props} previewPaused online={false} />));
  assert.equal(firstStatus.getAttribute("data-health"), "offline");
  assert.equal(secondStatus.getAttribute("data-health"), "offline");
});
