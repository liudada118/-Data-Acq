import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import type { MicrophoneConnection, MicrophoneOption, UseMicrophoneCaptureResult } from "../src/microphone-types";
import type { UseCameraCaptureResult } from "../src/camera-types";
import { createCameraCard, createMicrophoneCard, createSdkCard } from "../src/workspace";
import type { WorkspaceState } from "../src/workspace";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());
const COMPUTER = { deviceId: "computer-mic", label: "电脑麦克风" };
const PHONE = { deviceId: "droidcam-audio-input", label: "DroidCam Audio" };
const VIDEO_ID = "droidcam-video-input";
const MIC_ID = "m-fixture";

async function fixture(options: { active?: boolean; deviceId?: string; devices?: MicrophoneOption[]; many?: boolean } = {}) {
  const connectCalls: unknown[][] = [], cameraCalls: unknown[][] = [], disconnectCalls: string[] = [], scanCalls: string[] = [], removeCalls: string[] = [];
  let stops = 0;
  const track = { readyState: "live", stop() { stops++; } };
  const makeConnection = (device: MicrophoneOption): MicrophoneConnection => ({
    instanceId: MIC_ID, deviceId: device.deviceId, label: device.label,
    sampleRate: 48000, channels: 1, connected: true, error: null,
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
    analyser: { fftSize: 1024, getFloatTimeDomainData() {} } as unknown as AnalyserNode,
  });
  let changeDevices!: (devices: MicrophoneOption[]) => void;
  let changeRecording!: (value: boolean) => void;
  const sdk: AcquisitionWorkspaceProps["sdk"] = { info: null, instances: [], ports: [], busyIds: [], scanning: false, error: "",
    refresh: async () => {}, scanPorts: async () => {}, disconnect: async () => {},
    connect: async () => { throw new Error("Microphone must not call the SDK"); } };
  const camera: UseCameraCaptureResult = {
    devices: [{ deviceId: VIDEO_ID, label: "DroidCam Video" }], connections: {}, busyIds: [], scanning: false, error: "",
    scan: async () => {}, connect: async (...args) => { cameraCalls.push(args); throw new Error("Microphone must not open a camera"); },
    disconnect: async () => {}, prepareRecording: async () => [], startRecording: async () => {},
    recordingSessionId: () => null, stopRecording: async () => {}, cancelPrepared: async () => {},
  };
  function Fixture() {
    const [workspace, setWorkspace] = useState<WorkspaceState>({ version: 1, layout: "grid", cards: [
      { ...createMicrophoneCard(MIC_ID), deviceId: options.deviceId ?? (options.active ? COMPUTER.deviceId : "") },
      { ...createCameraCard("c-fixture"), deviceId: VIDEO_ID },
      ...(options.many ? Array.from({ length: 5 }, (_, index) => createSdkCard("hand-pad", `s-extra-${index}`)) : []),
    ] });
    const [devices, setDevices] = useState(options.devices ?? [COMPUTER, PHONE]);
    const [connections, setConnections] = useState<Record<string, MicrophoneConnection>>(options.active ? { [MIC_ID]: makeConnection(COMPUTER) } : {});
    const [recording, setRecording] = useState(false);
    const [paused, setPaused] = useState(false);
    changeDevices = setDevices; changeRecording = setRecording;
    const microphone: UseMicrophoneCaptureResult = {
      devices, connections, busyIds: [], scanning: false, error: "",
      scan: async () => { scanCalls.push("scan"); },
      connect: async (...args) => {
        connectCalls.push(args);
        const chosen = devices.find(item => item.deviceId === args[1]);
        if (!chosen) throw new Error("An enumerated audio input must be selected explicitly");
        const connection = makeConnection(chosen);
        setConnections(current => ({ ...current, [args[0]]: connection }));
        return connection;
      },
      disconnect: async id => {
        disconnectCalls.push(id);
        setConnections(current => { const next = { ...current }; delete next[id]; return next; });
      },
      prepareRecording: async () => [], startRecording: async () => {}, recordingSessionId: () => null,
      stopRecording: async () => {}, cancelPrepared: async () => {},
    };
    return <AcquisitionWorkspace workspace={workspace} sdk={sdk} camera={camera} microphone={microphone}
      devices={Object.values(connections).map(connection => ({ id: `microphone-${connection.instanceId}`,
        name: connection.label, kind: "audio", mode: "hardware", transport: "Browser", connected: true,
        channels: 1, sample_rate: connection.sampleRate, unit: "PCM16" }))}
      online recording={recording} busy={false} previewPaused={paused} previewConnected previewRate={15}
      onTogglePreview={() => setPaused(current => !current)}
      onAddCamera={() => {}} onAddMicrophone={() => {}} onAddSdk={() => {}} onAddSim={() => {}}
      onRemove={async id => { removeCalls.push(id); }} onLayout={() => {}}
      onUpdate={(id, patch) => setWorkspace(current => ({ ...current,
        cards: current.cards.map(card => card.id === id ? { ...card, ...patch } : card) }))} />;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Fixture />));
  const mic = () => host.querySelector<HTMLElement>(`[data-instance-id="${MIC_ID}"]`)!;
  return { host, mic, connectCalls, cameraCalls, disconnectCalls, scanCalls, removeCalls, stops: () => stops,
    select: () => mic().querySelector<HTMLSelectElement>('[aria-label="麦克风设备"]')!,
    button: (label: string) => mic().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!,
    choose: async (id: string) => { await act(async () => {
      const select = mic().querySelector<HTMLSelectElement>("select")!;
      select.value = id; select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    }); },
    openSettings: async () => { if (mic().querySelector<HTMLElement>(".workspace-config-panel")!.hidden)
      await act(async () => mic().querySelector<HTMLButtonElement>('[aria-label="展开麦克风连接设置"]')!.click()); },
    setDevices: async (devices: MicrophoneOption[]) => { await act(async () => changeDevices(devices)); },
    setRecording: async (value: boolean) => { await act(async () => changeRecording(value)); },
    dispose: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

test("microphone selection is explicit and never opens the independently selected camera", async () => {
  const view = await fixture();
  try {
    assert.equal(view.button("连接麦克风").disabled, true);
    await act(async () => view.button("连接麦克风").click());
    assert.deepEqual(view.connectCalls, []);
    await view.choose(PHONE.deviceId);
    assert.equal(view.button("连接麦克风").disabled, false);
    await act(async () => view.button("连接麦克风").click());
    assert.deepEqual(view.connectCalls, [[MIC_ID, PHONE.deviceId]]);
    assert.deepEqual(view.cameraCalls, []);
    assert.equal(view.host.querySelector<HTMLSelectElement>('[aria-label="安卓 / 系统摄像头设备"]')!.value, VIDEO_ID);
    assert.equal(view.select().disabled, true);
  } finally { await view.dispose(); }
});

test("stale microphone selections remain disconnected until the user selects an available input", async () => {
  const view = await fixture({ deviceId: "removed-audio-input" });
  try {
    assert.equal(view.select().selectedOptions[0].disabled, true);
    assert.equal(view.button("连接麦克风").disabled, true);
    await act(async () => view.button("连接麦克风").click());
    assert.deepEqual(view.connectCalls, []);
    await view.choose(COMPUTER.deviceId);
    assert.equal(view.button("连接麦克风").disabled, false);
  } finally { await view.dispose(); }
});

test("audio device discovery cannot switch an active microphone and recording locks connection changes", async () => {
  const view = await fixture({ active: true, devices: [COMPUTER] });
  try {
    const card = view.mic(), panel = card.querySelector<HTMLElement>(".workspace-config-panel")!;
    const cameraCard = view.host.querySelector('[data-instance-id="c-fixture"]')!;
    const cameraHeading = cameraCard.querySelector("header")!.textContent;
    const headerDisconnect = card.querySelector<HTMLButtonElement>('header .workspace-disconnect[aria-label="断开麦克风"]')!;
    assert.ok(headerDisconnect, "microphone can be disconnected directly from the title");
    assert.equal(panel.hidden, true);
    assert.equal(headerDisconnect.closest("[hidden]"), null);
    await view.setDevices([COMPUTER, PHONE]);
    assert.equal(view.select().value, COMPUTER.deviceId);
    assert.equal(view.select().disabled, true);
    assert.deepEqual(view.connectCalls, []);
    await view.setRecording(true);
    assert.equal(headerDisconnect.disabled, true);
    for (const label of ["断开麦克风", "检测并授权麦克风", "移除麦克风展示卡片"]) {
      assert.equal(view.button(label).disabled, true);
      await act(async () => view.button(label).click());
    }
    const pause = view.host.querySelector<HTMLButtonElement>('[aria-label="暂停预览"]')!;
    assert.equal(pause.disabled, false);
    await act(async () => pause.click());
    assert.equal(view.stops(), 0);
    assert.deepEqual(view.disconnectCalls, []);
    assert.deepEqual(view.scanCalls, []);
    await view.setRecording(false);
    await act(async () => headerDisconnect.click());
    assert.equal(view.mic(), card);
    assert.deepEqual(view.removeCalls, []);
    assert.equal(panel.hidden, false);
    assert.equal(view.select().value, COMPUTER.deviceId);
    assert.equal(view.host.querySelector('[data-instance-id="c-fixture"]'), cameraCard);
    assert.equal(cameraCard.querySelector("header")!.textContent, cameraHeading);
    assert.deepEqual(view.cameraCalls, []);
    await view.choose(PHONE.deviceId);
    await act(async () => view.button("连接麦克风").click());
    assert.deepEqual(view.disconnectCalls, [MIC_ID]);
    assert.deepEqual(view.connectCalls, [[MIC_ID, PHONE.deviceId]]);
  } finally { await view.dispose(); }
});

test("microphone preview stays visible and mounted while sensor pages change", async () => {
  const view = await fixture({ active: true, many: true });
  try {
    const canvas = view.mic().querySelector("canvas");
    assert.ok(canvas);
    const next = view.host.querySelector<HTMLButtonElement>('[aria-label="下一屏传感器"]')!;
    assert.ok(next); assert.equal(next.disabled, false);
    await act(async () => next.click());
    assert.equal(view.mic().hidden, false);
    assert.ok(view.mic().closest(".media-rail"));
    assert.equal(view.mic().querySelector("canvas"), canvas);
    assert.equal(view.stops(), 0);
    assert.deepEqual(view.disconnectCalls, []);
  } finally { await view.dispose(); }
});
