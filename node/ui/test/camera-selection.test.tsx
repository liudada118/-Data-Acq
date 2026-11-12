import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import type { CameraConnection, CameraOption, UseCameraCaptureResult } from "../src/camera-types";
import { createCameraCard } from "../src/workspace";
import type { WorkspaceState } from "../src/workspace";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLMediaElement.prototype.play = async () => {};
dom.window.HTMLMediaElement.prototype.pause = () => {};
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const CARD_ID = "c-selection";
const TO_DESK = { deviceId: "todesk-system-device", label: "ToDesk Camera" };
const DROID_CAM = { deviceId: "droidcam-exact-system-device", label: "DroidCam Video" };
const AVAILABLE = [TO_DESK, DROID_CAM];

function connectionFor(option: CameraOption): CameraConnection {
  const track = { readyState: "live", stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return {
    instanceId: CARD_ID, deviceId: option.deviceId, label: option.label, stream,
    width: 1280, height: 720, frameRate: 30, quality: "720p", connected: true, error: null,
  };
}

async function mountWorkspace(options: {
  deviceId?: string;
  devices?: CameraOption[];
  connection?: CameraConnection;
  recording?: boolean;
  busy?: boolean;
} = {}) {
  const connectCalls: Parameters<UseCameraCaptureResult["connect"]>[] = [];
  const disconnectCalls: string[] = [];
  const removeCalls: string[] = [];
  let changeDevices: (devices: CameraOption[]) => void = () => { throw new Error("Not mounted"); };
  const sdk: AcquisitionWorkspaceProps["sdk"] = {
    info: null, instances: [], ports: [], busyIds: [], scanning: false, error: "",
    refresh: async () => {}, scanPorts: async () => {}, disconnect: async () => {},
    connect: async () => { throw new Error("Camera selection must not call the SDK"); },
  };

  function Fixture() {
    const [workspace, setWorkspace] = useState<WorkspaceState>({
      version: 1, layout: "grid",
      cards: [{ ...createCameraCard(CARD_ID), deviceId: options.deviceId ?? "" }],
    });
    const [devices, setDevices] = useState(options.devices ?? AVAILABLE);
    const [connections, setConnections] = useState<Record<string, CameraConnection>>(
      options.connection ? { [CARD_ID]: options.connection } : {},
    );
    changeDevices = setDevices;
    const camera: UseCameraCaptureResult = {
      devices, connections, busyIds: [], scanning: false, error: "",
      scan: async () => {},
      connect: async (...args) => {
        connectCalls.push(args);
        const selected = devices.find((item) => item.deviceId === args[1]);
        if (!selected) throw new Error("Expected an explicitly selected, enumerated camera");
        const connection = { ...connectionFor(selected), instanceId: args[0], quality: args[2] ?? "720p" };
        setConnections((current) => ({ ...current, [args[0]]: connection }));
        return connection;
      },
      disconnect: async (id) => {
        disconnectCalls.push(id);
        setConnections((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      },
      prepareRecording: async () => [], startRecording: async () => {},
      recordingSessionId: () => null,
      stopRecording: async () => {}, cancelPrepared: async () => {},
    };
    return <AcquisitionWorkspace
      workspace={workspace} sdk={sdk} camera={camera}
      devices={Object.values(connections).map((connection) => ({
        id: `camera-${connection.instanceId}`, name: connection.label, kind: "camera",
        mode: "hardware", transport: "Browser", connected: connection.connected,
        sample_rate: connection.frameRate, channels: 3, unit: "frame",
      }))}
      online recording={options.recording ?? false} busy={options.busy ?? false}
      previewPaused={false} previewConnected previewRate={15}
      onAddSim={() => {}} onAddSdk={() => {}} onAddCamera={() => {}}
      onRemove={async id => { removeCalls.push(id); }} onTogglePreview={() => {}}
      onLayout={(layout) => setWorkspace((current) => ({ ...current, layout }))}
      onUpdate={(id, patch) => setWorkspace((current) => ({
        ...current,
        cards: current.cards.map((card) => card.id === id ? { ...card, ...patch } : card),
      }))}
    />;
  }

  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<Fixture />));
  return {
    node, connectCalls, disconnectCalls, removeCalls,
    select: () => node.querySelector<HTMLSelectElement>('[aria-label="安卓 / 系统摄像头设备"]')!,
    connectButton: () => node.querySelector<HTMLButtonElement>('[aria-label="连接安卓 / 系统摄像头"]')!,
    disconnectButton: () => node.querySelector<HTMLButtonElement>('header .workspace-disconnect[aria-label="断开安卓 / 系统摄像头"]')!,
    setDevices: async (devices: CameraOption[]) => { await act(async () => changeDevices(devices)); },
    dispose: async () => { await act(async () => root.unmount()); node.remove(); },
  };
}

async function selectDevice(select: HTMLSelectElement, deviceId: string) {
  await act(async () => {
    select.value = deviceId;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

test("enumerated cameras do not implicitly select or connect a default device", async () => {
  const view = await mountWorkspace();
  try {
    assert.equal(view.select().value, "");
    assert.equal(view.connectButton().disabled, true);
    await act(async () => view.connectButton().click());
    assert.deepEqual(view.connectCalls, []);
    assert.deepEqual([...view.select().options].filter((option) => option.value).map((option) => option.value),
      [TO_DESK.deviceId, DROID_CAM.deviceId]);
  } finally { await view.dispose(); }
});

test("selecting DroidCam connects the exact chosen device rather than the first enumerated camera", async () => {
  const view = await mountWorkspace();
  try {
    await selectDevice(view.select(), DROID_CAM.deviceId);
    assert.equal(view.connectButton().disabled, false);
    await act(async () => view.connectButton().click());
    assert.deepEqual(view.connectCalls, [[CARD_ID, DROID_CAM.deviceId, "720p"]]);
    assert.equal(view.select().value, DROID_CAM.deviceId);
    assert.equal(view.select().disabled, true);
  } finally { await view.dispose(); }
});

test("a saved device ID missing from the current camera list cannot connect", async () => {
  const view = await mountWorkspace({ deviceId: "expired-browser-camera-id" });
  try {
    assert.equal(view.select().value, "expired-browser-camera-id");
    assert.equal(view.select().selectedOptions[0].disabled, true);
    assert.equal(view.connectButton().disabled, true);
    await act(async () => view.connectButton().click());
    assert.deepEqual(view.connectCalls, []);
    await selectDevice(view.select(), DROID_CAM.deviceId);
    assert.equal(view.connectButton().disabled, false);
  } finally { await view.dispose(); }
});

test("DroidCam appearing does not replace an active ToDesk stream; switching requires a user disconnect and selection", async () => {
  const current = connectionFor(TO_DESK);
  const view = await mountWorkspace({ deviceId: TO_DESK.deviceId, devices: [TO_DESK], connection: current });
  try {
    const card = view.node.querySelector(`[data-instance-id="${CARD_ID}"]`)!;
    const panel = card.querySelector<HTMLElement>(".workspace-config-panel")!;
    assert.equal(panel.hidden, true);
    assert.ok(view.disconnectButton(), "connected camera has a header disconnect control");
    assert.equal(view.disconnectButton().closest("[hidden]"), null);
    assert.equal(view.select().disabled, true);
    assert.equal(view.node.querySelector("video")!.srcObject, current.stream);
    await view.setDevices(AVAILABLE);
    assert.equal(view.select().value, TO_DESK.deviceId);
    assert.equal(view.select().disabled, true);
    assert.equal(view.node.querySelector("video")!.srcObject, current.stream);
    assert.deepEqual(view.connectCalls, []);
    assert.deepEqual(view.disconnectCalls, []);

    await act(async () => view.disconnectButton().click());
    assert.deepEqual(view.disconnectCalls, [CARD_ID]);
    assert.deepEqual(view.removeCalls, []);
    assert.equal(view.node.querySelector(`[data-instance-id="${CARD_ID}"]`), card);
    assert.equal(panel.hidden, false);
    assert.equal(view.select().value, TO_DESK.deviceId, "disconnect preserves the selected camera");
    assert.equal(view.select().disabled, false);
    await selectDevice(view.select(), DROID_CAM.deviceId);
    await act(async () => view.connectButton().click());
    assert.deepEqual(view.connectCalls, [[CARD_ID, DROID_CAM.deviceId, "720p"]]);
    assert.equal(view.select().value, DROID_CAM.deviceId);
  } finally { await view.dispose(); }
});

test("camera header disconnect cannot interrupt recording or another workspace transition", async () => {
  for (const state of ["recording", "busy"]) {
    const view = await mountWorkspace({ deviceId: TO_DESK.deviceId, connection: connectionFor(TO_DESK),
      recording: state === "recording", busy: state === "busy" });
    try {
      assert.ok(view.disconnectButton(), state);
      assert.equal(view.disconnectButton().disabled, true, state);
      await act(async () => view.disconnectButton().click());
      assert.deepEqual(view.disconnectCalls, [], state);
      assert.deepEqual(view.removeCalls, [], state);
    } finally { await view.dispose(); }
  }
});
