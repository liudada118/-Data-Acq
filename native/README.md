# SYNDAQ native capture engine

C++20 service bound exclusively to `127.0.0.1:8765`. This MVP contains four explicit
simulated adapters; no real device driver is implemented. Acquisition and file
writing run on separate threads. The UI requests low-frequency previews and is
never on the raw recording path.

Build with an existing MSVC installation:

```powershell
cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64
cmake --build native/build --config Release --parallel
ctest --test-dir native/build -C Release --output-on-failure
python native/tests/http_test.py --exe native/build/Release/syndaq_engine.exe
native/build/Release/syndaq_engine.exe --data-dir data/sessions --web-dir frontend/dist
```

The root CMake build can include this directory with `add_subdirectory(native)`.
The executable target is `syndaq_engine`. No compiler download or system install
is needed on the development machine (MSVC 19.44 and Windows SDK 10.0.26100.0).

## Recording format

Each session directory has `manifest.json` and one `.bin` per selected stream.
The file begins with the eight bytes `MDAQBIN1`. Each record has a 32-byte
little-endian header, equivalent to Python `struct.Struct("<QqqII")`:

| Field | Type | Meaning |
| --- | --- | --- |
| sequence | uint64 | Per-stream batch sequence, generated since engine start |
| device_time_ns | int64 | First sample time in nanoseconds since engine start |
| host_time_ns | int64 | Host monotonic/steady clock nanoseconds |
| sample_count | uint32 | Number of samples/frames in this batch |
| payload_bytes | uint32 | Length of the following binary payload |

Payloads are contiguous little-endian `float32` for pressure `[16,16]`, IMU
`[6]`, audio `[sample_count,1]`; camera payloads are RGB `uint8[90,160,3]`.
Audio uses batches of 480 samples at 48 kHz. Pressure and IMU run at 100 and
200 Hz; camera runs at 15 frames/s. Simulation values are examples, without
hardware synchronization or calibration claims.

Manifest stream entries include shape, dtype, rates, units, channel names,
clock ID, filename, record/sample/payload counts and first/last device times.
`session_start_device_time_ns` and `session_start_host_time_ns` preserve the two
clock origins. Subtract the device origin to compute session-relative times.
The host and device values remain separate. Sessions are `recording`, `complete`
or `incomplete`; `finalized` distinguishes a normal stop from an interrupted
session. Stop drains the recording queue and closes all files before returning.

The queue is bounded to 4,096 records and 64 MiB. Overflow and write failures
increment loss counters and mark the session incomplete. The MVP does not claim
hard real-time behavior or a measured maximum hardware throughput. A process
crash may leave a non-finalized manifest and partial final record; consumers
must check `finalized` and record boundaries before export.

## API

- `GET /api/health`, `/api/devices`, `/api/status`, `/api/preview`
- `POST /api/sessions/start` with `{name, device_ids, profile?}`
- `POST /api/sessions/stop`
- `GET /api/sessions`, `/api/sessions/<id>`
- `GET /api/files/<id>/manifest.json` or a stream filename listed by its manifest

`GET /api/snapshot` and `/api/recordings/start|stop` are convenience aliases.
Camera preview is RGB8 base64 in JSON, intended for a canvas, not the raw data
transport. Raw downloads are limited to files named by each session manifest.
The service serves an existing React `dist` directory with SPA fallback.
CORS allows only loopback origins on ports 5173, 4173 and 8765.

Vendor dependencies are fixed: cpp-httplib `v0.18.3`, nlohmann/json `v3.11.3`.
Both headers and original MIT licenses are under `vendor/`; builds do not
download dependencies. Extend `DeviceAdapter` and register a driver to add
real hardware after its SDK/protocol and timing characteristics are available.
