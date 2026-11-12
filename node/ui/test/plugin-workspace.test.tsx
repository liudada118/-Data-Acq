import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { AcquisitionWorkspace } from "../src/AcquisitionWorkspace";
import type { AcquisitionWorkspaceProps } from "../src/AcquisitionWorkspace";
import { createPluginCard, cardStreamIds, parseWorkspace, isCardReady, normalizeCaptureProfile, pluginCardMatchesManifest } from "../src/workspace";
import { SdkAgentWorkbench } from "../src/SdkAgentWorkbench";
import type { SensorPlugin } from "../src/plugin-types";
import { usePluginConnections } from "../src/usePluginConnections";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
const { createRoot } = await import("react-dom/client");
const plugin: SensorPlugin = { id: "fixture-camera", name: "测试 SDK 相机", version: "1.0.0", entry: "adapter.mjs",
  config_fields: [{ key: "serial", label: "设备序列号", type: "string", required: true }],
  streams: [{ id: "rgb", name: "RGB 图像", kind: "camera" }, { id: "pressure", name: "压力", kind: "pressure" }] };
const stereoPlugin: SensorPlugin = { ...plugin, id: "fixture-stereo", name: "测试双目相机", streams: [
  { id: "rgb_left", name: "左目 RGB 图像", kind: "camera" },
  { id: "rgb_right", name: "右目 RGB 图像", kind: "camera" },
] };

test("stereo preview defaults migrate existing cards without changing recorded stream selection", () => {
  const card = createPluginCard(stereoPlugin, "p-stereo-settings");
  assert.equal(card.previewMode, "cameras");
  const originalIds = cardStreamIds(card);
  assert.deepEqual(originalIds, ["plugin-p-stereo-settings-rgb_left", "plugin-p-stereo-settings-rgb_right"]);
  const legacy = { ...card, previewMode: undefined, selectedStream: "rgb_right" };
  const migrated = parseWorkspace({ version: 1, cards: [legacy], layout: "grid" })!.cards[0];
  assert.equal(migrated.source, "plugin");
  if (migrated.source !== "plugin") throw new Error("Expected plugin card");
  assert.equal(migrated.previewMode, "cameras", "old saved cards should expose both eyes after upgrade");
  const single = { ...migrated, previewMode: "single" as const };
  const restored = parseWorkspace({ version: 1, cards: [single], layout: "grid" })!.cards[0];
  assert.deepEqual(restored, single, "an explicit single-eye preference must survive reload");
  assert.deepEqual(cardStreamIds(restored), originalIds, "preview choice must never remove an eye from unified recording");
  const mixed = createPluginCard(plugin, "p-mixed-settings");
  assert.equal(mixed.previewMode, "single", "one camera plus pressure retains existing stream tabs");
});

test("camera pane layout and split survive reload with bounded legacy defaults", () => {
  const card = createPluginCard(stereoPlugin, "p-camera-layout");
  const restore = (patch: Record<string, unknown>) => {
    const result = parseWorkspace({ version: 1, cards: [{ ...card, ...patch }], layout: "grid" })!.cards[0];
    if (result.source !== "plugin") throw new Error("Expected plugin card");
    return result;
  };
  const changed = restore({ cameraLayout: "vertical", cameraSplit: 0.72 });
  assert.equal(changed.cameraLayout, "vertical");
  assert.equal(changed.cameraSplit, 0.72);
  assert.deepEqual(cardStreamIds(changed), cardStreamIds(card), "pane layout does not change recorded streams");
  assert.deepEqual(restore({ cameraLayout: undefined, cameraSplit: undefined }), card);
  assert.equal(restore({ cameraLayout: "bad", cameraSplit: NaN }).cameraLayout, "auto");
  assert.equal(restore({ cameraSplit: Infinity }).cameraSplit, 0.5);
  assert.equal(restore({ cameraSplit: "0.7" }).cameraSplit, 0.5);
  assert.equal(restore({ cameraSplit: -2 }).cameraSplit, 0.2);
  assert.equal(restore({ cameraSplit: 7 }).cameraSplit, 0.8);
});

