#pragma once

#include "adapter.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <thread>

namespace capture {
class CaptureEngine {
public:
    explicit CaptureEngine(std::filesystem::path data_root);
    ~CaptureEngine();
    CaptureEngine(const CaptureEngine&) = delete;
    CaptureEngine& operator=(const CaptureEngine&) = delete;

    json devices() const;
    json snapshot() const;
    json status() const;
    json preview() const;
    json start_recording(const json& request);
    json stop_recording();
    json sessions() const;
    json session(const std::string& id) const;
    std::filesystem::path session_path(const std::string& id) const;
    const std::filesystem::path& data_root() const { return data_root_; }

private:
    struct StreamFile {
        std::ofstream file;
        std::uint64_t records{};
        std::uint64_t samples{};
        std::uint64_t bytes{};
        std::int64_t first_time_ns{-1};
        std::int64_t last_time_ns{-1};
    };
    struct Recording {
        std::filesystem::path path;
        json manifest;
        std::set<std::string> selected;
        std::map<std::string, StreamFile> files;
        std::chrono::steady_clock::time_point started;
        std::int64_t start_device_ns{};
        std::int64_t start_host_ns{};
        std::uint64_t dropped_batches{};
        std::string error;
        mutable std::mutex mutex;
    };
    struct Pending {
        std::shared_ptr<Recording> recording;
        DataBatch batch;
    };

    void acquisition_loop();
    void writer_loop();
    void accept(DataBatch batch);
    void save_manifest(const std::shared_ptr<Recording>& recording, bool final);
    json recording_status(const std::shared_ptr<Recording>& recording) const;
    static void validate_id(const std::string& id);

    std::filesystem::path data_root_;
    std::vector<std::unique_ptr<DeviceAdapter>> adapters_;
    std::chrono::steady_clock::time_point origin_;
    mutable std::mutex preview_mutex_;
    json previews_ = json::object();
    std::map<std::string, std::uint64_t> generated_;
    std::atomic<std::uint64_t> produced_bytes_{0};
    std::atomic<std::uint64_t> scheduler_overruns_{0};
    std::atomic<bool> running_{true};
    mutable std::mutex lifecycle_mutex_;
    mutable std::mutex queue_mutex_;
    std::condition_variable queue_ready_;
    std::condition_variable drained_;
    std::deque<Pending> queue_;
    std::size_t queue_bytes_{};
    std::size_t high_water_bytes_{};
    static constexpr std::size_t queue_limit_ = 64 * 1024 * 1024;
    static constexpr std::size_t queue_record_limit_ = 4096;
    bool writing_{};
    bool accepting_{};
    bool stopping_{};
    std::shared_ptr<Recording> active_;
    std::shared_ptr<Recording> last_;
    std::thread acquisition_thread_;
    std::thread writer_thread_;
};

std::string utc_now();
}  // namespace capture
