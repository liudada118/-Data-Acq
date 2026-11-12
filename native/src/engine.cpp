#include "engine.hpp"

#include <algorithm>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <sstream>

namespace capture {
namespace {
std::int64_t steady_ns() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
std::string new_id() {
    const auto time = std::chrono::system_clock::now().time_since_epoch();
    return "session-" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(time).count()) +
        "-" + std::to_string(steady_ns() % 1000000);
}
json read_json_file(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("session not found");
    return json::parse(input);
}
}  // namespace

std::string utc_now() {
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
#ifdef _WIN32
    gmtime_s(&utc, &time);
#else
    gmtime_r(&time, &utc);
#endif
    std::ostringstream result;
    result << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
    return result.str();
}

CaptureEngine::CaptureEngine(std::filesystem::path data_root)
    : data_root_(std::filesystem::absolute(std::move(data_root))),
      adapters_(make_simulated_adapters()), origin_(std::chrono::steady_clock::now()) {
    std::filesystem::create_directories(data_root_);
    acquisition_thread_ = std::thread(&CaptureEngine::acquisition_loop, this);
    writer_thread_ = std::thread(&CaptureEngine::writer_loop, this);
}

CaptureEngine::~CaptureEngine() {
    try { stop_recording(); } catch (...) {}
    running_ = false;
    queue_ready_.notify_all();
    if (acquisition_thread_.joinable()) acquisition_thread_.join();
    if (writer_thread_.joinable()) writer_thread_.join();
}

json CaptureEngine::devices() const {
    json result = json::array();
    for (const auto& adapter : adapters_) result.push_back(adapter->descriptor().to_json());
    return result;
}

json CaptureEngine::recording_status(const std::shared_ptr<Recording>& recording) const {
    if (!recording) return nullptr;
    std::lock_guard lock(recording->mutex);
    json result = recording->manifest;
    std::uint64_t samples = 0, bytes = 0, records = 0;
    json streams = json::array();
    for (const auto& [id, stream] : recording->files) {
        samples += stream.samples; bytes += stream.bytes; records += stream.records;
        streams.push_back({{"id", id}, {"records", stream.records}, {"samples", stream.samples}, {"bytes", stream.bytes}});
    }
    result["written_samples"] = samples; result["written_bytes"] = bytes; result["written_records"] = records;
    result["bytes_written"] = bytes + records * 32 + recording->files.size() * 8;
    result["record_count"] = records;
    result["record_counts"] = json::object();
    for (const auto& [id, stream] : recording->files) result["record_counts"][id] = stream.records;
    result["stream_stats"] = streams; result["dropped_batches"] = recording->dropped_batches;
    result["error"] = recording->error.empty() ? json(nullptr) : json(recording->error);
    if (result.value("status", "") == "recording") {
        result["duration_seconds"] = std::chrono::duration<double>(std::chrono::steady_clock::now() - recording->started).count();
    }
    result["duration_s"] = result["duration_seconds"];
    return result;
}

json CaptureEngine::status() const {
    std::shared_ptr<Recording> active;
    bool stopping;
    std::size_t depth, bytes;
    {
        std::lock_guard lock(queue_mutex_);
        active = active_; stopping = stopping_; depth = queue_.size(); bytes = queue_bytes_;
    }
    auto recording = recording_status(active);
    return {{"state", stopping ? "stopping" : (active ? (recording["error"].is_null() ? "recording" : "error") : "idle")},
            {"session_id", active ? recording["id"] : json(nullptr)},
            {"elapsed_s", active ? recording.value("duration_s", 0.0) : 0.0},
            {"bytes_written", active ? recording.value("bytes_written", std::uint64_t{0}) : 0},
            {"queue_depth", depth}, {"queue_capacity", queue_record_limit_}, {"queue_bytes", bytes}, {"queue_limit_bytes", queue_limit_},
            {"dropped_records", active ? recording.value("dropped_batches", std::uint64_t{0}) : 0},
            {"record_counts", active ? recording["record_counts"] : json::object()},
            {"selected_ids", active ? recording["device_ids"] : json::array()},
            {"error", active ? recording["error"] : json(nullptr)}, {"source", "simulation"}};
}

