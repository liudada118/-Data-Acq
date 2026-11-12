"""Offline, versioned export adapters. Recording never waits for this process."""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import shutil
import struct
import tempfile
import zipfile
from pathlib import Path
from typing import Callable

import numpy as np

try:
    from .session_data import SessionError, channel_names, iter_records, load_session, modality, sample_times, stream_layout
except ImportError:
    from session_data import SessionError, channel_names, iter_records, load_session, modality, sample_times, stream_layout

Progress = Callable[[float], None]
MAX_ARRAY_BYTES = 256 * 1024 * 1024
TIME_FIELDS = ("sequence", "record_device_time_ns", "record_host_time_ns", "sample_count", "sample_offset")


def formats() -> list[dict]:
    specifications = [
        ("csv", "CSV", "表格数据 + WAV 音频 + 无损图像序列", ("PIL",)),
        ("parquet", "Parquet", "类型化列式表格 + WAV 音频 + 无损图像序列", ("pyarrow", "PIL")),
        ("hdf5", "HDF5", "分块多维数组、原始音频及时间索引 + 无损图像序列", ("h5py", "PIL")),
        ("npz", "NumPy NPZ", "数值数组、原始音频及时间索引；单流上限 256 MiB", ("PIL",)),
        ("mat", "MATLAB MAT", "MAT v5 数值数组、原始音频及时间索引；单流上限 256 MiB", ("scipy", "PIL")),
        ("wav", "WAV + PNG", "IEEE float32 WAV 音频 + 无损图像序列 + 数值 CSV", ("PIL",)),
        ("json", "JSON + 原始数据", "会话元数据与原始二进制流，附读取脚本", ()),
    ]
    result = []
    for identifier, label, description, modules in specifications:
        missing = [module for module in modules if importlib.util.find_spec(module) is None]
        result.append({"id": identifier, "label": label, "available": not missing,
                       "description": description, "reason": f"缺少依赖：{', '.join(missing)}" if missing else None})
    result.append({"id": "mp4", "label": "MP4", "available": False,
                   "description": "视频编码扩展", "reason": "本版尚未配置视频编码器；可导出无损 PNG 图像序列"})
    return result


def _json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _rate(stream: dict) -> float:
    return float(stream.get("sample_rate", stream.get("sample_rate_hz")))


def _csv_stream(source: Path, stream: dict, target: Path) -> None:
    with target.open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["sequence", "sample_index_in_record", "sample_device_time_ns",
                         "record_device_time_ns", "record_host_time_ns", *channel_names(stream)])
        for record in iter_records(source, stream):
            times = sample_times(record, _rate(stream))
            values = record.values.reshape(record.sample_count, -1)
            writer.writerows([record.sequence, index, int(times[index]), record.device_time_ns,
                              record.host_time_ns, *row.tolist()] for index, row in enumerate(values))


def _parquet_stream(source: Path, stream: dict, target: Path) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq
    names = channel_names(stream)
    schema = pa.schema([(name, pa.int64()) for name in ("sequence", "sample_index_in_record", "sample_device_time_ns",
                        "record_device_time_ns", "record_host_time_ns")] + [(name, pa.float32()) for name in names],
                       metadata={b"stream_metadata": json.dumps(stream, ensure_ascii=False).encode("utf-8")})
    # A row group per sample is inefficient. Accumulate bounded batches instead.
    pending: list = []
    rows = 0
    pending_bytes = 0
    with pq.ParquetWriter(target, schema, compression="zstd") as writer:
        def flush() -> None:
            nonlocal rows, pending_bytes
            if not pending:
                return
            arrays = [[] for _ in range(5 + len(names))]
            for record in pending:
                count = record.sample_count
                arrays[0].append(np.full(count, record.sequence, dtype=np.int64))
                arrays[1].append(np.arange(count, dtype=np.int64))
                arrays[2].append(sample_times(record, _rate(stream)))
                arrays[3].append(np.full(count, record.device_time_ns, dtype=np.int64))
                arrays[4].append(np.full(count, record.host_time_ns, dtype=np.int64))
                values = record.values.reshape(count, -1)
                for index in range(len(names)):
                    arrays[index + 5].append(values[:, index])
            table = pa.Table.from_arrays([pa.array(np.concatenate(parts), type=schema[index].type)
                                          for index, parts in enumerate(arrays)], schema=schema)
            writer.write_table(table)
            pending.clear()
            rows = 0
            pending_bytes = 0
        for record in iter_records(source, stream):
            pending.append(record)
            rows += record.sample_count
            pending_bytes += record.values.nbytes
            if rows >= 2048 or pending_bytes >= 4 * 1024 * 1024:
                flush()
        flush()


