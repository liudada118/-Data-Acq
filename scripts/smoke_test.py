"""Exercise real native recording -> independent export -> downloadable ZIP."""
from __future__ import annotations

import argparse
import base64
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.launch import find_engine


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(url, body=None, origin=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    with urllib.request.urlopen(req, timeout=15) as response:
        raw = response.read()
        if "application/json" in response.headers.get("Content-Type", ""):
            return json.loads(raw)
        return raw


def wait_ready(url, process):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("service exited before becoming ready")
        try:
            return request(url)
        except (OSError, ValueError):
            time.sleep(0.1)
    raise RuntimeError("service did not become ready")


def expect_error(url, code, body=None, origin=None):
    try:
        request(url, body, origin)
    except urllib.error.HTTPError as exc:
        assert exc.code == code, (url, exc.code, exc.read().decode())
    else:
        raise AssertionError(f"{url} accepted a request expected to fail")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=2.5)
    args = parser.parse_args()
    native_port, export_port = free_port(), free_port()
    native = f"http://127.0.0.1:{native_port}"
    exporter = f"http://127.0.0.1:{export_port}"
    children = []
    with tempfile.TemporaryDirectory(prefix="syndaq-smoke-") as temporary:
        directory = Path(temporary)
        data_dir = directory / "sessions"
        with (directory / "engine.log").open("wb") as native_log, (directory / "export.log").open("wb") as export_log:
            try:
                engine = subprocess.Popen([
                    str(find_engine()), "--port", str(native_port), "--data-dir", str(data_dir),
                    "--web-dir", str(ROOT / "frontend/dist"),
                ], cwd=ROOT, stdout=native_log, stderr=subprocess.STDOUT)
                children.append(engine)
                worker = subprocess.Popen([
                    sys.executable, str(ROOT / "tools/export_server.py"), "--port", str(export_port),
                    "--data-dir", str(data_dir), "--output-dir", str(directory / "exports"),
                ], cwd=ROOT, stdout=export_log, stderr=subprocess.STDOUT)
                children.append(worker)
                health = wait_ready(native + "/api/health", engine)
                formats = wait_ready(exporter + "/api/export/formats", worker)["formats"]
                assert health["mode"] == "simulation"
                devices = request(native + "/api/devices")["devices"]
                ids = [device["id"] for device in devices]
                assert len(ids) == 4 and all(device["mode"] == "simulated" for device in devices)
                preview = request(native + "/api/preview")
                assert len(preview["pressure"]["values"]) == 256
                camera = preview["camera"]
                assert len(base64.b64decode(camera["rgb_base64"])) == camera["width"] * camera["height"] * 3
                expect_error(native + "/api/sessions/start", 400, {"name": "invalid", "device_ids": []})
                expect_error(native + "/api/status", 403, origin="https://untrusted.invalid")
                started = request(native + "/api/sessions/start", {"name": "四模态集成验证", "device_ids": ids})
                session_id = started["session_id"]
                expect_error(native + "/api/sessions/start", 409, {"name": "duplicate", "device_ids": ids})
                time.sleep(args.duration)
                while_recording = request(native + "/api/status")
                assert while_recording["state"] == "recording"
                assert while_recording["queue_depth"] <= while_recording["queue_capacity"]
                stopped = request(native + "/api/sessions/stop", {})["session"]
                assert stopped["status"] == "complete" and stopped["finalized"]
                assert len(stopped["streams"]) == 4 and all(stream["records"] > 0 for stream in stopped["streams"])
                assert request(native + "/api/status")["state"] == "idle"
                manifest = request(native + f"/api/files/{session_id}/manifest.json")
                assert manifest["id"] == session_id
                assert request(native + "/api/sessions")["sessions"][0]["id"] == session_id
                results = []
                for format_info in formats:
                    if not format_info["available"]:
                        continue
                    format_id = format_info["id"]
                    job_id = request(exporter + "/api/export/jobs", {"session_id": session_id, "format": format_id})["job_id"]
                    deadline = time.monotonic() + 60
                    while time.monotonic() < deadline:
                        job = request(exporter + f"/api/export/jobs/{job_id}")
                        if job["status"] in ("complete", "error"):
                            break
                        time.sleep(0.1)
                    assert job["status"] == "complete", job
                    download_path = job["download_url"]
                    payload = request(download_path if download_path.startswith("http") else exporter + download_path)
                    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                        assert archive.testzip() is None
                        assert "manifest.json" in archive.namelist()
                    results.append({"format": format_id, "zip_bytes": len(payload)})
                expect_error(exporter + "/api/export/jobs", 400, {"session_id": "../outside", "format": "csv"})
                print(json.dumps({"result": "passed", "duration_s": stopped["duration_s"],
                    "record_counts": stopped["record_counts"], "bytes_written": stopped["bytes_written"],
                    "dropped_records": stopped.get("dropped_records", 0), "exports": results}, ensure_ascii=False, indent=2))
            except Exception:
                for log_name in ("engine.log", "export.log"):
                    print((directory / log_name).read_text(encoding="utf-8", errors="replace"), file=sys.stderr)
                raise
            finally:
                for process in reversed(children):
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)


if __name__ == "__main__":
    main()