json CaptureEngine::preview() const {
    json result = {{"timestamp_s", std::chrono::duration<double>(std::chrono::steady_clock::now() - origin_).count()}};
    {
        std::lock_guard lock(preview_mutex_);
        for (const auto& adapter : adapters_) {
            const auto& descriptor = adapter->descriptor();
            const auto found = previews_.find(descriptor.id);
            result[descriptor.modality] = found == previews_.end() ? json::object() : *found;
        }
    }
    result["status"] = status();
    return result;
}

json CaptureEngine::snapshot() const {
    json preview;
    json counters = json::object();
    {
        std::lock_guard lock(preview_mutex_);
        preview = previews_;
        for (const auto& [id, count] : generated_) counters[id] = count;
    }
    std::shared_ptr<Recording> active, last;
    std::size_t queued, high_water, queued_batches;
    {
        std::lock_guard lock(queue_mutex_);
        active = active_; last = last_; queued = queue_bytes_; high_water = high_water_bytes_; queued_batches = queue_.size();
    }
    auto recording = recording_status(active);
    return {{"mode", "simulation"}, {"simulated", true}, {"state", active ? "recording" : "idle"},
            {"recording", recording}, {"last_recording", recording_status(last)}, {"previews", preview},
            {"generated_batches", counters}, {"uptime_seconds", std::chrono::duration<double>(std::chrono::steady_clock::now() - origin_).count()},
            {"metrics", {{"queue_bytes", queued}, {"queue_limit_bytes", queue_limit_}, {"queue_high_water_bytes", high_water},
                         {"queue_batches", queued_batches}, {"produced_bytes", produced_bytes_.load()},
                         {"scheduler_overruns", scheduler_overruns_.load()}, {"dropped_batches", recording.is_null() ? 0 : recording.value("dropped_batches", 0)}}}};
}

json CaptureEngine::start_recording(const json& request) {
    std::lock_guard lifecycle(lifecycle_mutex_);
    {
        std::lock_guard lock(queue_mutex_);
        if (active_) throw std::logic_error("a recording is already active");
    }
    json ids = request.value("device_ids", json::array());
    if (ids.empty()) ids = request.value("devices", json::array());
    if (ids.empty()) ids = request.value("selected_devices", json::array());
    if (!ids.is_array() || ids.empty()) throw std::invalid_argument("select at least one device");
    auto recording = std::make_shared<Recording>();
    const auto id = new_id();
    recording->path = data_root_ / id;
    recording->started = std::chrono::steady_clock::now();
    recording->start_device_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(recording->started - origin_).count();
    recording->start_host_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(recording->started.time_since_epoch()).count();
    for (const auto& requested : ids) {
        if (!requested.is_string()) throw std::invalid_argument("device_ids must contain strings");
        const auto device_id = requested.get<std::string>();
        const bool known = std::any_of(adapters_.begin(), adapters_.end(), [&](const auto& adapter) { return adapter->descriptor().id == device_id; });
        if (!known) throw std::invalid_argument("unknown device: " + device_id);
        recording->selected.insert(device_id);
    }
    std::filesystem::create_directories(recording->path);
    json streams = json::array();
    for (const auto& adapter : adapters_) {
        const auto& descriptor = adapter->descriptor();
        if (!recording->selected.contains(descriptor.id)) continue;
        auto& stream = recording->files[descriptor.id];
        stream.file.open(recording->path / (descriptor.id + ".bin"), std::ios::binary | std::ios::trunc);
        if (!stream.file) throw std::runtime_error("cannot create recording file");
        stream.file.write(binary_magic.data(), static_cast<std::streamsize>(binary_magic.size()));
        auto schema = descriptor.to_json();
        schema["file"] = descriptor.id + ".bin";
        schema["format"] = "mdaqbin-v1";
        schema["byte_order"] = "little";
        streams.push_back(std::move(schema));
    }
    recording->manifest = {{"schema_version", 1}, {"format", "multimodal-capture-session"}, {"session_id", id}, {"id", id},
        {"name", request.value("name", request.value("session_name", std::string("Multimodal session")))},
        {"status", "recording"}, {"source", "simulation"}, {"simulated", true}, {"mode", "simulation"}, {"started_at", utc_now()},
        {"ended_at", nullptr}, {"duration_seconds", 0.0}, {"streams", streams}, {"device_ids", recording->selected},
        {"session_start_device_time_ns", recording->start_device_ns}, {"session_start_host_time_ns", recording->start_host_ns},
        {"clock", {{"device_time", "nanoseconds since native engine start"}, {"host_time", "steady_clock nanoseconds"},
                   {"synchronization", "shared simulated clock; not a hardware accuracy claim"}}},
        {"binary", {{"magic", "MDAQBIN1"}, {"record_header", "<QqqII"}, {"record_header_bytes", 32},
                    {"fields", {"sequence", "device_time_ns", "host_time_ns", "sample_count", "payload_bytes"}}}},
        {"metadata", request.value("metadata", json::object())}, {"profile", request.value("profile", json::object())}};
    save_manifest(recording, false);
    {
        std::lock_guard lock(queue_mutex_);
        active_ = recording; accepting_ = true; stopping_ = false; high_water_bytes_ = 0;
    }
    return recording_status(recording);
}

