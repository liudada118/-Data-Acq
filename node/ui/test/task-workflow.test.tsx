import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { ExperimentDialog } from "../src/ExperimentDialog";
import { AnnotationPanel } from "../src/AnnotationPanel";
import { defaultLabels, emptyExperiment } from "../src/workflow";
import type { AnnotationDocument, AnnotationMutation, WorkflowDraft } from "../src/workflow";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value() { this.open = true; } });
const { createRoot } = await import("react-dom/client");
const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label);
  assert.ok(found, `missing button ${label}`); return found;
};
const initial = (): WorkflowDraft => ({ experiment: { ...emptyExperiment(), project: "原项目", subject: "P001", scene: "桌面", trial: "3", notes: "保留说明", tags: ["左手"] }, labels: defaultLabels() });

test("free collection template requires no labels and preserves optional experiment information", async t => {
  const original = initial(), before = structuredClone(original), saved: WorkflowDraft[] = [];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ExperimentDialog value={original} allowTemplates onClose={() => {}} onSave={value => { saved.push(value); }} />));
  assert.equal(host.querySelector(".task-extra-fields")?.hasAttribute("open"), false);
  assert.ok(host.querySelector('input[aria-label="这次要采什么"]'));
  await act(async () => button(host, "使用自由采集模板").click());
  await act(async () => button(host, "保存任务，返回展示区").click());
  assert.equal(saved[0].experiment.task, "自由采集");
  assert.deepEqual(saved[0].labels, []);
  assert.deepEqual({ ...saved[0].experiment, task: "" }, original.experiment);
  assert.deepEqual(original, before, "editing never mutates the parent draft");
});

test("action templates configure real point/interval buttons and only change the next recording draft", async t => {
  const saved: WorkflowDraft[] = [];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ExperimentDialog value={initial()} allowTemplates onClose={() => {}} onSave={value => { saved.push(value); }} />));
  await act(async () => button(host, "使用步态行走模板").click());
  assert.equal(button(host, "使用步态行走模板").getAttribute("aria-pressed"), "true");
  assert.equal(button(host, "使用抓握动作模板").getAttribute("aria-pressed"), "false");
  assert.match(host.querySelector('[role="status"]')?.textContent || "", /已填入「步态行走」.*保存后生效/);
  assert.equal(saved.length, 0, "template feedback does not commit the draft before save");
  await act(async () => button(host, "保存任务，返回展示区").click());
  assert.equal(saved[0].experiment.task, "行走与转身");
  assert.deepEqual(saved[0].labels.map(label => [label.name, label.kind]), [["行走", "interval"], ["转身", "point"], ["异常", "point"]]);
  assert.equal(saved[0].experiment.subject, "P001");
  await act(async () => button(host, "使用抓握动作模板").click());
  await act(async () => button(host, "保存任务，返回展示区").click());
  assert.deepEqual(saved[1].labels, defaultLabels());
});

test("saved-recording settings have no template or clear-all action and preserve existing label IDs", async t => {
  const value = initial(); value.labels = [{ id: "historic-action-id", name: "按压", kind: "interval", color: "#25866b", shortcut: "p" }];
  const saved: WorkflowDraft[] = [];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ExperimentDialog value={value} onClose={() => {}} onSave={next => { saved.push(next); }} />));
  assert.equal(host.querySelector('.task-template-section'), null);
  await act(async () => button(host, "保存修改").click());
  assert.equal(saved[0].labels[0].id, "historic-action-id");
  await act(async () => host.querySelector<HTMLButtonElement>('.task-marker-summary')!.click());
  assert.match(host.textContent || "", /标记，就是告诉回放/);
  assert.doesNotMatch(host.textContent || "", /本次不使用标记/);
});

test("invalid mark definitions reveal the relevant settings instead of hiding errors in another tab", async t => {
  const value = initial(); value.labels[1].shortcut = value.labels[0].shortcut;
  let calls = 0;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ExperimentDialog value={value} allowTemplates onClose={() => {}} onSave={() => { calls++; }} />));
  await act(async () => button(host, "保存任务，返回展示区").click());
  assert.equal(calls, 0);
  assert.ok(host.querySelector('input[aria-label="标签 2 快捷键"]'));
  assert.match(host.querySelector('[role="alert"]')?.textContent || "", /不能使用同一个快捷键/);
});

test("saving is single-flight and a failed save retains the draft for retry", async t => {
  let calls = 0, fail!: (reason: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ExperimentDialog value={initial()} allowTemplates onClose={() => {}} onSave={() => { calls++; return pending; }} />));
  await act(async () => { const save = button(host, "保存任务，返回展示区"); save.click(); save.click(); });
  assert.equal(calls, 1);
  assert.equal(button(host, "正在保存…").disabled, true);
  await act(async () => { fail(new Error("服务暂时离线")); });
  assert.match(host.querySelector('[role="alert"]')?.textContent || "", /服务暂时离线/);
  assert.equal((host.querySelector('input[aria-label="采集对象"]') as HTMLInputElement).value, "P001");
  assert.equal(button(host, "保存任务，返回展示区").disabled, false);
});

