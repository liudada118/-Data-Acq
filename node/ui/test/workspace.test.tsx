import test from "node:test";
import assert from "node:assert/strict";
import { cardStreamIds, cardsFromDeviceIds, createCameraCard, createMicrophoneCard, createSdkCard, createSimCard, isCardReady, isRealCaptureDevice, mergeConnectedCards, normalizeCaptureProfile, parseWorkspace, SDK_CATALOG, workspaceStreamIds } from "../src/workspace";
import type { Device } from "../src/types";
import type { SdkInstanceInfo } from "../src/sdk-types";

function device(id: string, connected = true): Device {
  return { id, name: id, kind: id.endsWith("imu-raw") ? "imu" : "pressure", mode: "hardware", transport: "Serial", channels: 1, sample_rate: 0, unit: "ADC", connected };
}
function instance(id: string, product: SdkInstanceInfo["product"] = "hand-pad"): SdkInstanceInfo {
  return { instance_id: id, loaded: true, connected: true, has_device: true, product, path: "COM18", stream_ids: [`sdk-${id}-pressure`] };
}

test("all retired sources are removed from persisted workspaces and recording selections", () => {
  const real = { ...createSdkCard("insole", "right-insole"), path: "COM20", side: "right" as const, protocol: "8bit" as const };
  const simulated = ["sim-camera", "sim-audio", "sim-pressure", "sim-imu"].map(createSimCard);
  const mock = { ...createSdkCard("hand-pad", "old-mock"), product: "mock" as const };
  assert.deepEqual(parseWorkspace({ version: 1, layout: "stack", cards: [...simulated, mock, real] }),
    { version: 1, layout: "stack", cards: [real] });
  assert.deepEqual(workspaceStreamIds([...simulated, mock, real]), cardStreamIds(real));
  assert.deepEqual(mergeConnectedCards([...simulated, mock, real], [instance("old-mock", "mock")]), [real]);
  assert.deepEqual(cardsFromDeviceIds(["sdk-old-mock-pressure", "sim-camera"], [], [instance("old-mock", "mock")]), []);
  assert.deepEqual(mergeConnectedCards([], [instance("old-mock", "mock")]), []);
});

test("real saved hardware configuration survives a temporary mock with the same instance ID", () => {
  const real = { ...createSdkCard("hand-pad", "default"), path: "COM20", expanded: true };
  const live = { ...instance("default", "mock"), mode: "sdk-mock" };
  assert.deepEqual(mergeConnectedCards([real], [live]), [real]);
  assert.deepEqual(cardsFromDeviceIds(["sdk-pressure"], [real], [live]), [real]);
  assert.equal(isCardReady(real, [device("sdk-pressure")], [live], true), false);
  const profile = { id: "saved", name: "真实压力", device_ids: ["sdk-pressure"],
    note: "keep user metadata", workspace: { version: 1 as const, cards: [real], layout: "stack" as const } };
  assert.deepEqual(normalizeCaptureProfile(profile, [live]), profile);
});

test("profile migration drops retired selections, preserves metadata and waits for legacy SDK product evidence", () => {
  const real = { ...createMicrophoneCard("m-phone"), deviceId: "droidcam-audio" };
  const mixed = { id: "mixed", name: "用户组合", note: { experiment: "retain" }, device_ids: ["sim-audio", "microphone-m-phone"],
    workspace: { version: 1 as const, layout: "stack" as const, cards: [createSimCard("sim-audio"), real] } };
  assert.deepEqual(normalizeCaptureProfile(mixed), { ...mixed, device_ids: ["microphone-m-phone"],
    workspace: { version: 1, layout: "stack", cards: [real] } });
  assert.equal(normalizeCaptureProfile({ id: "sim", name: "退役组合", device_ids: ["sim-camera", "sim-audio", "sim-pressure", "sim-imu"] }), null);
  const legacy = { id: "legacy", name: "旧SDK", device_ids: ["sdk-old-pressure", "sim-imu"], note: "untouched" };
  const pending = normalizeCaptureProfile(legacy)!;
  assert.equal(pending.workspace, undefined);
  assert.equal(pending.note, "untouched");
  assert.equal(normalizeCaptureProfile(pending, [])?.workspace, undefined, "an empty SDK snapshot provides no product evidence");
  assert.equal(normalizeCaptureProfile(pending, [instance("old", "mock")]), null);
  const configured = normalizeCaptureProfile(legacy, [instance("old", "hand-pad")]);
  assert.deepEqual(configured?.device_ids, ["sdk-old-pressure"]);
  assert.equal(configured?.workspace?.cards[0].source, "sdk");
});