test("stereo card displays both live eyes and toggles single-eye preview without reconnecting", async t => {
  let card = createPluginCard(stereoPlugin, "p-stereo-view");
  const mutations: unknown[] = [];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const devices = stereoPlugin.streams.map(stream => ({ id: `plugin-${card.id}-${stream.id}`, name: stream.name,
    kind: stream.kind, transport: "sdk-plugin", sample_rate: 30, channels: 3, unit: "MJPEG", mode: "sdk-plugin", connected: true }));
  const props = {
    workspace: { version: 1, cards: [card], layout: "grid" }, devices,
    sdk: { info: { loaded: true }, instances: [], ports: [], busyIds: [], scanning: false },
    camera: { devices: [], connections: {}, busyIds: [], scanning: false },
    plugins: { plugins: [stereoPlugin], instances: [{ instance_id: card.id, plugin_id: stereoPlugin.id, connected: true,
      stream_ids: cardStreamIds(card), received_records: 60 }], busyIds: [], error: "",
      connect: async (...args: unknown[]) => { mutations.push(args); }, disconnect: async (...args: unknown[]) => { mutations.push(args); }, refresh: async () => {} },
    onAddSdk: () => {}, onAddCamera: () => {}, onAddPlugin: () => {}, onRemove: async () => {},
    onUpdate: (_id: string, patch: Partial<typeof card>) => { card = { ...card, ...patch }; }, onLayout: () => {},
    online: true, recording: false, busy: false, previewPaused: false, previewConnected: true, previewRate: 5,
    onTogglePreview: () => {}, cardContentFullscreen: true,
  } as unknown as AcquisitionWorkspaceProps;
  const render = async () => act(async () => root.render(<AcquisitionWorkspace {...props} workspace={{ version: 1, cards: [card], layout: "grid" }} />));
  const article = () => host.querySelector('[data-instance-id="p-stereo-view"]')!;
  const button = (name: string) => [...article().querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!;
  await render();
  assert.equal(article().querySelectorAll(".workspace-camera-feed").length, 2);
  for (const stream of stereoPlugin.streams) {
    const feed = article().querySelector(`.workspace-camera-feed[data-stream-id="plugin-${card.id}-${stream.id}"]`)!;
    assert.ok(feed, `missing independent ${stream.id} panel`);
    assert.ok(feed.textContent!.includes(stream.name), "each eye needs a visible name in the compact workspace");
    assert.match(feed.querySelector("canvas")!.getAttribute("aria-label")!, new RegExp(stream.name));
  }
  assert.equal(button("双目同屏").getAttribute("aria-pressed"), "true");
  await act(async () => button("右目 RGB 图像").click()); await render();
  assert.equal(card.previewMode, "single"); assert.equal(card.selectedStream, "rgb_right");
  assert.equal(article().querySelectorAll("canvas").length, 1);
  assert.match(article().querySelector("canvas")!.getAttribute("aria-label")!, /右目 RGB 图像/);
  assert.deepEqual(cardStreamIds(card), devices.map(device => device.id));
  await act(async () => button("双目同屏").click()); await render();
  assert.equal(card.previewMode, "cameras"); assert.equal(article().querySelectorAll(".workspace-camera-feed canvas").length, 2);
  assert.deepEqual(mutations, [], "preview changes must not reconnect or disconnect either eye");
});

test("a missing stereo eye keeps its own placeholder instead of reusing the available eye", async t => {
  const card = createPluginCard(stereoPlugin, "p-stereo-partial");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const leftId = `plugin-${card.id}-rgb_left`, rightId = `plugin-${card.id}-rgb_right`;
  const props = { workspace: { version: 1, cards: [card], layout: "grid" },
    devices: [{ id: leftId, name: "左目 RGB 图像", kind: "camera", transport: "sdk-plugin", sample_rate: 30,
      channels: 3, unit: "MJPEG", mode: "sdk-plugin", connected: true }],
    sdk: { info: { loaded: true }, instances: [], ports: [], busyIds: [], scanning: false },
    camera: { devices: [], connections: {}, busyIds: [], scanning: false },
    plugins: { plugins: [stereoPlugin], instances: [{ instance_id: card.id, plugin_id: stereoPlugin.id, connected: true,
      stream_ids: [leftId, rightId], received_records: 1 }], busyIds: [], error: "", connect: async () => {}, disconnect: async () => {}, refresh: async () => {} },
    onAddSdk: () => {}, onAddCamera: () => {}, onAddPlugin: () => {}, onRemove: async () => {}, onUpdate: () => {}, onLayout: () => {},
    online: true, recording: false, busy: false, previewPaused: false, previewConnected: true, previewRate: 5,
    onTogglePreview: () => {}, cardContentFullscreen: true,
  } as unknown as AcquisitionWorkspaceProps;
  await act(async () => root.render(<AcquisitionWorkspace {...props} />));
  const article = host.querySelector('[data-instance-id="p-stereo-partial"]')!;
  const left = article.querySelector(`.workspace-camera-feed[data-stream-id="${leftId}"]`)!;
  const right = article.querySelector(`.workspace-camera-feed[data-stream-id="${rightId}"]`)!;
  assert.ok(left); assert.ok(right);
  assert.equal(left.querySelectorAll("canvas").length, 1, "the available eye remains independently viewable");
  assert.equal(right.querySelectorAll("canvas").length, 0, "no left-image fallback is allowed for a missing right eye");
  assert.match(right.textContent!, /右目 RGB 图像/);
  assert.match(right.textContent!, /等待|未连接|暂无|无数据/);
  assert.equal(isCardReady(card, props.devices, [], true), false, "partial stereo delivery is not ready for unified recording");
});

test("plugin cards persist distinct stream selection/configuration and require every live stream before unified recording", () => {
  const first = { ...createPluginCard(plugin, "p-one"), config: { serial: "camera-123" }, selectedStream: "pressure" };
  const second = createPluginCard(plugin, "p-two");
  const ids = cardStreamIds(first);
  assert.deepEqual(ids, ["plugin-p-one-rgb", "plugin-p-one-pressure"]);
  assert.notDeepEqual(ids, cardStreamIds(second));
  const restored = parseWorkspace({ version: 1, cards: [first], layout: "grid" });
  assert.deepEqual(restored?.cards, [first]);
  const profile = normalizeCaptureProfile({ id: "saved-plugin", name: "相机组合", device_ids: [], workspace: restored });
  assert.deepEqual(profile?.device_ids, ids);
  const devices = ids.map((id, index) => ({ id, name: id, kind: plugin.streams[index].kind, transport: "sdk-plugin", sample_rate: 0, channels: 3,
    unit: "", mode: "sdk-plugin", connected: true }));
  assert.equal(isCardReady(first, [], [], true), false);
  assert.equal(isCardReady(first, devices.slice(0, 1), [], true), false);
  assert.equal(isCardReady(first, devices, [], true), true);
  assert.equal(isCardReady(first, devices, [], false), false);
  assert.equal(pluginCardMatchesManifest(first, plugin), true);
  assert.equal(pluginCardMatchesManifest(first, { ...plugin, streams: [...plugin.streams, { id: "depth", name: "深度", kind: "camera" }] }), false);
  assert.deepEqual(parseWorkspace({ version: 1, cards: [{ ...first, streams: [null] }] })?.cards, []);
});

test("installed plugins appear in sensor catalog and card connection invokes its plugin rather than SHROOM", async t => {
  const card = { ...createPluginCard(plugin, "p-live"), config: { serial: "camera-123" } };
  const calls: unknown[] = [];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const props = { workspace: { version: 1, cards: [card], layout: "grid" }, devices: [],
    sdk: { info: { loaded: true }, instances: [], ports: [], busyIds: [], scanning: false, scanPorts: async () => {}, connect: () => { throw new Error("Must not use SHROOM"); } },
    camera: { devices: [], connections: {}, busyIds: [], scanning: false },
    plugins: { plugins: [plugin], instances: [], busyIds: [], error: "", connect: async (...args: unknown[]) => { calls.push(args); }, disconnect: async () => {}, refresh: async () => {} },
    onAddSdk: () => {}, onAddCamera: () => {}, onAddPlugin: () => {}, onRemove: async () => {}, onUpdate: () => {}, onLayout: () => {},
    online: true, recording: false, busy: false, previewPaused: false, previewConnected: true, previewRate: 5, onTogglePreview: () => {},
  } as unknown as AcquisitionWorkspaceProps;
  await act(async () => root.render(<AcquisitionWorkspace {...props} />));
  assert.ok(host.querySelector('[aria-label="添加测试 SDK 相机"]'));
  const article = host.querySelector('[data-instance-id="p-live"]')!;
  assert.equal(article.querySelector<HTMLInputElement>('input')?.value, "camera-123");
  const connect = [...article.querySelectorAll("button")].find(button => button.textContent === "连接")!;
  await act(async () => connect.click());
  assert.deepEqual(calls, [[plugin.id, card.id, card.config]]);
  await act(async () => root.render(<AcquisitionWorkspace {...props} recording />));
  assert.equal([...article.querySelectorAll("button")].find(button => button.textContent === "连接")!.disabled, true);
  await act(async () => root.render(<AcquisitionWorkspace {...props} plugins={{ ...props.plugins!, plugins: [{ ...plugin, streams: [plugin.streams[0]] }] }} />));
  assert.equal([...article.querySelectorAll("button")].find(button => button.textContent === "连接")!.disabled, true);
  assert.match(article.textContent!, /插件数据流已更新/);
});

test("malformed generated field definitions remain viewable and cannot crash the workbench", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete window.synapseDesktop; });
  const examples = [JSON.stringify({ config_fields: "oops" }), JSON.stringify({ config_fields: [null] }),
    JSON.stringify({ config_fields: [{ key: "serial", label: { unsafe: "object" }, type: "string" }] }),
    JSON.stringify({ config_fields: [{ key: "serial", label: "Serial", type: "string", default: {} }] }),
    JSON.stringify({ config_fields: [{ key: "serial", label: "Serial", type: { toString: "invalid" } }] }), "null", "{ incomplete"];
  for (const [index, source] of examples.entries()) {
    const state = { id: `sdk-malformed-${index}`, name: "Malformed draft", status: "draft", updated_at: "2026-11-10", files: [], messages: [],
      draft: { revision: "edited", files: [{ path: "plugin.json", size: source.length }, { path: "adapter.mjs", size: 1 }] },
      installed: { plugin_id: plugin.id, name: plugin.name, version: "1.0.0", revision: "previous", installed_at: "2026-11-09", hardware_verified: false } };
    window.synapseDesktop = { onBeforeClose: () => () => {}, integration: {
      chooseSdkDirectory: async () => state,
      modelSettings: { get: async () => ({ baseUrl: "", model: "", hasKey: false }), save: async () => ({ baseUrl: "", model: "", hasKey: false }) },
      invoke: async (action, args) => action === "list" ? { workspaces: [state] } : action === "readDraft" ?
        { path: args?.path, content: args?.path === "plugin.json" ? source : "// draft" } : state,
    } };
    await act(async () => root.render(<SdkAgentWorkbench key={index} recording={false} onInstalled={async () => {}} onCapture={() => {}} />));
    assert.equal(host.querySelector(".sdk-draft-code")?.textContent, source);
    assert.ok(host.querySelector('.sdk-review [role="status"]'), "draft schema errors must render inline");
    assert.equal(host.querySelectorAll(".sdk-test-config input").length, 0);
    assert.match(host.querySelector(".sdk-installed")!.textContent!, /本次草稿尚未安装/);
    assert.equal([...host.querySelectorAll("button")].find(button => button.textContent === "安装传感器")!.disabled, true);
  }
});

