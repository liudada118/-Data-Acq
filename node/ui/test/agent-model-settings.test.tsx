import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { AgentModelSettingsPanel } from "../src/AgentModelSettingsPanel";
import type { AgentModelCatalog, AgentModelSettings, AgentModelSettingsInput, DesktopIntegration } from "../src/desktop";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const catalog: AgentModelCatalog = { schemaVersion: 1, version: "fixture", source: "remote", updatedAt: 1,
  providers: [
    { id: "first", label: "第一服务", baseUrl: "https://first.example/v1", defaultModel: "first-small", models: [{ id: "first-small", label: "First small" }, { id: "first-large", label: "First large" }] },
    { id: "second", label: "第二服务", baseUrl: "https://second.example/v1", defaultModel: "second-model", models: [{ id: "second-model", label: "Second model" }] },
    { id: "custom", label: "自定义地址／中转站", baseUrl: "", defaultModel: "custom-default", models: [{ id: "custom-default", label: "Custom default" }] },
  ] };
const stored: AgentModelSettings = { baseUrl: "https://custom.example/v1", model: "my-private-model", hasKey: true };
const select = (host: HTMLElement, label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const input = (host: HTMLElement, label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll("button")].find(item => item.textContent === name)!;
async function changeSelect(element: HTMLSelectElement, value: string) {
  await act(async () => { element.value = value; element.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
}
async function changeInput(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function mount(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never, api: DesktopIntegration["modelSettings"], settings = stored) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  (t as unknown as { after: (cleanup: () => Promise<void>) => void }).after(async () => { await act(async () => root.unmount()); host.remove(); });
  const props = { settings, api, disabled: false, onSaved: () => {}, onClose: () => {} };
  await act(async () => root.render(<AgentModelSettingsPanel {...props} />));
  return { host, root, props };
}

test("catalog refresh uses the Shroom bridge and preserves edited URL, model and unsaved key without saving", async t => {
  const calls: unknown[] = [], saves: AgentModelSettingsInput[] = [];
  const api = { get: async () => stored, save: async (value: AgentModelSettingsInput) => { saves.push(value); return stored; },
    catalog: async (options?: { refresh?: boolean }) => { calls.push(options); return { ...catalog, source: calls.length === 1 ? "remote" as const : "cache" as const, warning: calls.length > 1 ? "已保留最近目录" : undefined }; } };
  const { host } = await mount(t as never, api);
  assert.deepEqual(calls, [{ refresh: false }]);
  assert.match(host.textContent!, /已从 Shroom 接口更新/);
  assert.equal(select(host, "服务商").value, "custom");
  await changeInput(input(host, "自定义模型名称"), "edited-model");
  await changeInput(input(host, "API Key"), "unsaved-test-key");
  await act(async () => button(host, "刷新模型列表").click());
  assert.deepEqual(calls, [{ refresh: false }, { refresh: true }]);
  assert.equal(input(host, "Responses API 地址").value, stored.baseUrl);
  assert.equal(input(host, "自定义模型名称").value, "edited-model");
  assert.equal(input(host, "API Key").value, "unsaved-test-key");
  assert.equal(saves.length, 0); assert.match(host.textContent!, /最近缓存.*已保留最近目录/);
});

test("provider/model choices restore custom edits and switching endpoints never carries a saved credential", async t => {
  const saves: AgentModelSettingsInput[] = [];
  const { host } = await mount(t as never, { get: async () => stored, catalog: async () => catalog,
    save: async value => { saves.push(value); return { baseUrl: value.baseUrl, model: value.model, hasKey: false }; } });
  await changeSelect(select(host, "服务商"), "first");
  assert.equal(input(host, "Responses API 地址").value, "https://first.example/v1");
  assert.equal(input(host, "Responses API 地址").readOnly, true);
  assert.equal(select(host, "模型").value, "first-small");
  await changeSelect(select(host, "模型"), "first-large");
  await changeInput(input(host, "API Key"), "first-unsaved");
  await changeSelect(select(host, "服务商"), "custom");
  assert.equal(input(host, "Responses API 地址").value, stored.baseUrl);
  assert.equal(input(host, "自定义模型名称").value, stored.model);
  assert.equal(input(host, "API Key").value, "");
  await changeSelect(select(host, "服务商"), "first");
  assert.equal(select(host, "模型").value, "first-large");
  await act(async () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  assert.deepEqual(saves, [{ baseUrl: "https://first.example/v1", model: "first-large", clearApiKey: true }]);
});

test("same endpoint keeps saved key on blank input; explicit clear is submitted and failures keep edited settings", async t => {
  const saves: AgentModelSettingsInput[] = [];
  const { host } = await mount(t as never, { get: async () => stored, catalog: async () => catalog,
    save: async value => { saves.push(value); throw new Error("保存失败"); } });
  const submit = () => act(async () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  await submit();
  assert.deepEqual(saves[0], { baseUrl: stored.baseUrl, model: stored.model });
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /保存失败/);
  await act(async () => input(host, "清除已保存密钥").click());
  await submit();
  assert.deepEqual(saves[1], { baseUrl: stored.baseUrl, model: stored.model, clearApiKey: true });
  assert.equal(input(host, "自定义模型名称").value, stored.model);
});

test("catalog errors retain usable options and active tasks disable settings mutations", async t => {
  const api = { get: async () => stored, catalog: async () => { throw new Error("network failure"); }, save: async () => stored };
  const { host, root, props } = await mount(t as never, api);
  assert.match(host.querySelector('[role="status"]')!.textContent!, /暂时无法更新模型列表/);
  assert.ok(select(host, "服务商").options.length >= 2);
  await act(async () => root.render(<AgentModelSettingsPanel {...props} disabled />));
  assert.equal(select(host, "服务商").disabled, true);
  assert.equal(input(host, "API Key").disabled, true);
  assert.equal(button(host, "保存连接").disabled, true);
  assert.equal(button(host, "刷新模型列表").disabled, true);
});