test("live device filtering and readiness exclude simulation even under plausible real stream IDs", () => {
  const real = device("sdk-real-pressure");
  const simulated = [device("sim-pressure"), { ...real, mode: "simulated" }, { ...real, mode: "sdk-mock" },
    { ...real, simulated: true }, { ...real, metadata: { product: "mock" } }];
  assert.deepEqual([real, ...simulated].filter(isRealCaptureDevice), [real]);
  for (const descriptor of simulated) assert.equal(isCardReady(createSdkCard("hand-pad", "real"), [descriptor], [instance("real")], true), false);
});

test("two cards for the same SDK product own separate recording streams", () => {
  const left = createSdkCard("hand-pad", "s-left");
  const right = createSdkCard("hand-pad", "s-right");
  const glove = createSdkCard("glove", "s-glove");
  assert.deepEqual(workspaceStreamIds([left, right, glove]), [
    "sdk-s-left-pressure", "sdk-s-right-pressure", "sdk-s-glove-pressure", "sdk-s-glove-imu-raw",
  ]);
  assert.deepEqual(cardStreamIds(createSdkCard("glove", "default")), ["sdk-pressure", "sdk-imu-raw"]);
  assert.notEqual(createSdkCard("hand-pad").id, createSdkCard("hand-pad").id);
  assert.throws(() => createSdkCard("mock"));
  assert.equal(SDK_CATALOG.some(item => item.product === "mock"), false);
});

test("corrupt storage is rejected and a saved empty workspace remains intentionally empty", () => {
  assert.equal(parseWorkspace(null), null);
  assert.equal(parseWorkspace({ version: 99, cards: [] }), null);
  assert.deepEqual(parseWorkspace({ version: 1, cards: [], layout: "grid" })?.cards, []);
  const parsed = parseWorkspace({ version: 1, layout: "stack", cards: [
    null, {}, { source: "sdk", id: "../outside", product: "hand-pad" },
    { source: "sdk", id: "s-valid", product: "glove", path: "COM18", side: "right", view: "imu", expanded: true },
    { source: "sdk", id: "s-valid", product: "mock" },
    { source: "simulation", id: "sim-camera", deviceId: "sim-camera", expanded: false },
    { source: "simulation", id: "sim-audio", deviceId: "sim-camera" },
  ] });
  assert.equal(parsed?.layout, "stack");
  assert.equal(parsed?.cards.length, 1);
  assert.deepEqual(parsed?.cards[0], { ...createSdkCard("glove", "s-valid"), path: "COM18", side: "right", view: "imu", expanded: true });
});

test("legacy selections and an already-connected COM18 device migrate into one controllable card", () => {
  const selected = cardsFromDeviceIds(["sdk-pressure", "sdk-imu-raw", "sim-camera", "sdk-pressure"]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].source, "sdk");
  assert.equal(selected[0].id, "default");
  assert.deepEqual(workspaceStreamIds(selected), ["sdk-pressure", "sdk-imu-raw"]);
  const current = mergeConnectedCards([], [{ ...instance("default"), stream_ids: ["sdk-pressure"] }]);
  assert.equal(current.length, 1);
  assert.equal(current[0].source, "sdk");
  if (current[0].source !== "sdk") throw new Error("Expected SDK card");
  assert.equal(current[0].path, "COM18");
  assert.equal(current[0].id, "default");
  assert.equal(mergeConnectedCards(current, [{ ...instance("default"), stream_ids: ["sdk-pressure"] }]).length, 1);
});

test("glove cards require both streams and a healthy matching connection before recording", () => {
  const card = createSdkCard("glove", "s-glove");
  const streams = cardStreamIds(card).map(id => device(id));
  const live = instance("s-glove", "glove");
  assert.equal(isCardReady(card, streams, [live], true), true);
  assert.equal(isCardReady(card, streams.slice(0, 1), [live], true), false);
  assert.equal(isCardReady(card, streams, [live], false), false);
  assert.equal(isCardReady(card, streams, [{ ...live, error: "disconnected" }], true), false);
  assert.equal(isCardReady(card, streams, [{ ...live, connecting: true }], true), false);
  assert.equal(isCardReady(card, streams, [{ ...live, product: "mock" }], true), false);
  assert.equal(isCardReady(card, streams.map(item => ({ ...item, connected: false })), [live], true), false);
});

test("workspace restoration keeps display settings but never restores connection ownership", () => {
  const original = { ...createSdkCard("glove", "glove-a"), path: "COM18", side: "right", view: "imu", expanded: true, connected: true, secret: "must-not-persist" };
  const restored = parseWorkspace({ version: 1, layout: "stack", cards: [original] });
  assert.deepEqual(restored?.cards[0], { id: "glove-a", source: "sdk", product: "glove", path: "COM18", side: "right", gloveProtocol: "segmented", view: "imu", expanded: true });
  assert.equal(isCardReady(restored!.cards[0], [], [], true), false);
});