test("desktop Agent UI completes import, conversation, draft review, test and installation", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete window.synapseDesktop; });
  const calls: string[] = [];
  let imported = false, installed = 0;
  let state: Record<string, unknown> = { id: "sdk-chat-fixture", name: "SDK conversation", status: "imported", updated_at: "2026-11-10", files: [{ path: "README.md", size: 16, text: true }], messages: [], draft: { revision: "import", files: [] } };
  window.synapseDesktop = { onBeforeClose: () => () => {}, integration: {
    chooseSdkDirectory: async () => { imported = true; calls.push("import"); return state; },
    modelSettings: { get: async () => ({ baseUrl: "https://example.invalid/v1", model: "fixture", hasKey: true }), save: async () => ({ baseUrl: "", model: "", hasKey: true }) },
    invoke: async (action, args) => {
      calls.push(action);
      if (action === "list") return { workspaces: imported ? [state] : [] };
      if (action === "chat") {
        assert.equal(args?.message, "接入 RGB 与压力数据");
        state = { ...state, status: "draft", messages: [{ id: "u1", role: "user", content: args.message }, { id: "a1", role: "assistant", content: "适配器已生成，请检查并测试。" }],
          generation: { source: "agent", model: "fixture", revision: "generated", updated_at: "2026-11-11" },
          draft: { revision: "generated", files: [{ path: "plugin.json", size: 150 }, { path: "adapter.mjs", size: 40 }] } };
      }
      if (action === "readDraft") return { path: args?.path, content: args?.path === "plugin.json" ? JSON.stringify(plugin) : "export async function createAdapter() {}" };
      if (action === "test") state = { ...state, status: "tested", test: { passed: true, revision: "generated", hardware_verified: false,
        checks: [{ name: "接口检查", passed: true, message: "probe 完成" }], tested_at: "2026-11-10" } };
      if (action === "install") state = { ...state, status: "installed", installed: { plugin_id: plugin.id, name: plugin.name, version: plugin.version, revision: "generated", installed_at: "2026-11-10", hardware_verified: false } };
      return state;
    },
  } };
  await act(async () => root.render(<SdkAgentWorkbench recording={false} onInstalled={async () => { installed++; }} onCapture={() => {}} />));
  const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text)!;
  await act(async () => button("导入 SDK 文件夹").click());
  assert.match(host.textContent!, /SDK conversation/);
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "接入 RGB 与压力数据");
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(button("发送").disabled, false);
  await act(async () => { textarea.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.ok(calls.includes("chat")); assert.match(host.textContent!, /适配器已生成/);
  assert.match(host.textContent!, /内置 Agent 生成 · fixture/);
  assert.match(host.querySelector(".sdk-draft-code")!.textContent!, /fixture-camera/);
  await act(async () => button("适配代码").click());
  assert.match(host.querySelector(".sdk-draft-code")!.textContent!, /createAdapter/);
  await act(async () => button("测试适配器").click());
  assert.match(host.textContent!, /probe 完成/);
  await act(async () => button("安装传感器").click());
  assert.equal(installed, 1); assert.match(host.textContent!, /本次草稿已安装/);
  assert.ok(button("去选择并采集"));
});