def _arrays(source: Path, stream: dict) -> dict[str, np.ndarray]:
    dtype, shape = stream_layout(stream)
    expected_samples = int(stream.get("samples", 0))
    expected_records = int(stream.get("records", 0))
    estimated = expected_samples * math.prod(shape) * dtype.itemsize + expected_records * 5 * 8
    if expected_samples < 0 or expected_records < 0 or estimated > MAX_ARRAY_BYTES:
        raise SessionError("this stream exceeds the 256 MiB NPZ/MAT working-set limit; use HDF5 or Parquet")
    data = np.empty((expected_samples, *shape), dtype=dtype)
    headers = np.empty((expected_records, 5), dtype=np.int64)
    offset = record_index = 0
    for record in iter_records(source, stream):
        if offset + record.sample_count > expected_samples or record_index >= expected_records:
            raise SessionError("stream has more data than the manifest declares")
        data[offset:offset + record.sample_count] = record.values
        headers[record_index] = (record.sequence, record.device_time_ns, record.host_time_ns, record.sample_count, offset)
        offset += record.sample_count
        record_index += 1
    if offset != expected_samples or record_index != expected_records:
        raise SessionError("stream has fewer records than the manifest declares")
    return {"data": data, **{field: headers[:, index] for index, field in enumerate(TIME_FIELDS)}}