json CaptureEngine::stop_recording() {
    std::lock_guard lifecycle(lifecycle_mutex_);
    std::shared_ptr<Recording> recording;
    {
        std::unique_lock lock(queue_mutex_);
        if (!active_) return last_ ? recording_status(last_) : json{{"status", "idle"}};
        recording = active_; accepting_ = false; stopping_ = true;
        drained_.wait(lock, [&] { return queue_.empty() && !writing_; });
    }
    {
        std::lock_guard lock(recording->mutex);
        for (auto& [id, stream] : recording->files) {
            stream.file.flush();
            if (!stream.file && recording->error.empty()) recording->error = "failed to flush recording file: " + id;
            stream.file.close();
        }
        recording->manifest["status"] = recording->error.empty() && recording->dropped_batches == 0 ? "complete" : "incomplete";
        recording->manifest["ended_at"] = utc_now();
        recording->manifest["duration_seconds"] = std::chrono::duration<double>(std::chrono::steady_clock::now() - recording->started).count();
    }
    save_manifest(recording, true);
    {
        std::lock_guard lock(queue_mutex_);
        last_ = recording; active_.reset(); stopping_ = false;
    }
    return recording_status(recording);
}

void CaptureEngine::save_manifest(const std::shared_ptr<Recording>& recording, bool final) {
    auto manifest = recording_status(recording);
    {
        std::lock_guard lock(recording->mutex);
        for (auto& stream_schema : manifest["streams"]) {
            const auto& stream = recording->files.at(stream_schema["id"].get<std::string>());
            stream_schema["records"] = stream.records; stream_schema["samples"] = stream.samples;
            stream_schema["payload_bytes"] = stream.bytes;
            stream_schema["first_device_time_ns"] = stream.first_time_ns;
            stream_schema["last_device_time_ns"] = stream.last_time_ns;
        }
    }
    manifest["finalized"] = final;
    std::ofstream file(recording->path / "manifest.json", std::ios::binary | std::ios::trunc);
    if (!file) throw std::runtime_error("cannot create session manifest");
    file << manifest.dump(2) << '\n';
    file.flush();
    if (!file) throw std::runtime_error("failed to write session manifest");
    // Keep API responses and the persisted manifest on one canonical snapshot.
    // In particular, stop must return finalized=true and final per-stream counts.
    {
        std::lock_guard lock(recording->mutex);
        recording->manifest = std::move(manifest);
    }
}

void CaptureEngine::validate_id(const std::string& id) {
    if (id.empty() || id.size() > 100 || !std::all_of(id.begin(), id.end(), [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
    })) throw std::invalid_argument("invalid session id");
}

