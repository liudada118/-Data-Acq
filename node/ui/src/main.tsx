import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary, renderRootRecovery } from "./Recovery";
import "./styles.css";
import "./sdk-agent.css";
import "./recovery.css";
import "./task-workflow.css";
import "./workspace-display.css";
import "./capture-shell.css";
import "./data-quality.css";
import "./card-content.css";
import "./replay-workspace.css";
import "./continuity-report.css";
import "./media-rail.css";
import "./card-size.css";
import "./independent-card-layout.css";
import "./bounded-board-layout.css";
import "./card-position.css";
import "./plugin-camera-layout.css";

const container = document.getElementById("root")!;
let recoveryScheduled = false;
createRoot(container, {
  onUncaughtError(error) {
    console.error("采集界面更新失败", error);
    if (recoveryScheduled) return;
    recoveryScheduled = true;
    // Wait until React finishes its failed commit before replacing the damaged root.
    setTimeout(() => renderRootRecovery(container), 0);
  },
}).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);
