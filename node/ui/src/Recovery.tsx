import { Component } from "react";
import type { ReactNode } from "react";

const title = "界面暂时无法更新";
const message = "请重新加载界面，再确认当前采集状态。刷新页面不会主动停止后台录制。";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="app-recovery" role="alert">
      <div className="app-recovery-card">
        <p className="app-recovery-brand">SYNAPSE · 采集工作站</p>
        <h1>{title}</h1>
        <p>{message}</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载界面</button>
      </div>
    </main>;
  }
}

/** Last-resort UI when a damaged DOM also prevents React's boundary from committing. */
export function renderRootRecovery(container: HTMLElement) {
  const doc = container.ownerDocument;
  const main = doc.createElement("main");
  main.className = "app-recovery";
  main.setAttribute("role", "alert");
  const card = doc.createElement("div");
  card.className = "app-recovery-card";
  const brand = doc.createElement("p");
  brand.className = "app-recovery-brand";
  brand.textContent = "SYNAPSE · 采集工作站";
  const heading = doc.createElement("h1");
  heading.textContent = title;
  const description = doc.createElement("p");
  description.textContent = message;
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "重新加载界面";
  button.addEventListener("click", () => doc.defaultView?.location.reload());
  card.append(brand, heading, description, button);
  main.append(card);
  container.replaceChildren(main);
}