std::filesystem::path CaptureEngine::session_path(const std::string& id) const {
    validate_id(id);
    const auto path = data_root_ / id;
    if (!std::filesystem::is_regular_file(path / "manifest.json")) throw std::runtime_error("session not found");
    return path;
}

json CaptureEngine::session(const std::string& id) const {
    return read_json_file(session_path(id) / "manifest.json");
}

json CaptureEngine::sessions() const {
    json result = json::array();
    for (const auto& entry : std::filesystem::directory_iterator(data_root_)) {
        if (!entry.is_directory() || !std::filesystem::exists(entry.path() / "manifest.json")) continue;
        try { result.push_back(read_json_file(entry.path() / "manifest.json")); } catch (...) {}
    }
    std::sort(result.begin(), result.end(), [](const auto& left, const auto& right) {
        return left.value("id", "") > right.value("id", "");
    });
    return result;
}

void CaptureEngine::accept(DataBatch batch) {
    produced_bytes_ += batch.payload.size();
    std::lock_guard lock(queue_mutex_);
    if (!active_ || !accepting_ || !active_->selected.contains(batch.stream_id) || batch.device_time_ns < active_->start_device_ns) return;
    const auto size = batch.payload.size() + 32;
    if (queue_bytes_ + size > queue_limit_ || queue_.size() >= queue_record_limit_) {
        std::lock_guard recording_lock(active_->mutex);
        ++active_->dropped_batches;
        if (active_->error.empty()) active_->error = "recording queue overflow; data loss was detected";
        return;
    }
    queue_bytes_ += size;
    high_water_bytes_ = std::max(high_water_bytes_, queue_bytes_);
    queue_.push_back(Pending{active_, std::move(batch)});
    queue_ready_.notify_one();
}

void CaptureEngine::acquisition_loop() {
    std::vector<std::int64_t> due(adapters_.size(), 0);
    std::vector<std::uint64_t> sequence(adapters_.size(), 0);
    while (running_) {
        const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - origin_).count();
        for (std::size_t i = 0; i < adapters_.size(); ++i) {
            const auto period = static_cast<std::int64_t>(std::llround(1e9 / adapters_[i]->descriptor().batch_rate));
            int catchup = 0;
            while (elapsed >= due[i] && catchup++ < 32 && running_) {
                auto batch = adapters_[i]->generate(sequence[i]++, due[i], steady_ns());
                due[i] += period;
                {
                    std::lock_guard lock(preview_mutex_);
                    previews_[batch.stream_id] = adapters_[i]->preview();
                    generated_[batch.stream_id] = sequence[i];
                }
                accept(std::move(batch));
            }
            if (elapsed >= due[i]) ++scheduler_overruns_;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void CaptureEngine::writer_loop() {
    while (true) {
        Pending pending;
        {
            std::unique_lock lock(queue_mutex_);
            queue_ready_.wait(lock, [&] { return !running_ || !queue_.empty(); });
            if (!running_ && queue_.empty()) return;
            pending = std::move(queue_.front()); queue_.pop_front();
            queue_bytes_ -= pending.batch.payload.size() + 32;
            writing_ = true;
        }
        {
            std::lock_guard lock(pending.recording->mutex);
            auto& stream = pending.recording->files.at(pending.batch.stream_id);
            try {
                write_batch(stream.file, pending.batch);
                ++stream.records; stream.samples += pending.batch.sample_count; stream.bytes += pending.batch.payload.size();
                if (stream.first_time_ns < 0) stream.first_time_ns = pending.batch.device_time_ns;
                stream.last_time_ns = pending.batch.device_time_ns;
            } catch (const std::exception& error) {
                if (pending.recording->error.empty()) pending.recording->error = error.what();
                ++pending.recording->dropped_batches;
            }
        }
        {
            std::lock_guard lock(queue_mutex_);
            writing_ = false;
            if (queue_.empty()) drained_.notify_all();
        }
    }
}
}  // namespace capture