test("Agent workbench requires desktop and installs only the currently tested revision", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete window.synapseDesktop; });
  await act(async () => root.render(<SdkAgentWorkbench recording={false} onInstalled={async () => {}} onCapture={() => {}} />));
  assert.match(host.textContent!, /在桌面软件中接入 SDK/);
  let installed = 0;
  const calls: string[] = [];
  let state = { id: "sdk-ui-fixture", name: "Camera SDK", created_at: "2026-11-10", updated_at: "2026-11-10", status: "draft", files: [{ path: "README.md", size: 8, text: true }], messages: [],
    draft: { revision: "v2", files: [{ path: "plugin.json", size: 150 }, { path: "adapter.mjs", size: 40 }] },
    test: { passed: true, revision: "v1", checks: [], hardware_verified: false, tested_at: "2026-11-10" } };
  window.synapseDesktop = { onBeforeClose: () => () => {}, integration: {
    modelSettings: { get: async () => ({ baseUrl: "https://example.invalid/v1", model: "fixture", hasKey: true }), save: async () => ({ baseUrl: "", model: "", hasKey: true }) },
    chooseSdkDirectory: async () => state,
    invoke: async (action, args) => {
      calls.push(action);
      if (action === "list") return { workspaces: [state] };
      if (action === "readDraft") return { path: args?.path, content: args?.path === "plugin.json" ? JSON.stringify(plugin) : "export async function createAdapter() {}" };
      if (action === "test") state = { ...state, status: "tested", test: { ...state.test, revision: "v2" } };
      return state;
    },
  } };
  await act(async () => root.render(<SdkAgentWorkbench recording={false} onInstalled={async () => { installed++; }} onCapture={() => {}} />));
  const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text)!;
  assert.equal(button("安装传感器").disabled, true, "a previous successful test must not approve edited code");
  await act(async () => button("测试适配器").click());
  assert.equal(button("安装传感器").disabled, false);
  await act(async () => button("安装传感器").click());
  assert.equal(installed, 1); assert.ok(calls.includes("test")); assert.ok(calls.includes("install"));
});

