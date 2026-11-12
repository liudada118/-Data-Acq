"""Round-trip checks for native payloads, export schemas and HTTP boundaries."""
from __future__ import annotations

import csv
import io
import json
import struct
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.io import loadmat, wavfile

from tools.export_server import JobManager, ThreadingHTTPServer, make_handler
from tools.export_session import export_session, formats
from tools.session_data import HEADER, MAGIC, SessionError, iter_records, load_session


def fixture(root: Path) -> tuple[str, dict, dict]:
    identifier = "session-fixture"
    folder = root / identifier
    folder.mkdir(parents=True)
    streams = []
    values = {
        "sim-pressure": [np.arange(8, dtype="<f4").reshape(2, 2, 2)],
        "sim-imu": [np.array([[1, 2, 3, 4, 5, 6]], dtype="<f4"), np.array([[7, 8, 9, 10, 11, 12]], dtype="<f4")],
        "sim-audio": [np.array([[0.1], [-0.25], [1.25]], dtype="<f4"), np.array([[0.125], [0], [-1.1]], dtype="<f4")],
        "sim-camera": [np.arange(24, dtype=np.uint8).reshape(2, 2, 2, 3)],
    }
    for identifier_, arrays in values.items():
        kind = identifier_.split("-")[1]
        rate = {"pressure": 100, "imu": 200, "audio": 48000, "camera": 15}[kind]
        stream = {"id": identifier_, "modality": kind, "dtype": "uint8" if kind == "camera" else "float32",
                  "shape": list(arrays[0].shape[1:]), "sample_rate": rate, "file": f"{identifier_}.bin",
                  "records": len(arrays), "samples": sum(len(array) for array in arrays),
                  "payload_bytes": sum(array.nbytes for array in arrays), "units": ["kPa"] if kind == "pressure" else []}
        if kind == "imu":
            stream["channels"] = ["ax", "ay", "az", "gx", "gy", "gz"]
        with (folder / stream["file"]).open("wb") as file:
            file.write(MAGIC)
            for index, array in enumerate(arrays):
                file.write(HEADER.pack(50 + index, 1000000000 + index * 10000000, 9000000000 + index * 10000000, len(array), array.nbytes))
                file.write(array.tobytes())
        streams.append(stream)
    manifest = {"id": identifier, "session_id": identifier, "status": "complete", "finalized": True,
                "name": "Test session", "source": "simulation", "session_start_device_time_ns": 1000000000,
                "clock": {"device_time": "nanoseconds since native engine start"},
                "binary": {"magic": "MDAQBIN1", "record_header": "<QqqII"}, "streams": streams}
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return identifier, manifest, values


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.identifier, self.manifest, self.values = fixture(self.root / "sessions")

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, export_format: str) -> zipfile.ZipFile:
        output = self.root / f"{export_format}.zip"
        export_session(self.root / "sessions", self.identifier, export_format, output)
        return zipfile.ZipFile(output)

    def test_reader_preserves_batch_shape_and_original_clocks(self):
        folder, manifest = load_session(self.root / "sessions", self.identifier)
        stream = next(item for item in manifest["streams"] if item["id"] == "sim-pressure")
        record = list(iter_records(folder, stream))[0]
        self.assertEqual(record.values.shape, (2, 2, 2))
        self.assertEqual(record.device_time_ns, 1000000000)
        self.assertEqual(record.host_time_ns, 9000000000)
        np.testing.assert_array_equal(record.values, self.values["sim-pressure"][0])

    def test_corrupt_truncated_and_manifest_mismatch_are_rejected(self):
        folder, manifest = load_session(self.root / "sessions", self.identifier)
        stream = manifest["streams"][0]
        path = folder / stream["file"]
        original = path.read_bytes()
        path.write_bytes(original[:-1])
        with self.assertRaisesRegex(SessionError, "truncated"):
            list(iter_records(folder, stream))
        path.write_bytes(original)
        with self.assertRaisesRegex(SessionError, "records"):
            list(iter_records(folder, {**stream, "records": 99}))
        malformed = bytearray(original)
        malformed[8 + HEADER.size - 4:8 + HEADER.size] = struct.pack("<I", 1)
        path.write_bytes(malformed)
        with self.assertRaisesRegex(SessionError, "payload length"):
            list(iter_records(folder, stream))

    def test_sessions_and_streams_cannot_escape_their_roots(self):
        with self.assertRaises(SessionError):
            load_session(self.root / "sessions", "../outside")
        manifest_path = self.root / "sessions" / self.identifier / "manifest.json"
        invalid = {**self.manifest, "streams": [{**self.manifest["streams"][0], "file": "../../secret.bin"}]}
        manifest_path.write_text(json.dumps(invalid), encoding="utf-8")
        with self.assertRaises(SessionError):
            load_session(self.root / "sessions", self.identifier)
        manifest_path.write_text(json.dumps({**self.manifest, "status": "recording"}), encoding="utf-8")
        with self.assertRaisesRegex(SessionError, "finalized"):
            load_session(self.root / "sessions", self.identifier)

    def test_csv_and_lossless_media_roundtrip(self):
        with self.archive("csv") as archive:
            rows = list(csv.DictReader(io.StringIO(archive.read("sim-pressure.csv").decode())))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[1]["sample_device_time_ns"], "1010000000")
            self.assertEqual(rows[1]["record_device_time_ns"], "1000000000")
            self.assertEqual(float(rows[1]["r01_c01"]), 7)
            rate, audio = wavfile.read(io.BytesIO(archive.read("sim-audio/audio.wav")))
            self.assertEqual(rate, 48000)
            self.assertEqual(audio.dtype, np.dtype("float32"))
            np.testing.assert_array_equal(audio, np.concatenate(self.values["sim-audio"]).ravel())
            image = np.array(Image.open(io.BytesIO(archive.read("sim-camera/frame_00000001.png"))))
            np.testing.assert_array_equal(image, self.values["sim-camera"][0][1])
            report = json.loads(archive.read("export_report.json"))
            self.assertIn("no PCM16", report["audio_encoding"])

    def test_npz_hdf5_parquet_and_mat_are_readable_by_their_target_libraries(self):
        available = {item["id"] for item in formats() if item["available"]}
        if "npz" in available:
            with self.archive("npz") as archive, np.load(io.BytesIO(archive.read("sim-pressure.npz")), allow_pickle=False) as dataset:
                np.testing.assert_array_equal(dataset["data"], self.values["sim-pressure"][0])
                np.testing.assert_array_equal(dataset["record_device_time_ns"], [1000000000])
                self.assertEqual(dataset["data"].dtype, np.dtype("float32"))
        if "hdf5" in available:
            import h5py
            with self.archive("hdf5") as archive, h5py.File(io.BytesIO(archive.read("sim-audio.h5")), "r") as dataset:
                np.testing.assert_array_equal(dataset["data"][:], np.concatenate(self.values["sim-audio"]))
                np.testing.assert_array_equal(dataset["sample_offset"][:], [0, 3])
        if "parquet" in available:
            import pyarrow.parquet as pq
            with self.archive("parquet") as archive:
                table = pq.read_table(io.BytesIO(archive.read("sim-imu.parquet")))
                self.assertEqual(table["ax"].to_pylist(), [1, 7])
                self.assertEqual(table["record_host_time_ns"].to_pylist(), [9000000000, 9010000000])
        if "mat" in available:
            with self.archive("mat") as archive:
                data = loadmat(io.BytesIO(archive.read("sim-pressure.mat")))
                np.testing.assert_array_equal(data["data"], self.values["sim-pressure"][0])
                self.assertEqual(data["data"].dtype, np.dtype("float32"))

    def test_raw_json_package_has_identical_binary_and_reader(self):
        with self.archive("json") as archive:
            self.assertEqual(archive.read("sim-pressure.bin"), (self.root / "sessions" / self.identifier / "sim-pressure.bin").read_bytes())
            self.assertIn("session_data.py", archive.namelist())

    def test_http_job_reaches_complete_and_rejects_untrusted_origin(self):
        manager = JobManager(self.root / "sessions", self.root / "exports")
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(manager))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            request = urllib.request.Request(base + "/api/export/jobs", data=json.dumps({"session_id": self.identifier, "format": "npz"}).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 202)
                identifier = json.load(response)["job_id"]
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                with urllib.request.urlopen(base + f"/api/export/jobs/{identifier}") as response:
                    job = json.load(response)
                if job["status"] in ("complete", "error"):
                    break
                time.sleep(0.02)
            self.assertEqual(job["status"], "complete", job)
            with urllib.request.urlopen(base + job["download_url"]) as response:
                with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
                    self.assertIn("sim-pressure.npz", archive.namelist())
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(base + "/api/export/formats", headers={"Origin": "https://untrusted.example"}))
            self.assertEqual(error.exception.code, 403)
        finally:
            server.shutdown()
            server.server_close()
            manager.close()
            thread.join()

    def test_export_history_restores_download_and_marks_interrupted_jobs(self):
        output = self.root / "exports"
        manager = JobManager(self.root / "sessions", output)
        identifier = manager.submit(self.identifier, "npz")
        manager.close()
        original = manager.get(identifier)
        self.assertEqual(original["status"], "complete")
        metadata_path = output / "jobs.json"
        saved = json.loads(metadata_path.read_text(encoding="utf-8"))
        interrupted_id = uuid.uuid4().hex
        saved["jobs"].append({**original, "id": interrupted_id, "job_id": interrupted_id,
                              "filename": f"{self.identifier}-npz-{interrupted_id[:8]}.zip", "status": "running"})
        malicious_id = uuid.uuid4().hex
        saved["jobs"].append({**original, "id": malicious_id, "job_id": malicious_id,
                              "filename": "../../private.zip", "download_url": "/private"})
        metadata_path.write_text(json.dumps(saved), encoding="utf-8")
        restored = JobManager(self.root / "sessions", output)
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(restored))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urllib.request.urlopen(base + "/api/export/jobs") as response:
                jobs = json.load(response)["jobs"]
            self.assertEqual(len(jobs), 2)
            recovered = restored.get(identifier)
            self.assertEqual(recovered["status"], "complete")
            self.assertEqual(restored.get(interrupted_id)["status"], "error")
            self.assertIn("restart", restored.get(interrupted_id)["error"])
            with self.assertRaises(KeyError):
                restored.get(malicious_id)
            with urllib.request.urlopen(base + recovered["download_url"]) as response:
                with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
                    self.assertIn("sim-pressure.npz", archive.namelist())
        finally:
            server.shutdown()
            server.server_close()
            restored.close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