test("a full 32-action draft retains editable rows and exposes validation next to the fixed save controls", async t => {
  const value = initial();
  value.labels = Array.from({ length: 32 }, (_, index) => ({ id: `action-${index}`, name: `动作 ${index + 1}`,
    kind: "point", color: "#25866b", shortcut: index === 31 ? "1" : index === 0 ? "1" : "" }));
  let saves = 0;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ExperimentDialog value={value} allowTemplates onClose={() => {}} onSave={() => { saves++; }} />));
  const body = host.querySelector<HTMLElement>(".task-dialog-body")!;
  const footer = host.querySelector<HTMLElement>(".workflow-dialog-footer")!;
  assert.equal(body.contains(footer), false, "save controls remain outside the long-form scrolling content");
  assert.match(host.querySelector(".task-marker-summary")?.textContent || "", /32 个标记/);
  assert.doesNotMatch(host.querySelector(".task-marker-summary")?.textContent || "", /动作 32/,
    "the summary stays compact while all 32 definitions remain editable");
  body.scrollTop = 800;
  await act(async () => button(host, "保存任务，返回展示区").click());
  assert.equal(saves, 0);
  assert.equal(body.scrollTop, 0, "validation opens the action tab at its start");
  assert.equal(host.querySelectorAll(".label-definition").length, 32);
  assert.ok(host.querySelector('input[aria-label="标签 32 名称"]'));
  assert.equal(button(host, "添加动作或事件").disabled, true);
  assert.match(footer.querySelector('[role="alert"]')?.textContent || "", /同一个快捷键/);
  await act(async () => button(host, "删除标签 动作 32").click());
  assert.equal(button(host, "添加动作或事件").disabled, false);
  await act(async () => button(host, "保存任务，返回展示区").click());
  assert.equal(saves, 1);
  assert.equal(value.labels.length, 32, "dialog edits keep the source draft intact");
});

test("cancel and Escape close the task draft without committing a selected template", async t => {
  const value = initial(), before = structuredClone(value);
  let closes = 0, saves = 0;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<ExperimentDialog value={value} allowTemplates onClose={() => { closes++; }} onSave={() => { saves++; }} />));
  await act(async () => button(host, "使用自由采集模板").click());
  await act(async () => button(host, "取消").click());
  assert.equal(closes, 1);
  const cancel = new dom.window.Event("cancel", { bubbles: true, cancelable: true });
  await act(async () => host.querySelector("dialog")!.dispatchEvent(cancel));
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(closes, 2);
  assert.equal(saves, 0);
  assert.deepEqual(value, before);
});

test("plain-language event controls still send point, start and end operations with original IDs", async t => {
  const documentState: AnnotationDocument = { schema_version: 1, session_id: "s-test", revision: 0, experiment: emptyExperiment(), labels: defaultLabels(), annotations: [], history: [] };
  const mutations: AnnotationMutation[] = [];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = () => root.render(<AnnotationPanel document={documentState} live busy={false} error="" streams={[]} cursor={2} duration={2} onSettings={() => {}} onMutate={async input => { mutations.push(input); return true; }} />);
  await act(async () => render());
  assert.match(button(host, "标记接触").textContent || "", /点一下，记下这一刻/);
  await act(async () => button(host, "标记接触").click());
  await act(async () => button(host, "开始抓握").click());
  assert.deepEqual(mutations.map(item => [item.op, item.label_id]), [["mark", "contact"], ["begin", "grasp"]]);
  documentState.annotations.push({ id: "a-open", label_id: "grasp", label_name: "抓握", color: "#b37b39", kind: "interval", start_ns: "1000000000", end_ns: null, stream_ids: [], note: "", source: "live", created_at: "", updated_at: "" });
  await act(async () => render());
  assert.match(button(host, "结束抓握").textContent || "", /再按结束/);
  await act(async () => button(host, "结束抓握").click());
  assert.deepEqual(mutations[2], { op: "end", id: "a-open" });
});

test("recording locks task settings without disabling live markers, and stopping enables settings again", async t => {
  const documentState: AnnotationDocument = { schema_version: 1, session_id: "s-test", revision: 0, experiment: emptyExperiment(), labels: defaultLabels(), annotations: [], history: [] };
  let settingsCalls = 0;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = (live: boolean, busy = false) => root.render(<AnnotationPanel document={documentState} live={live} busy={busy} error="" streams={[]} cursor={2} duration={2} onSettings={() => { settingsCalls++; }} onMutate={async () => true} />);
  await act(async () => render(true));
  const settings = button(host, "配置实验信息与标签");
  assert.equal(settings.disabled, true);
  assert.match(settings.title, /停止后再修改下一段任务/);
  assert.match(host.querySelector('.annotation-hint')?.textContent || "", /修改下一段任务.*先停止录制/);
  assert.equal(button(host, "标记接触").disabled, false);
  await act(async () => settings.click());
  assert.equal(settingsCalls, 0);
  await act(async () => render(false, true));
  assert.equal(button(host, "配置实验信息与标签").disabled, true);
  await act(async () => render(false));
  assert.equal(button(host, "配置实验信息与标签").disabled, false);
  await act(async () => button(host, "配置实验信息与标签").click());
  assert.equal(settingsCalls, 1);
});
