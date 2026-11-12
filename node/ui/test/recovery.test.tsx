import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { flushSync } from "react-dom";
import { AppErrorBoundary, renderRootRecovery } from "../src/Recovery";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

function BrokenRender(): never { throw new Error("render regression"); }
function ChangingNodes({ add }: { add: boolean }) {
  return <div>{add && <b>新数据</b>}<span>旧数据</span></div>;
}
function container() {
  const node = document.createElement("div");
  document.body.append(node);
  return node;
}
function assertRecovery(node: HTMLElement) {
  assert.match(node.textContent ?? "", /界面暂时无法更新/);
  assert.equal(node.querySelector('[role="alert"] button')?.textContent, "重新加载界面");
}

test("render errors show a reload action instead of an empty root", async () => {
  const node = container();
  const errors: unknown[] = [];
  const root = createRoot(node, { onCaughtError: error => errors.push(error) });
  try {
    await act(async () => root.render(<AppErrorBoundary><BrokenRender /></AppErrorBoundary>));
    assert.equal(errors.length, 1);
    assertRecovery(node);
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});

test("external DOM mutation causing insertBefore NotFoundError is recoverable", async () => {
  const node = container();
  const errors: unknown[] = [];
  const root = createRoot(node, {
    onCaughtError: error => errors.push(error),
    onUncaughtError: error => {
      errors.push(error);
      setTimeout(() => renderRootRecovery(node), 0);
    },
  });
  try {
    await act(async () => root.render(<AppErrorBoundary><ChangingNodes add={false} /></AppErrorBoundary>));
    // A browser extension can detach/replace text anchors outside React's ownership.
    node.querySelector("span")!.remove();
    await act(async () => root.render(<AppErrorBoundary><ChangingNodes add /></AppErrorBoundary>));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(errors.some(error => (error as Error).name === "NotFoundError"));
    assertRecovery(node);
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});

test("root fallback restores a reload action even without a working React boundary", async () => {
  // act intentionally rethrows uncaught errors, so use the normal root commit path here.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  const node = container();
  let uncaught = false;
  const root = createRoot(node, {
    onUncaughtError: () => {
      uncaught = true;
      setTimeout(() => renderRootRecovery(node), 0);
    },
  });
  try {
    flushSync(() => root.render(<ChangingNodes add={false} />));
    node.querySelector("span")!.remove();
    flushSync(() => root.render(<ChangingNodes add />));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(uncaught, true);
    assertRecovery(node);
  } finally {
    flushSync(() => root.unmount());
    node.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  }
});
