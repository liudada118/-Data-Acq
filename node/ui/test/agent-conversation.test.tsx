import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { SdkAgentWorkbench } from "../src/SdkAgentWorkbench";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const workspace = (id: string) => ({ id, name: id, status: "imported", updated_at: "2026-11-11", files: [],
  messages: Array.from({ length: 5 }, (_, index) => ({ id: `${id}-${index}`, role: index % 2 ? "assistant" : "user", content: `消息 ${index}` })),
  draft: { files: [], revision: "imported" } });

async function mount(t: TestContext) {
  const states = { latest: workspace("latest"), earlier: workspace("earlier") };
  const calls: { action: string; args?: Record<string, unknown> }[] = [];
  let chatResult: Promise<unknown> | undefined;
  window.synapseDesktop = { onBeforeClose: () => () => {}, integration: {
    chooseSdkDirectory: async () => null,
    modelSettings: { get: async () => ({ baseUrl: "", model: "", hasKey: false }), save: async () => ({ baseUrl: "", model: "", hasKey: false }) },
    invoke: async (action, args) => {
      calls.push({ action, args });
      if (action === "list") return { workspaces: Object.values(states) };
      if (action === "chat" && chatResult) return chatResult;
      return structuredClone(states[args?.workspace_id as keyof typeof states]);
    },
  } };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const props = { recording: false, onInstalled: async () => {}, onCapture: () => {} };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete window.synapseDesktop; });
  await act(async () => root.render(<SdkAgentWorkbench {...props} />));
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const key = async (options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
    await act(async () => textarea.dispatchEvent(event));
    return event;
  };
  return { host, root, props, states, calls, textarea, type, key, holdChat: (pending: Promise<unknown>) => { chatResult = pending; } };
}

test("Enter sends once while Shift+Enter and IME confirmation preserve the draft", async t => {
  const { host, calls, textarea, type, key, holdChat } = await mount(t);
  await type("  接入摄像头  ");
  assert.equal((await key({ shiftKey: true })).defaultPrevented, false, "Shift+Enter retains native newline behavior");
  assert.equal((await key({ isComposing: true })).defaultPrevented, false);
  assert.equal((await key({ keyCode: 229 })).defaultPrevented, false);
  await act(async () => textarea.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })));
  await key();
  assert.equal(calls.filter(call => call.action === "chat").length, 0);
  assert.equal(textarea.value, "  接入摄像头  ");
  await act(async () => textarea.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true })));
  const pending = Promise.withResolvers<unknown>(); holdChat(pending.promise);
  assert.equal((await key()).defaultPrevented, true);
  await key({ repeat: true });
  await act(async () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  assert.deepEqual(calls.filter(call => call.action === "chat"), [{ action: "chat", args: { workspace_id: "latest", message: "接入摄像头" } }]);
  assert.equal(textarea.value, "");
  assert.equal(textarea.disabled, true);
  await act(async () => pending.resolve(workspace("latest")));
  assert.equal(textarea.disabled, false);
  await key();
  assert.equal(calls.filter(call => call.action === "chat").length, 1, "empty Enter cannot submit");
});

test("keyboard and form submission cannot send during recording", async t => {
  const { host, root, props, calls, type, key, textarea } = await mount(t);
  await type("暂不发送");
  await act(async () => root.render(<SdkAgentWorkbench {...props} recording />));
  await key();
  await act(async () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(calls.filter(call => call.action === "chat").length, 0);
  assert.equal(textarea.value, "暂不发送");
});

test("opening and switching conversations shows the latest messages while polling preserves history reading", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scrollHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "clientHeight");
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return this.querySelectorAll(".sdk-message").length * 300; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 300; } });
  t.after(() => {
    for (const [name, descriptor] of [["scrollHeight", scrollHeight], ["clientHeight", clientHeight]] as const) {
      if (descriptor) Object.defineProperty(dom.window.HTMLElement.prototype, name, descriptor);
      else delete (dom.window.HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });
  const { host, states } = await mount(t);
  const viewport = host.querySelector<HTMLDivElement>(".sdk-messages")!;
  assert.equal(viewport.scrollTop, 1500, "initial asynchronous workspace load scrolls to the end");
  states.latest.messages.push({ id: "new", role: "assistant", content: "最新回复" });
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(viewport.scrollTop, 1800, "new replies follow the latest when already at the end");
  await act(async () => { viewport.scrollTop = 100; viewport.dispatchEvent(new dom.window.Event("scroll")); });
  states.latest.messages.push({ id: "newer", role: "assistant", content: "后续回复" });
  await act(async () => t.mock.timers.tick(1500));
  assert.equal(viewport.scrollTop, 100, "polling cannot pull the reader away from older messages");
  const other = [...host.querySelectorAll<HTMLButtonElement>(".sdk-workspace-list button")].find(button => button.textContent?.startsWith("earlier"))!;
  await act(async () => other.click());
  assert.equal(viewport.scrollTop, 1500, "switching workspaces restores the latest position");
});
