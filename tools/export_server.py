"""Loopback-only background export service, separate from native acquisition."""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

try:
    from .export_session import export_session, formats
    from .session_data import SAFE_ID, SessionError, load_session
except ImportError:
    from export_session import export_session, formats
    from session_data import SAFE_ID, SessionError, load_session

JOB_ID = re.compile(r"^[a-f0-9]{32}$")
ALLOWED_ORIGINS = {f"http://{host}:{port}" for host in ("localhost", "127.0.0.1")
                   for port in (5173, 4173, 8765, 8766)}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobManager:
    def __init__(self, data_root: Path, output_root: Path, workers: int = 1, capacity: int = 8):
        self.data_root = data_root.resolve()
        self.output_root = output_root.resolve()
        self.output_root.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.capacity = threading.BoundedSemaphore(capacity)
        self.executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="offline-export")
        self._restore()

    def _persist_locked(self) -> None:
        """Publish one complete metadata snapshot; a crash never leaves half JSON."""
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".jobs-", suffix=".tmp",
                                             dir=self.output_root, delete=False) as file:
                temporary = Path(file.name)
                json.dump({"schema_version": 1, "jobs": list(self.jobs.values())}, file,
                          ensure_ascii=False, allow_nan=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            temporary.replace(self.output_root / "jobs.json")
        except OSError:
            logging.exception("Could not persist export history")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _restore(self) -> None:
        metadata = (self.output_root / "jobs.json").resolve()
        if metadata.parent != self.output_root or not metadata.is_file():
            return
        try:
            if metadata.stat().st_size > 4 * 1024 * 1024:
                raise ValueError("export history is too large")
            saved = json.loads(metadata.read_text(encoding="utf-8"))
            if not isinstance(saved, dict) or saved.get("schema_version") != 1 or not isinstance(saved.get("jobs"), list):
                raise ValueError("invalid export history schema")
            allowed_formats = {item["id"] for item in formats()}
            for item in saved["jobs"][-100:]:
                if not isinstance(item, dict):
                    continue
                identifier = item.get("id")
                session_id = item.get("session_id")
                export_format = item.get("format")
                if not isinstance(identifier, str) or not JOB_ID.fullmatch(identifier):
                    continue
                if item.get("job_id", identifier) != identifier:
                    continue
                if not isinstance(session_id, str) or not SAFE_ID.fullmatch(session_id):
                    continue
                if not isinstance(export_format, str) or export_format not in allowed_formats:
                    continue
                filename = f"{session_id}-{export_format}-{identifier[:8]}.zip"
                if item.get("filename") != filename:
                    continue
                status = item.get("status")
                if status not in ("pending", "running", "complete", "error"):
                    continue
                progress = item.get("progress", 0)
                if not isinstance(progress, (int, float)) or not math.isfinite(progress) or not 0 <= progress <= 1:
                    continue
                job = {"id": identifier, "job_id": identifier, "session_id": session_id, "format": export_format,
                       "filename": filename, "status": status, "progress": progress,
                       "error": str(item.get("error"))[:2000] if item.get("error") else None,
                       "created_at": str(item.get("created_at", ""))[:100],
                       "completed_at": str(item.get("completed_at", ""))[:100] if item.get("completed_at") else None,
                       "download_url": None}
                if status in ("pending", "running"):
                    job.update(status="error", error="Export interrupted by service restart; submit a new export.", completed_at=now())
                elif status == "complete":
                    archive = (self.output_root / f"{identifier}.zip").resolve()
                    if archive.parent == self.output_root and archive.is_file():
                        job.update(download_url=f"/api/export/download/{identifier}", progress=1.0, bytes=archive.stat().st_size)
                    else:
                        job.update(status="error", error="Export archive is missing after service restart.", completed_at=now())
                self.jobs[identifier] = job
            with self.lock:
                self._persist_locked()
        except (OSError, ValueError, TypeError):
            logging.exception("Ignoring invalid export history")

    def submit(self, session_id: str, export_format: str) -> str:
        load_session(self.data_root, session_id)
        selected = next((item for item in formats() if item["id"] == export_format), None)
        if not selected or not selected["available"]:
            raise SessionError(selected["reason"] if selected else "unsupported export format")
        if not self.capacity.acquire(blocking=False):
            raise OverflowError("export queue is full; wait for an existing export to finish")
        identifier = uuid.uuid4().hex
        job = {"id": identifier, "job_id": identifier, "session_id": session_id, "format": export_format,
               "status": "pending", "progress": 0.0, "filename": f"{session_id}-{export_format}-{identifier[:8]}.zip",
               "error": None, "created_at": now(), "completed_at": None, "download_url": None}
        with self.lock:
            # Keep UI history bounded. Export files are retained on disk for the user.
            if len(self.jobs) >= 100:
                old = next((key for key, value in self.jobs.items() if value["status"] in ("complete", "error")), None)
                if old:
                    del self.jobs[old]
            self.jobs[identifier] = job
            self._persist_locked()
        try:
            self.executor.submit(self._run, identifier)
        except Exception:
            with self.lock:
                del self.jobs[identifier]
                self._persist_locked()
            self.capacity.release()
            raise
        return identifier

    def _update(self, identifier: str, **values) -> None:
        with self.lock:
            self.jobs[identifier].update(values)
            self._persist_locked()

    def _run(self, identifier: str) -> None:
        try:
            job = self.get(identifier)
            self._update(identifier, status="running")
            output = self.output_root / f"{identifier}.zip"
            export_session(self.data_root, job["session_id"], job["format"], output,
                           progress=lambda value: self._update(identifier, progress=value))
            self._update(identifier, status="complete", progress=1.0, completed_at=now(),
                         download_url=f"/api/export/download/{identifier}", bytes=output.stat().st_size)
        except Exception as exc:
            logging.exception("Export %s failed", identifier)
            self._update(identifier, status="error", error=str(exc), completed_at=now())
        finally:
            self.capacity.release()

    def get(self, identifier: str) -> dict:
        if not isinstance(identifier, str) or not JOB_ID.fullmatch(identifier):
            raise SessionError("invalid export job id")
        with self.lock:
            if identifier not in self.jobs:
                raise KeyError("export job not found")
            return dict(self.jobs[identifier])

    def list(self) -> list[dict]:
        with self.lock:
            return [dict(job) for job in reversed(list(self.jobs.values()))]

    def close(self) -> None:
        self.executor.shutdown(wait=True)


def make_handler(manager: JobManager):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MultimodalExport/0.1"

        def _allowed(self) -> bool:
            origin = self.headers.get("Origin")
            return origin is None or origin in ALLOWED_ORIGINS

        def _headers(self) -> None:
            origin = self.headers.get("Origin")
            if origin in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")

        def _json(self, status: int, content: dict) -> None:
            payload = json.dumps(content, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self._headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_OPTIONS(self) -> None:
            if not self._allowed():
                self._json(403, {"error": "origin is not allowed"})
                return
            self.send_response(204)
            self._headers()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            if not self._allowed():
                self._json(403, {"error": "origin is not allowed"})
                return
            path = unquote(urlsplit(self.path).path).rstrip("/")
            try:
                if path == "/api/export/health":
                    self._json(200, {"status": "ok", "version": "0.1.0", "service": "offline-export"})
                elif path == "/api/export/formats":
                    self._json(200, {"formats": formats()})
                elif path == "/api/export/jobs":
                    self._json(200, {"jobs": manager.list()})
                elif path.startswith("/api/export/jobs/"):
                    self._json(200, manager.get(path[len("/api/export/jobs/"):]))
                elif path.startswith("/api/export/download/"):
                    identifier = path[len("/api/export/download/"):]
                    job = manager.get(identifier)
                    if job["status"] != "complete":
                        self._json(409, {"error": "export is not complete"})
                        return
                    file = (manager.output_root / f"{identifier}.zip").resolve()
                    if file.parent != manager.output_root or not file.is_file():
                        self._json(404, {"error": "export archive not found"})
                        return
                    self.send_response(200)
                    self._headers()
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Disposition", f'attachment; filename="{job["filename"]}"')
                    self.send_header("Content-Length", str(file.stat().st_size))
                    self.end_headers()
                    with file.open("rb") as source:
                        while data := source.read(256 * 1024):
                            self.wfile.write(data)
                else:
                    self._json(404, {"error": "endpoint not found"})
            except SessionError as exc:
                self._json(400, {"error": str(exc)})
            except KeyError as exc:
                self._json(404, {"error": str(exc).strip("'")})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_POST(self) -> None:
            if not self._allowed():
                self._json(403, {"error": "origin is not allowed"})
                return
            if urlsplit(self.path).path.rstrip("/") != "/api/export/jobs":
                self._json(404, {"error": "endpoint not found"})
                return
            try:
                if self.headers.get_content_type() != "application/json":
                    self._json(415, {"error": "Content-Type must be application/json"})
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16 * 1024:
                    self._json(413, {"error": "request body must be between 1 and 16384 bytes"})
                    return
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or not isinstance(body.get("session_id"), str) or not isinstance(body.get("format"), str):
                    raise SessionError("session_id and format must be strings")
                identifier = manager.submit(body["session_id"], body["format"])
                self._json(202, {"job_id": identifier, "id": identifier, "status": "pending"})
            except (SessionError, ValueError, UnicodeDecodeError) as exc:
                self._json(400, {"error": str(exc)})
            except OverflowError as exc:
                self._json(429, {"error": str(exc)})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data/sessions"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/exports"))
    parser.add_argument("--port", type=int, default=8766)
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    manager = JobManager(arguments.data_dir, arguments.output_dir)
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), make_handler(manager))
    server.daemon_threads = True
    print(f"Offline export service http://127.0.0.1:{arguments.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        manager.close()


if __name__ == "__main__":
    main()