test("profile migration retains configured ports and closed SDK instances do not reappear", () => {
  const existing = { ...createSdkCard("glove", "hand-one"), path: "COM20", side: "right" as const };
  const migrated = cardsFromDeviceIds(["sdk-hand-one-pressure", "sdk-hand-one-imu-raw", "sim-imu"], [existing]);
  assert.deepEqual(migrated, [existing]);
  const merged = mergeConnectedCards(migrated, [{ ...instance("closed-card"), connected: false, has_device: false }]);
  assert.deepEqual(merged, migrated);
  assert.deepEqual(migrated[0], existing);
});

test("camera cards have independent recording streams and retain saved device selections", () => {
  const first = { ...createCameraCard("c-phone"), deviceId: "system-phone-id", quality: "1080p" as const, expanded: true };
  const second = createCameraCard("c-usb");
  assert.notEqual(createCameraCard().id, createCameraCard().id);
  assert.deepEqual(workspaceStreamIds([first, second, createSimCard("sim-camera")]), ["camera-c-phone", "camera-c-usb"]);
  assert.deepEqual(cardsFromDeviceIds(["camera-c-phone", "camera-c-usb", "camera-c-phone", "sim-camera"], [first]), [first, second]);
  assert.deepEqual(cardsFromDeviceIds(["camera-../outside", "camera-default", "camera-c-", "camera-c-a/other"]), []);
  assert.throws(() => createCameraCard("../outside"));
});