def _hdf5_stream(source: Path, stream: dict, target: Path) -> None:
    import h5py
    dtype, shape = stream_layout(stream)
    chunk_rows = max(1, min(2048, (256 * 1024) // (math.prod(shape) * dtype.itemsize)))
    with h5py.File(target, "w") as file:
        file.attrs["stream_metadata_json"] = json.dumps(stream, ensure_ascii=False)
        data = file.create_dataset("data", shape=(0, *shape), maxshape=(None, *shape),
                                   dtype=dtype, chunks=(chunk_rows, *shape), compression="gzip", compression_opts=1)
        headers = {field: file.create_dataset(field, shape=(0,), maxshape=(None,), dtype="<i8", chunks=True)
                   for field in TIME_FIELDS}
        # Buffer a few records to avoid one HDF5 metadata update per sample.
        pending: list = []
        payload = 0
        sample_offset = record_offset = 0
        def flush() -> None:
            nonlocal sample_offset, record_offset, payload
            if not pending:
                return
            values = np.concatenate([record.values for record in pending], axis=0)
            data.resize(sample_offset + len(values), axis=0)
            data[sample_offset:sample_offset + len(values)] = values
            metadata = []
            offset = sample_offset
            for record in pending:
                metadata.append((record.sequence, record.device_time_ns, record.host_time_ns, record.sample_count, offset))
                offset += record.sample_count
            metadata = np.asarray(metadata, dtype=np.int64)
            for index, field in enumerate(TIME_FIELDS):
                headers[field].resize(record_offset + len(pending), axis=0)
                headers[field][record_offset:record_offset + len(pending)] = metadata[:, index]
            sample_offset += len(values)
            record_offset += len(pending)
            pending.clear()
            payload = 0
        for record in iter_records(source, stream):
            pending.append(record)
            payload += record.values.nbytes
            if payload >= 256 * 1024:
                flush()
        flush()


def _audio(source: Path, stream: dict, directory: Path) -> None:
    """Write IEEE float32 WAVE without quantizing or clipping the raw samples."""
    directory.mkdir(parents=True, exist_ok=True)
    _, shape = stream_layout(stream)
    channels = math.prod(shape)
    rate = _rate(stream)
    if rate != int(rate) or channels > 32:
        raise SessionError("WAV requires an integer sample rate and at most 32 channels")
    if int(stream.get("payload_bytes", 0)) > 0xFFFFFFFF - 64:
        raise SessionError("WAV export exceeds RIFF's 4 GiB limit; export HDF5 or raw data")
    with (directory / "audio.wav").open("wb") as wave, (directory / "blocks.csv").open("w", encoding="utf-8", newline="") as index_file:
        index = csv.writer(index_file)
        index.writerow(["sequence", "record_device_time_ns", "record_host_time_ns", "sample_count", "sample_offset"])
        wave.write(b"RIFF\x00\x00\x00\x00WAVE")
        wave.write(b"fmt " + struct.pack("<IHHIIHHH", 18, 3, channels, int(rate), int(rate) * channels * 4, channels * 4, 32, 0))
        wave.write(b"fact" + struct.pack("<I", 4))
        fact_position = wave.tell()
        wave.write(struct.pack("<I", 0))
        wave.write(b"data")
        data_size_position = wave.tell()
        wave.write(struct.pack("<I", 0))
        samples = total_bytes = 0
        for record in iter_records(source, stream):
            wave.write(record.values.astype("<f4", copy=False).tobytes())
            index.writerow([record.sequence, record.device_time_ns, record.host_time_ns, record.sample_count, samples])
            samples += record.sample_count
            total_bytes += record.values.nbytes
            if total_bytes > 0xFFFFFFFF - 64:
                raise SessionError("WAV export exceeds RIFF's 4 GiB limit")
        end = wave.tell()
        wave.seek(4)
        wave.write(struct.pack("<I", end - 8))
        wave.seek(fact_position)
        wave.write(struct.pack("<I", samples))
        wave.seek(data_size_position)
        wave.write(struct.pack("<I", total_bytes))


def _camera(source: Path, stream: dict, directory: Path) -> None:
    from PIL import Image
    if stream.get("dtype") != "uint8" or len(stream["shape"]) != 3 or stream["shape"][-1] != 3:
        raise SessionError("image export currently supports RGB8 camera streams")
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "frames.csv").open("w", encoding="utf-8", newline="") as file:
        index = csv.writer(file)
        index.writerow(["filename", "sequence", "sample_index_in_record", "record_device_time_ns", "record_host_time_ns"])
        frame_index = 0
        for record in iter_records(source, stream):
            for sample_index, frame in enumerate(record.values):
                filename = f"frame_{frame_index:08d}.png"
                Image.fromarray(frame).save(directory / filename, compress_level=1)
                index.writerow([filename, record.sequence, sample_index, record.device_time_ns, record.host_time_ns])
                frame_index += 1


def export_session(data_root: Path, session_id: str, export_format: str, output_file: Path,
                   progress: Progress = lambda value: None) -> dict:
    source, manifest = load_session(data_root, session_id)
    selected = next((item for item in formats() if item["id"] == export_format), None)
    if not selected or not selected["available"]:
        raise SessionError(selected["reason"] if selected else "unsupported export format")
    output_file = output_file.resolve()
    output_file.parent.mkdir(parents=True, exist_ok=True)
    report = {"schema_version": 1, "session_id": session_id, "format": export_format,
              "source": manifest.get("source", manifest.get("mode", "unknown")),
              "timestamp_policy": "Original record timestamps and sequence numbers are retained. Per-sample device timestamps in CSV/Parquet are derived from the original block start and nominal sample rate; no cross-stream alignment or resampling is performed.",
              "audio_encoding": "IEEE float32 WAV (WAVE format 3), no PCM16 quantization",
              "camera_encoding": "Lossless RGB8 PNG sequence with original record timestamp index",
              "numeric_precision": "Raw float32 values retained; CSV uses round-trippable Python float text",
              "streams": [], "warnings": []}
    temporary_archive = output_file.with_suffix(".partial")
    try:
        with tempfile.TemporaryDirectory(prefix="mdaq-export-", dir=output_file.parent) as temporary:
            directory = Path(temporary)
            _json(directory / "manifest.json", manifest)
            for index, stream in enumerate(manifest["streams"]):
                identifier = stream["id"]
                kind = modality(stream)
                if export_format == "json":
                    # Iterating validates the entire stream, including finalized counts.
                    for _ in iter_records(source, stream):
                        pass
                    shutil.copyfile(source / stream["file"], directory / stream["file"])
                else:
                    if kind == "camera":
                        _camera(source, stream, directory / identifier)
                    else:
                        if kind == "audio":
                            _audio(source, stream, directory / identifier)
                        if export_format in ("csv", "wav") and kind != "audio":
                            _csv_stream(source, stream, directory / f"{identifier}.csv")
                        elif export_format == "parquet" and kind != "audio":
                            _parquet_stream(source, stream, directory / f"{identifier}.parquet")
                        elif export_format == "hdf5":
                            _hdf5_stream(source, stream, directory / f"{identifier}.h5")
                        elif export_format == "npz":
                            arrays = _arrays(source, stream)
                            arrays["metadata_json"] = np.array(json.dumps(stream, ensure_ascii=False))
                            np.savez_compressed(directory / f"{identifier}.npz", **arrays)
                            del arrays
                        elif export_format == "mat":
                            from scipy.io import savemat
                            arrays = _arrays(source, stream)
                            arrays["metadata_json"] = json.dumps(stream, ensure_ascii=False)
                            savemat(directory / f"{identifier}.mat", arrays, format="5", do_compression=True, oned_as="column")
                            del arrays
                report["streams"].append({"id": identifier, "kind": kind,
                                          "samples": stream.get("samples"), "shape": stream["shape"]})
                progress((index + 1) / (len(manifest["streams"]) + 1))
            if export_format == "json":
                # Reader remains usable outside the checkout with NumPy installed.
                shutil.copyfile(Path(__file__).with_name("session_data.py"), directory / "session_data.py")
                report["warnings"].append("JSON package includes native binary streams; use the included session_data.py reader with NumPy.")
            _json(directory / "export_report.json", report)
            _json(directory / "schema.json", {"record_format": manifest.get("binary"),
                  "clock": manifest.get("clock"), "streams": manifest["streams"],
                  "native_array_layout": "sample-first, C row-major, little-endian"})
            with zipfile.ZipFile(temporary_archive, "w", compression=zipfile.ZIP_DEFLATED,
                                 compresslevel=1, allowZip64=True) as archive:
                for path in directory.rglob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(directory).as_posix())
        temporary_archive.replace(output_file)
        progress(1.0)
        return report
    except Exception:
        temporary_archive.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data/sessions"))
    parser.add_argument("--session", required=True)
    parser.add_argument("--format", required=True, choices=[item["id"] for item in formats()])
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    result = export_session(arguments.data_dir, arguments.session, arguments.format, arguments.output)
    print(json.dumps({"output": str(arguments.output.resolve()), "streams": result["streams"]}, ensure_ascii=False))
