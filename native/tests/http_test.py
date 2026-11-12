"""Exercise the compiled native service through HTTP using only Python's stdlib."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import socket
import struct
import subprocess
import time
import urllib.error
import urllib.request


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    args = parser.parse_args()
    exe = args.exe.resolve()
    test_dir = exe.parent / f"http-validation-{time.time_ns()}"
    data = test_dir / "sessions"
    web = test_dir / "web"
    web.mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>SYNDAQ test</title>", encoding="utf-8")
    (web / "app.js").write_text("console.log('static asset');", encoding="utf-8")
    with socket.socket() as available:
        available.bind(("127.0.0.1", 0))
        port = available.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    process = None

    def request(path, body=None, expected=200, origin=None, raw=None, method=None):
        headers = {}
        if body is not None:
            raw = json.dumps(body).encode()
        if raw is not None:
            headers["Content-Type"] = "application/json"
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request(base + path, data=raw, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            payload = response.read()
            assert response.status == expected, (path, response.status, expected, payload[:200])
            if "application/json" in response.headers.get("Content-Type", ""):
                payload = json.loads(payload)
            return payload, response.headers

    def launch():
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        log = (test_dir / "service.log").open("ab")
        child = subprocess.Popen([str(exe), "--port", str(port), "--data-dir", str(data), "--web-dir", str(web)],
                                 stdout=log, stderr=log, creationflags=creationflags)
        log.close()
        for _ in range(100):
            try:
                request("/api/health")
                return child
            except (OSError, AssertionError):
                if child.poll() is not None:
                    raise AssertionError((test_dir / "service.log").read_text())
                time.sleep(0.05)
        child.terminate()
        raise AssertionError("service did not start")

    try:
        process = launch()
        health, _ = request("/api/health")
        assert health["mode"] == "simulation" and not health["hardware_connected"]
        devices, _ = request("/api/devices")
        ids = [device["id"] for device in devices["devices"]]
        assert set(ids) == {"sim-camera", "sim-audio", "sim-pressure", "sim-imu"}
        for device in devices["devices"]:
            assert device["mode"] == "simulated" and device["transport"] == "Simulation"
            assert isinstance(device["channels"], int)
        request("/api/sessions/start", {"device_ids": []}, expected=400)
        request("/api/sessions/start", {"device_ids": ["bad"]}, expected=400)
        request("/api/sessions/start", raw=b"broken-json", expected=400)
        request("/api/sessions/start", {"device_ids": ids}, origin="https://untrusted.invalid", expected=403)
        _, headers = request("/api/status", origin="http://127.0.0.1:5173")
        assert headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:5173"
        request("/api/status", method="OPTIONS", origin="http://localhost:5173", expected=204)
        started, _ = request("/api/sessions/start", {"name": "HTTP验证", "device_ids": ids}, expected=201)
        session_id = started["session_id"]
        request("/api/sessions/start", {"device_ids": ids}, expected=409)
        time.sleep(0.6)
        preview, _ = request("/api/preview")
        assert preview["camera"]["width"] == 160 and preview["camera"]["height"] == 90
        assert len(preview["pressure"]["values"]) == 256 and len(preview["imu"]["values"]) == 6
        assert preview["status"]["state"] == "recording"
        stopped, _ = request("/api/sessions/stop", {})
        session = stopped["session"]
        assert session["status"] == "complete" and session["dropped_batches"] == 0
        assert session["finalized"] is True
        assert stopped["status"]["state"] == "idle" and stopped["status"]["queue_depth"] == 0
        manifest, _ = request(f"/api/sessions/{session_id}")
        assert manifest["finalized"] and manifest["record_count"] > 0
        assert session == manifest
        assert request("/api/sessions")[0]["sessions"][0] == manifest
        downloaded, _ = request(f"/api/files/{session_id}/manifest.json")
        assert downloaded == manifest
        actual_bytes = 0
        for stream in manifest["streams"]:
            payload, _ = request(f"/api/files/{session_id}/{stream['file']}")
            assert payload[:8] == b"MDAQBIN1"
            offset, records, samples = 8, 0, 0
            while offset < len(payload):
                sequence, device_ns, host_ns, count, size = struct.unpack_from("<QqqII", payload, offset)
                assert device_ns >= manifest["session_start_device_time_ns"] and host_ns > 0
                offset += 32 + size
                records += 1
                samples += count
            assert offset == len(payload) and records == stream["records"] and samples == stream["samples"]
            actual_bytes += len(payload)
        assert actual_bytes == manifest["bytes_written"]
        request(f"/api/files/{session_id}/unlisted.bin", expected=404)
        request("/api/sessions/missing", expected=404)
        second, _ = request("/api/sessions/start", {"device_ids": ["sim-imu"]}, expected=201)
        time.sleep(0.05)
        second_stop, _ = request("/api/sessions/stop", {})
        assert second_stop["session"]["device_ids"] == ["sim-imu"]
        assert second["session_id"] != session_id
        assert b"SYNDAQ test" in request("/")[0]
        assert b"SYNDAQ test" in request("/recordings/history")[0]
        assert b"static asset" in request("/app.js")[0]
        request("/api/missing", expected=404)
        process.terminate()
        process.wait(timeout=10)
        process = launch()
        sessions, _ = request("/api/sessions")
        assert len(sessions["sessions"]) == 2
        assert request(f"/api/sessions/{session_id}")[0]["status"] == "complete"
        print("HTTP validation passed: API contracts, four-modality recording, binary counters, CORS, file whitelist, static SPA, restart.")
        print(f"Validation artifacts: {test_dir}")
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
