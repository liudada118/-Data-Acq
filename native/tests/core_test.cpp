#include "engine.hpp"

#include <chrono>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}
template <typename T> T read_little(std::istream& input) {
    std::make_unsigned_t<T> result{};
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        const auto value = input.get();
        if (value == std::char_traits<char>::eof()) throw std::runtime_error("truncated header");
        result |= static_cast<std::make_unsigned_t<T>>(static_cast<unsigned char>(value)) << (8 * i);
    }
    return static_cast<T>(result);
}
}

int main() {
    try {
        const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
        const auto root = std::filesystem::absolute("validation-sessions") / ("core-" + std::to_string(suffix));
        std::string first_id;
        {
            capture::CaptureEngine engine(root);
            require(engine.devices().size() == 4, "four simulated adapters must be discoverable");
            require(engine.status()["state"] == "idle", "new engine must be idle");
            bool rejected = false;
            try { engine.start_recording({{"device_ids", {"missing"}}}); } catch (const std::invalid_argument&) { rejected = true; }
            require(rejected, "unknown device must be rejected");
            rejected = false;
            try { engine.start_recording({{"device_ids", capture::json::array()}}); } catch (const std::invalid_argument&) { rejected = true; }
            require(rejected, "empty selection must be rejected");

            auto recording = engine.start_recording({{"name", "binary-validation"},
                {"device_ids", {"sim-pressure", "sim-audio", "sim-imu", "sim-camera"}}});
            first_id = recording["id"];
            rejected = false;
            try { engine.start_recording({{"device_ids", {"sim-imu"}}}); } catch (const std::logic_error&) { rejected = true; }
            require(rejected, "concurrent start must be rejected");
            std::this_thread::sleep_for(std::chrono::milliseconds(1250));
            require(engine.status()["state"] == "recording", "recording must remain active");
            const auto preview = engine.preview();
            require(preview["camera"]["width"] == 160, "camera preview width");
            require(preview["pressure"]["values"].size() == 256, "pressure preview dimensions");
            require(preview["imu"]["values"].size() == 6, "IMU preview dimensions");
            auto stopped = engine.stop_recording();
            require(stopped["status"] == "complete", "healthy recording must finalize");
            require(stopped.value("finalized", false), "stop response must be finalized");
            require(stopped["dropped_batches"] == 0, "recording should not drop batches");
            require(engine.status()["queue_depth"] == 0, "stop must drain queue");
            const auto manifest = engine.session(first_id);
            require(manifest["finalized"] == true, "manifest must be finalized");
            require(stopped == manifest, "stop response must equal canonical persisted manifest");
            require(engine.sessions()[0] == manifest, "session list must return the same canonical manifest");
            std::uint64_t all_bytes = 0, all_records = 0;
            for (const auto& stream : manifest["streams"]) {
                const auto path = engine.session_path(first_id) / stream["file"].get<std::string>();
                std::ifstream file(path, std::ios::binary);
                std::array<char, 8> magic{}; file.read(magic.data(), 8);
                require(magic == capture::binary_magic, "binary magic must match");
                std::uint64_t records = 0, samples = 0, payload_bytes = 0, previous_sequence = 0;
                std::int64_t previous_time = -1;
                while (file.peek() != std::char_traits<char>::eof()) {
                    const auto sequence = read_little<std::uint64_t>(file);
                    const auto timestamp = read_little<std::int64_t>(file);
                    const auto host = read_little<std::int64_t>(file);
                    const auto count = read_little<std::uint32_t>(file);
                    const auto size = read_little<std::uint32_t>(file);
                    require(timestamp >= manifest["session_start_device_time_ns"].get<std::int64_t>(), "timestamp must follow session origin");
                    require(host > 0 && timestamp > previous_time, "timestamps must be monotonic");
                    if (records) require(sequence == previous_sequence + 1, "stream sequence must be contiguous");
                    const auto id = stream["id"].get<std::string>();
                    const auto expected = id == "sim-camera" ? 160u * 90u * 3u :
                        id == "sim-pressure" ? 16u * 16u * 4u : id == "sim-imu" ? 6u * 4u : 480u * 4u;
                    require(size == expected, "payload size must follow schema");
                    file.seekg(size, std::ios::cur); require(static_cast<bool>(file), "payload must be complete");
                    ++records; samples += count; payload_bytes += size;
                    previous_sequence = sequence; previous_time = timestamp;
                }
                require(records > 0, "each selected device must record data");
                require(records == stream["records"] && samples == stream["samples"], "manifest counters must match binary");
                require(payload_bytes == stream["payload_bytes"], "manifest payload byte count must match");
                const auto bytes = std::filesystem::file_size(path);
                require(bytes == 8 + records * 32 + payload_bytes, "file size must match record lengths");
                all_bytes += bytes; all_records += records;
            }
            require(all_bytes == manifest["bytes_written"], "session bytes must match files");
            require(all_records == manifest["record_count"], "session records must match files");
            auto second = engine.start_recording({{"device_ids", {"sim-imu"}}});
            std::this_thread::sleep_for(std::chrono::milliseconds(80));
            auto second_stop = engine.stop_recording();
            require(second_stop["device_ids"].size() == 1 && second_stop["record_counts"].size() == 1, "selection must isolate recording streams");
            require(second["id"] != first_id, "restarted session needs a new id");
            require(engine.stop_recording()["id"] == second["id"], "stop must be idempotent");
        }
        capture::CaptureEngine restarted(root);
        require(restarted.sessions().size() == 2, "sessions must survive service restart");
        require(restarted.session(first_id)["status"] == "complete", "persisted manifest must remain readable");
        std::cout << "Native core validation passed: binary headers, four modalities, counters, selection, restart, invalid requests.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Native core validation failed: " << error.what() << '\n';
        return 1;
    }
}
