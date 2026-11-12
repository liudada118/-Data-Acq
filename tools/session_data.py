"""Versioned, bounded reader for native mdaqbin-v1 session files."""
from __future__ import annotations

import json
import math
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

MAGIC = b"MDAQBIN1"
HEADER = struct.Struct("<QqqII")
SAFE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$")
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
DTYPES = {"float32": np.dtype("<f4"), "uint8": np.dtype("u1")}


class SessionError(ValueError):
    """A session is malformed, incomplete, or outside its configured root."""


@dataclass(frozen=True)
class Record:
    sequence: int
    device_time_ns: int
    host_time_ns: int
    sample_count: int
    values: np.ndarray


def contained_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not SAFE_ID.fullmatch(name):
        raise SessionError("invalid session id")
    root = root.resolve()
    result = (root / name).resolve()
    if result.parent != root:
        raise SessionError("path is outside the configured data directory")
    return result


def load_session(data_root: Path, session_id: str) -> tuple[Path, dict]:
    folder = contained_path(data_root, session_id)
    manifest_path = (folder / "manifest.json").resolve()
    if manifest_path.parent != folder or not manifest_path.is_file():
        raise SessionError("session manifest not found")
    if manifest_path.stat().st_size > 8 * 1024 * 1024:
        raise SessionError("session manifest is too large")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SessionError("invalid session manifest") from exc
    if manifest.get("status") not in ("complete", "completed") or manifest.get("finalized") is not True:
        raise SessionError("only finalized, complete recordings can be exported")
    if not isinstance(manifest.get("streams"), list) or not manifest["streams"]:
        raise SessionError("session contains no streams")
    seen = set()
    for stream in manifest["streams"]:
        stream_id = stream.get("id")
        if not isinstance(stream_id, str) or not SAFE_ID.fullmatch(stream_id) or stream_id in seen:
            raise SessionError("invalid or duplicate stream id")
        seen.add(stream_id)
        stream_path(folder, stream)
        stream_layout(stream)
    return folder, manifest


def stream_path(folder: Path, stream: dict) -> Path:
    filename = stream.get("file")
    if not isinstance(filename, str) or Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise SessionError("invalid stream file name")
    path = (folder / filename).resolve()
    if path.parent != folder.resolve() or not path.is_file():
        raise SessionError("stream file not found or outside the session directory")
    return path


def stream_layout(stream: dict) -> tuple[np.dtype, tuple[int, ...]]:
    try:
        dtype = DTYPES[stream["dtype"]]
        shape = tuple(stream["shape"])
        if not shape or len(shape) > 8 or any(type(v) is not int or v < 1 for v in shape):
            raise ValueError()
        if math.prod(shape) * dtype.itemsize > MAX_PAYLOAD_BYTES:
            raise ValueError()
        rate = float(stream.get("sample_rate", stream.get("sample_rate_hz", 0)))
        if not math.isfinite(rate) or rate <= 0:
            raise ValueError()
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise SessionError("invalid stream dtype, shape, or sampling rate") from exc
    return dtype, shape


def iter_records(folder: Path, stream: dict) -> Iterator[Record]:
    dtype, shape = stream_layout(stream)
    elements_per_sample = math.prod(shape)
    records = samples = payload_total = 0
    previous_seq = previous_device = -1
    with stream_path(folder, stream).open("rb") as source:
        if source.read(len(MAGIC)) != MAGIC:
            raise SessionError("invalid binary magic")
        while header := source.read(HEADER.size):
            if len(header) != HEADER.size:
                raise SessionError("truncated record header")
            sequence, device_ns, host_ns, count, byte_count = HEADER.unpack(header)
            expected = count * elements_per_sample * dtype.itemsize
            if count == 0 or byte_count != expected or byte_count > MAX_PAYLOAD_BYTES:
                raise SessionError("record payload length does not match its shape")
            if sequence <= previous_seq or device_ns < previous_device or host_ns < 0:
                raise SessionError("record sequence or timestamps are invalid")
            payload = source.read(byte_count)
            if len(payload) != byte_count:
                raise SessionError("truncated record payload")
            values = np.frombuffer(payload, dtype=dtype).reshape((count, *shape))
            records += 1
            samples += count
            payload_total += byte_count
            previous_seq, previous_device = sequence, device_ns
            yield Record(sequence, device_ns, host_ns, count, values)
    for key, actual in (("records", records), ("samples", samples), ("payload_bytes", payload_total)):
        if key in stream and stream[key] != actual:
            raise SessionError(f"stream {key} does not match its finalized manifest")


def channel_names(stream: dict) -> list[str]:
    _, shape = stream_layout(stream)
    count = math.prod(shape)
    names = stream.get("channels", [])
    if isinstance(names, list) and len(names) == count and all(isinstance(name, str) for name in names):
        return names
    if len(shape) == 2:
        return [f"r{row:02d}_c{col:02d}" for row in range(shape[0]) for col in range(shape[1])]
    return [f"channel_{index:03d}" for index in range(count)]


def modality(stream: dict) -> str:
    return stream.get("kind", stream.get("modality", "numeric"))


def sample_times(record: Record, rate: float) -> np.ndarray:
    """Derived sample timestamps; original block timestamps are always retained."""
    offsets = np.rint(np.arange(record.sample_count) * (1e9 / rate)).astype(np.int64)
    return offsets + record.device_time_ns
