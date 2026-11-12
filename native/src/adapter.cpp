#include "adapter.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace capture {
json StreamDescriptor::to_json() const {
    const auto channel_count = modality == "pressure" ? 256 : (modality == "camera" ? 3 : (modality == "imu" ? 6 : 1));
    json result = {{"id", id}, {"device_id", id}, {"kind", modality}, {"modality", modality}, {"name", name},
            {"sample_rate", sample_rate}, {"sample_rate_hz", sample_rate},
            {"batch_rate_hz", batch_rate}, {"batch_samples", batch_samples},
            {"dtype", dtype}, {"shape", shape}, {"channels", channel_count}, {"channel_names", channels}, {"units", units},
            {"unit", units.empty() ? (modality == "camera" ? "RGB8" : "") : units.front()},
            {"simulated", true}, {"mode", "simulated"}, {"connected", true}, {"transport", "Simulation"},
            {"clock_id", "simulation-shared-monotonic"}, {"adapter", "simulation"}, {"status", "ready"}, {"metadata", metadata}};
    if (modality == "pressure") { result["rows"] = 16; result["cols"] = 16; }
    if (modality == "camera") { result["width"] = 160; result["height"] = 90; }
    return result;
}

std::string base64_encode(const std::vector<std::uint8_t>& bytes) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve(((bytes.size() + 2) / 3) * 4);
    for (std::size_t i = 0; i < bytes.size(); i += 3) {
        const std::uint32_t bits = (static_cast<std::uint32_t>(bytes[i]) << 16) |
            (i + 1 < bytes.size() ? static_cast<std::uint32_t>(bytes[i + 1]) << 8 : 0) |
            (i + 2 < bytes.size() ? static_cast<std::uint32_t>(bytes[i + 2]) : 0);
        result += alphabet[(bits >> 18) & 63]; result += alphabet[(bits >> 12) & 63];
        result += i + 1 < bytes.size() ? alphabet[(bits >> 6) & 63] : '=';
        result += i + 2 < bytes.size() ? alphabet[bits & 63] : '=';
    }
    return result;
}

class SimulatedAdapter final : public DeviceAdapter {
public:
    explicit SimulatedAdapter(StreamDescriptor descriptor) : descriptor_(std::move(descriptor)) {}
    const StreamDescriptor& descriptor() const override { return descriptor_; }
    json preview() const override { return preview_; }

    DataBatch generate(std::uint64_t sequence, std::int64_t device_time_ns, std::int64_t host_time_ns) override {
        const double t = static_cast<double>(device_time_ns) / 1e9;
        DataBatch batch{descriptor_.id, sequence, device_time_ns, host_time_ns, descriptor_.batch_samples, {}};
        if (descriptor_.modality == "camera") {
            constexpr int width = 160, height = 90;
            batch.payload.resize(width * height * 3);
            for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
                const auto offset = static_cast<std::size_t>((y * width + x) * 3);
                const double ball = std::exp(-((x - 80 - 45 * std::sin(t)) * (x - 80 - 45 * std::sin(t)) +
                    (y - 45 - 22 * std::cos(t * 0.8)) * (y - 45 - 22 * std::cos(t * 0.8))) / 140.0);
                batch.payload[offset] = static_cast<std::uint8_t>(20 + 30.0 * x / width + 130 * ball);
                batch.payload[offset + 1] = static_cast<std::uint8_t>(35 + 50.0 * y / height + 150 * ball);
                batch.payload[offset + 2] = static_cast<std::uint8_t>(48 + 90 * ball);
            }
            preview_ = {{"width", width}, {"height", height}, {"encoding", "rgb8"},
                        {"rgb_base64", base64_encode(batch.payload)}, {"sequence", sequence}};
        } else if (descriptor_.modality == "audio") {
            std::vector<float> values(descriptor_.batch_samples);
            float rms = 0;
            json waveform = json::array();
            for (std::size_t i = 0; i < values.size(); ++i) {
                const double st = t + static_cast<double>(i) / descriptor_.sample_rate;
                values[i] = static_cast<float>(0.2 * std::sin(2 * std::numbers::pi * 220 * st) *
                    (0.6 + 0.4 * std::sin(st * 2)) + 0.04 * std::sin(2 * std::numbers::pi * 440 * st));
                rms += values[i] * values[i];
                if (i % 8 == 0) waveform.push_back(values[i]);
            }
            rms = std::sqrt(rms / static_cast<float>(values.size()));
            preview_ = {{"rms", rms}, {"waveform", waveform}, {"sequence", sequence}};
            batch.payload = float_payload(values);
        } else if (descriptor_.modality == "pressure") {
            std::vector<float> values(16 * 16);
            for (int y = 0; y < 16; ++y) for (int x = 0; x < 16; ++x) {
                const double dx = x - (7.5 + 4 * std::sin(t * 0.8));
                const double dy = y - (7.5 + 4 * std::cos(t * 0.65));
                values[static_cast<std::size_t>(y * 16 + x)] = static_cast<float>(85 * std::exp(-(dx * dx + dy * dy) / 9) +
                    3 * (1 + std::sin(t * 2 + x * 0.4 + y * 0.3)));
            }
            preview_ = {{"rows", 16}, {"cols", 16}, {"values", values}, {"sequence", sequence}};
            batch.payload = float_payload(values);
        } else {
            std::vector<float> values{
                static_cast<float>(0.5 * std::sin(t * 1.8)), static_cast<float>(0.3 * std::cos(t * 1.3)),
                static_cast<float>(9.81 + 0.12 * std::sin(t)), static_cast<float>(0.08 * std::sin(t * 1.2)),
                static_cast<float>(0.1 * std::cos(t)), static_cast<float>(0.05 * std::sin(t * 0.7))};
            preview_ = {{"values", values}, {"sequence", sequence}};
            batch.payload = float_payload(values);
        }
        preview_["timestamp_ns"] = device_time_ns;
        return batch;
    }
private:
    StreamDescriptor descriptor_;
    json preview_ = json::object();
};

std::vector<std::unique_ptr<DeviceAdapter>> make_simulated_adapters() {
    std::vector<std::unique_ptr<DeviceAdapter>> adapters;
    adapters.push_back(std::make_unique<SimulatedAdapter>(StreamDescriptor{
        "sim-camera", "camera", "Simulated RGB camera", 15, 15, 1, "uint8", {90, 160, 3}, {}, {},
        {{"pixel_format", "rgb8"}, {"width", 160}, {"height", 90}}}));
    adapters.push_back(std::make_unique<SimulatedAdapter>(StreamDescriptor{
        "sim-audio", "audio", "Simulated microphone", 48000, 100, 480, "float32", {1}, {"mono"}, {"normalized"},
        {{"encoding", "pcm_f32le"}, {"channels", 1}}}));
    adapters.push_back(std::make_unique<SimulatedAdapter>(StreamDescriptor{
        "sim-pressure", "pressure", "Simulated pressure array", 100, 100, 1, "float32", {16, 16}, {}, {"kPa"},
        {{"rows", 16}, {"cols", 16}, {"calibration", "simulation-only"}}}));
    adapters.push_back(std::make_unique<SimulatedAdapter>(StreamDescriptor{
        "sim-imu", "imu", "Simulated 6-axis IMU", 200, 200, 1, "float32", {6},
        {"ax", "ay", "az", "gx", "gy", "gz"}, {"m/s2", "m/s2", "m/s2", "rad/s", "rad/s", "rad/s"},
        {{"coordinate_frame", "simulated-right-handed"}}}));
    return adapters;
}
}  // namespace capture