test("version 1 camera storage validates configuration and drops live objects and secrets", () => {
  const camera = { ...createCameraCard("c-saved"), deviceId: "browser-device-id", quality: "1080p" as const, expanded: true };
  const parsed = parseWorkspace({ version: 1, layout: "grid", cards: [
    { ...camera, connected: true, stream: { active: true }, token: "must-not-persist" },
    { ...camera, id: "c-invalid-quality", quality: "8k" },
    { ...camera, id: "c-invalid-device", deviceId: { unsafe: true } },
    { ...camera, id: "c-too-long", deviceId: "x".repeat(1025) },
    { ...camera, id: "../outside" },
    { ...camera, id: "c-saved", deviceId: "duplicate" },
    createSdkCard("hand-pad", "s-existing"), createSimCard("sim-camera"),
  ] });
  assert.deepEqual(parsed?.cards, [camera, createSdkCard("hand-pad", "s-existing")]);
  assert.deepEqual(parseWorkspace(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.equal(isCardReady(parsed!.cards[0], [], [], true), false);
});

test("camera readiness needs its connected descriptor and SDK migration does not replace camera cards", () => {
  const camera = createCameraCard("c-phone");
  const descriptor = { ...device("camera-c-phone"), kind: "camera" as const, transport: "Browser MediaStream" };
  assert.equal(isCardReady(camera, [descriptor], [], true), true);
  assert.equal(isCardReady(camera, [descriptor], [], false), false);
  assert.equal(isCardReady(camera, [{ ...descriptor, connected: false }], [], true), false);
  assert.equal(isCardReady(camera, [device("sim-camera")], [], true), false);
  assert.deepEqual(mergeConnectedCards([camera], [instance("s-pad")]), [camera, { ...createSdkCard("hand-pad", "s-pad"), path: "COM18" }]);
  assert.deepEqual(mergeConnectedCards([camera], [instance("c-phone")]), [camera]);
});

test("microphones remain independent from camera and real SDK selections across profiles", () => {
  const phone = { ...createMicrophoneCard("m-phone"), deviceId: "droidcam-audio", expanded: true };
  const desktop = { ...createMicrophoneCard("m-desktop"), deviceId: "computer-microphone" };
  const camera = { ...createCameraCard("c-phone"), deviceId: "droidcam-video" };
  const cards = [phone, desktop, camera, createSdkCard("hand-pad", "s-pressure")];
  const ids = ["microphone-m-phone", "microphone-m-desktop", "camera-c-phone", "sdk-s-pressure-pressure"];
  assert.deepEqual(workspaceStreamIds(cards), ids);
  assert.deepEqual(cardsFromDeviceIds([...ids, ids[0]], cards), cards);
  assert.deepEqual(cardsFromDeviceIds(["microphone-m-new"]), [createMicrophoneCard("m-new")]);
  assert.notEqual(createMicrophoneCard().id, createMicrophoneCard().id);
  assert.deepEqual(mergeConnectedCards([phone], [instance("m-phone")]), [phone]);
  assert.deepEqual(cardsFromDeviceIds(["microphone-default", "microphone-c-phone", "microphone-m-../outside"]), []);
});

test("microphone restoration persists only safe configuration and requires its own live descriptor", () => {
  const microphone = { ...createMicrophoneCard("m-saved"), deviceId: "audio-input", expanded: true };
  const restored = parseWorkspace({ version: 1, layout: "stack", cards: [
    { ...microphone, connected: true, analyser: { active: true }, stream: {}, token: "must-not-persist" },
    { ...microphone, id: "m-invalid", deviceId: {} },
    { ...microphone, id: "m-long", deviceId: "x".repeat(1025) },
    { ...microphone, id: "c-wrong-source" },
    { ...microphone, id: "../outside" },
    { ...microphone, deviceId: "duplicate" },
  ] });
  assert.deepEqual(restored, { version: 1, layout: "stack", cards: [microphone] });
  const descriptor = { ...device("microphone-m-saved"), kind: "audio" as const };
  assert.equal(isCardReady(microphone, [descriptor], [], true), true);
  assert.equal(isCardReady(microphone, [descriptor], [], false), false);
  assert.equal(isCardReady(microphone, [{ ...descriptor, connected: false }], [], true), false);
  assert.equal(isCardReady(microphone, [device("camera-c-saved"), device("sim-audio")], [], true), false);
  assert.equal(isCardReady(restored!.cards[0], [], [], true), false);
});

test("new sensor configurations survive restoration, profile switches and active connection adoption", () => {
  const insole = { ...createSdkCard("insole", "right-foot"), path: "COM_TEST", side: "right" as const,
    protocol: "8bit" as const, baudRate: 1500000 as const, view: "imu" as const };
  const body = createSdkCard("body", "body-sensor");
  assert.deepEqual(cardStreamIds(insole), ["sdk-right-foot-pressure", "sdk-right-foot-imu-raw"]);
  assert.deepEqual(cardStreamIds(body), ["sdk-body-sensor-pressure"]);
  const restored = parseWorkspace({ version: 1, cards: [insole, body], layout: "grid" })!;
  assert.deepEqual(restored.cards, [insole, body]);
  assert.deepEqual(cardsFromDeviceIds(workspaceStreamIds(restored.cards), restored.cards), restored.cards,
    "shoe IMU stream must not reinterpret the shoe as a glove");
  const adopted = mergeConnectedCards([], [{ ...instance("right-foot", "insole"), ready: true,
    path: "COM_TEST", side: "right", protocol: "8bit", baudRate: 1500000 }]);
  assert.deepEqual(adopted[0], { ...insole, view: "primary" });
  const invalid = parseWorkspace({ version: 1, cards: [
    { ...insole, id: "bad-protocol", protocol: "auto" },
    { ...insole, id: "bad-baud", baudRate: 1000000 },
  ] });
  assert.deepEqual(invalid?.cards, []);
});

test("body and insole cannot record until a valid mapped first frame makes them ready", () => {
  for (const product of ["body", "insole"] as const) {
    const card = createSdkCard(product, `new-${product}`);
    const streams = cardStreamIds(card).map(id => device(id));
    const live = instance(card.id, product);
    assert.equal(isCardReady(card, streams, [live], true), false);
    assert.equal(isCardReady(card, streams, [{ ...live, ready: false }], true), false);
    assert.equal(isCardReady(card, streams, [{ ...live, ready: true }], true), true);
    if (product === "insole") assert.equal(isCardReady(card, streams.slice(0, 1), [{ ...live, ready: true }], true), false);
  }
});

test("glove protocol defaults migrate safely and a live connection supplies its actual protocol", () => {
  const glove = createSdkCard("glove", "left-glove");
  assert.equal(glove.gloveProtocol, "segmented");
  const oldCard = { ...glove, gloveProtocol: undefined };
  const legacyCard = { ...glove, id: "legacy-glove", gloveProtocol: "full-packet" as const };
  const restored = parseWorkspace({ version: 1, cards: [oldCard, legacyCard] })!;
  assert.deepEqual(restored.cards, [glove, legacyCard]);
  assert.deepEqual(cardsFromDeviceIds(workspaceStreamIds(restored.cards), restored.cards), restored.cards);
  assert.deepEqual(parseWorkspace({ version: 1, cards: [
    { ...glove, gloveProtocol: "12bit" }, { ...glove, id: "invalid-glove", gloveProtocol: "auto" },
  ] })?.cards, []);

  const adopted = mergeConnectedCards([glove], [{ ...instance(glove.id, "glove"), protocol: "full-packet", baudRate: 921600 }]);
  assert.deepEqual(adopted, [{ ...glove, path: "COM18", gloveProtocol: "full-packet" }]);
  assert.deepEqual(mergeConnectedCards([], [{ ...instance("segmented-glove", "glove"), protocol: "segmented" }]),
    [{ ...createSdkCard("glove", "segmented-glove"), path: "COM18" }]);
  assert.equal((mergeConnectedCards([legacyCard], [{ ...instance(legacyCard.id, "glove"), protocol: "12bit" }])[0] as typeof legacyCard).gloveProtocol,
    "full-packet", "insole format must never become a glove protocol");
});