test("SDK import keeps long operations visibly busy and preserves actionable errors without the Electron IPC envelope", async t => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete window.synapseDesktop; });
  let failure = new Error("");
  let held: Promise<null> | null = null, importCalls = 0;
  window.synapseDesktop = { onBeforeClose: () => () => {}, integration: {
    modelSettings: { get: async () => ({ baseUrl: "", model: "", hasKey: false }), save: async () => ({ baseUrl: "", model: "", hasKey: false }) },
    chooseSdkDirectory: async () => { importCalls++; if (held) return held; throw failure; },
    invoke: async () => ({ workspaces: [] }),
  } };
  await act(async () => root.render(<SdkAgentWorkbench recording={false} onInstalled={async () => {}} onCapture={() => {}} />));
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === "导入 SDK 文件夹")!;
  const message = "SDK 超过导入限制：Tools/camera-driver.exe（3 GiB），单文件上限 2 GiB。\n请检查该文件。";
  for (const [incoming, expected] of [
    [`Error invoking remote method 'integration:choose-sdk': Error: ${message}`, message],
    [`Error invoking remote method \"integration:invoke\": ${message}`, message],
    ["读取文件失败：Docs/协议.docx；Error: 文件被占用。", "读取文件失败：Docs/协议.docx；Error: 文件被占用。"],
  ]) {
    failure = new Error(incoming);
    await act(async () => button.click());
    assert.equal(host.querySelector('[role="alert"]')?.textContent, expected);
    assert.equal(button.disabled, false, "failed import must remain retryable");
  }
  const imported = Promise.withResolvers<null>(); held = imported.promise;
  await act(async () => button.click());
  assert.equal(button.textContent, "正在校验并导入…");
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.disabled, true); assert.ok(button.querySelector(".spin"));
  assert.match(button.title, /8 GiB.*2 GiB.*10,000/);
  const pendingCalls = importCalls;
  await act(async () => button.click()); assert.equal(importCalls, pendingCalls, "pending import must not submit again");
  await act(async () => imported.resolve(null));
  assert.equal(button.textContent, "导入 SDK 文件夹"); assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), "false");
});

