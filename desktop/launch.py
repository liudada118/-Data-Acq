"""Qt WebEngine host for the React UI; acquisition stays in the native process."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ENGINE_URL = "http://127.0.0.1:8765"
EXPORT_URL = "http://127.0.0.1:8766"
LOCAL_PORTS = (8765, 8766, 5173, 4173)


def request_json(url: str, payload: dict | None = None, timeout: float = 2) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def available(url: str) -> bool:
    try:
        request_json(url, timeout=0.8)
        return True
    except (OSError, ValueError, urllib.error.URLError):
        return False


def find_engine() -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    candidates = [
        ROOT / "build/native/Release" / ("syndaq_engine" + suffix),
        ROOT / "build/native" / ("syndaq_engine" + suffix),
        ROOT / "native/build/Release" / ("syndaq_engine" + suffix),
        ROOT / "native/build" / ("syndaq_engine" + suffix),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("未找到 C++ 采集服务。请先运行 python scripts/bootstrap.py 完成构建。")


class Services:
    def __init__(self) -> None:
        self.children: list[subprocess.Popen] = []
        self.logs = []
        self.owns_engine = False

    def start(self, command: list[str], health_url: str, name: str) -> None:
        if available(health_url):
            return
        runtime = ROOT / ".runtime"
        runtime.mkdir(exist_ok=True)
        log = (runtime / f"{name}.log").open("ab")
        self.logs.append(log)
        child = subprocess.Popen(
            command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.children.append(child)
        if name == "engine":
            self.owns_engine = True
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if available(health_url):
                return
            if child.poll() is not None:
                raise RuntimeError(f"{name} 启动失败，请查看 {runtime / (name + '.log')}")
            time.sleep(0.12)
        raise RuntimeError(f"{name} 启动超时，请查看 {runtime / (name + '.log')}")

    def close(self) -> None:
        # Flush acquisition before stopping an engine owned by this launcher.
        if self.owns_engine:
            try:
                status = request_json(ENGINE_URL + "/api/status")
                if status.get("session_id"):
                    request_json(ENGINE_URL + "/api/sessions/stop", {}, timeout=20)
            except (OSError, ValueError):
                pass
        for child in reversed(self.children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        for log in self.logs:
            log.close()


def start_services(services: Services) -> None:
    if not (ROOT / "frontend/dist/index.html").is_file():
        raise RuntimeError("未找到 React 构建结果，请运行 npm.cmd --prefix frontend run build。")
    services.start(
        [str(find_engine()), "--data-dir", str(ROOT / "data/sessions"),
         "--web-dir", str(ROOT / "frontend/dist"), "--port", "8765"],
        ENGINE_URL + "/api/health", "engine",
    )
    services.start(
        [sys.executable, str(ROOT / "tools/export_server.py"),
         "--data-dir", str(ROOT / "data/sessions"),
         "--output-dir", str(ROOT / "data/exports"), "--port", "8766"],
        EXPORT_URL + "/api/export/formats", "exporter",
    )


def qt_window(url: str) -> int:
    from PySide6.QtCore import QStandardPaths, QTimer, QUrl
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication, QFileDialog, QMainWindow, QMessageBox
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
    from PySide6.QtWebEngineWidgets import QWebEngineView

    app = QApplication(sys.argv[:1])
    app.setApplicationName("Synapse 多模态采集工作站")
    app.setOrganizationName("SynapseDAQ")
    icon_path = ROOT / "desktop/icon.svg"
    app.setWindowIcon(QIcon(str(icon_path)))

    class LocalPage(QWebEnginePage):
        def acceptNavigationRequest(self, target, navigation_type, is_main_frame):
            return (target.scheme() == "http" and target.host() in ("127.0.0.1", "localhost")
                    and target.port() in LOCAL_PORTS) or target.scheme() == "about"

    class Window(QMainWindow):
        def closeEvent(self, event):
            try:
                status = request_json(ENGINE_URL + "/api/status")
                if status.get("session_id"):
                    answer = QMessageBox.question(
                        self, "正在录制", "停止录制、保存数据并退出工作站？",
                        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                        QMessageBox.StandardButton.No,
                    )
                    if answer != QMessageBox.StandardButton.Yes:
                        event.ignore()
                        return
                    request_json(ENGINE_URL + "/api/sessions/stop", {}, timeout=20)
                jobs = request_json(EXPORT_URL + "/api/export/jobs").get("jobs", [])
                if any(job.get("status") in ("pending", "running") for job in jobs):
                    QMessageBox.information(self, "导出尚未完成", "请等待导出任务完成后关闭工作站。")
                    event.ignore()
                    return
            except (OSError, ValueError) as exc:
                # A service failure must not silently terminate an active recording.
                answer = QMessageBox.question(
                    self, "服务连接中断", f"无法确认录制状态：{exc}\n仍要退出？",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                    QMessageBox.StandardButton.No,
                )
                if answer != QMessageBox.StandardButton.Yes:
                    event.ignore()
                    return
            event.accept()

    window = Window()
    window.setWindowTitle("Synapse · 多模态采集工作站")
    window.resize(1500, 1000)
    window.setMinimumSize(1000, 720)
    view = QWebEngineView(window)
    storage_path = ROOT / "data/ui"
    storage_path.mkdir(parents=True, exist_ok=True)
    # Window destroys its view/pages before this later-created sibling profile.
    profile = QWebEngineProfile("SynapseDAQ", window)
    profile.setPersistentStoragePath(str(storage_path))
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.MemoryHttpCache)
    page = LocalPage(profile, view)
    view.setPage(page)
    window.setCentralWidget(view)

    def download(request):
        if request.url().host() not in ("127.0.0.1", "localhost"):
            request.cancel()
            return
        downloads = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)
        destination, _ = QFileDialog.getSaveFileName(
            window, "保存导出文件", str(Path(downloads) / request.downloadFileName()),
            "ZIP 数据包 (*.zip);;所有文件 (*)",
        )
        if destination:
            path = Path(destination)
            request.setDownloadDirectory(str(path.parent))
            request.setDownloadFileName(path.name)
            request.accept()
        else:
            request.cancel()

    profile.downloadRequested.connect(download)
    view.load(QUrl(url))
    window.show()
    # Hosts may pass SW_HIDE to console children; explicitly show the interactive
    # window again after startup, without exposing any background-service console.
    QTimer.singleShot(150, window.showNormal)
    return app.exec()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", action="store_true", help="在浏览器中预览，并保持服务运行")
    parser.add_argument("--url", default=ENGINE_URL, help="本地界面地址，默认使用构建后的 React")
    args = parser.parse_args()
    from urllib.parse import urlparse
    target = urlparse(args.url)
    if (target.scheme != "http" or target.hostname not in ("127.0.0.1", "localhost")
            or target.port not in LOCAL_PORTS):
        parser.error("仅支持本机 HTTP 界面地址，端口为 8765、8766、5173 或 4173")
    services = Services()
    desktop_lock = None
    try:
        from PySide6.QtCore import QLockFile
        runtime = ROOT / ".runtime"
        runtime.mkdir(exist_ok=True)
        desktop_lock = QLockFile(str(runtime / "desktop.lock"))
        desktop_lock.setStaleLockTime(0)
        if not desktop_lock.tryLock(100):
            raise RuntimeError("工作站已在运行，请切换到已打开的 Synapse 窗口。")
        start_services(services)
        if args.browser:
            import webbrowser
            webbrowser.open(args.url)
            print(f"工作站已启动：{args.url}；Ctrl+C 停止。", flush=True)
            while True:
                time.sleep(0.5)
        return qt_window(args.url)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        if sys.stderr is not None:
            print(str(exc), file=sys.stderr)
        runtime = ROOT / ".runtime"
        runtime.mkdir(exist_ok=True)
        with (runtime / "launch-error.log").open("a", encoding="utf-8") as error_log:
            error_log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {exc}\n")
        try:
            from PySide6.QtWidgets import QApplication, QMessageBox
            app = QApplication.instance() or QApplication(sys.argv[:1])
            QMessageBox.critical(None, "Synapse 启动失败", str(exc))
        except ImportError:
            pass
        return 1
    finally:
        services.close()
        if desktop_lock is not None and desktop_lock.isLocked():
            desktop_lock.unlock()


if __name__ == "__main__":
    raise SystemExit(main())