test("plugin connection hook sends API contract and rejects connection mutations during recording", async t => {
  const previousFetch = globalThis.fetch;
  const calls: { route: string; body?: unknown }[] = [];
  let instances: { instance_id: string; plugin_id: string; connected: boolean; stream_ids: string[] }[] = [];
  globalThis.fetch = (async (url, options) => {
    const route = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ route, body });
    if (route === "/api/plugins/connect") instances = [{ instance_id: body.instance_id, plugin_id: body.plugin_id, connected: true, stream_ids: ["plugin-p-hook-rgb"] }];
    if (route === "/api/plugins/disconnect") instances = [];
    return new Response(JSON.stringify(route === "/api/plugins/catalog" ? { plugins: [plugin], instances } : instances[0] ?? {}), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let hook!: ReturnType<typeof usePluginConnections>;
  function Harness({ recording }: { recording: boolean }) {
    hook = usePluginConnections({ online: true, recording, onDevicesChanged: async () => {} }); return null;
  }
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; });
  await act(async () => root.render(<Harness recording={false} />));
  await act(async () => hook.connect(plugin.id, "p-hook", { serial: "camera-1" }));
  assert.deepEqual(calls.find(call => call.route === "/api/plugins/connect")?.body,
    { plugin_id: plugin.id, instance_id: "p-hook", config: { serial: "camera-1" } });
  assert.equal(hook.instances[0].connected, true);
  await act(async () => root.render(<Harness recording />));
  await assert.rejects(hook.disconnect("p-hook"), /停止采集/);
  assert.equal(calls.filter(call => call.route === "/api/plugins/disconnect").length, 0);
  await act(async () => root.render(<Harness recording={false} />));
  await act(async () => hook.disconnect("p-hook"));
  assert.deepEqual(hook.instances, []);
});
