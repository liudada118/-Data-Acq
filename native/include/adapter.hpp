#pragma once

#include "binary_format.hpp"
#include "json.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace capture {
using json = nlohmann::json;

struct StreamDescriptor {
    std::string id;
    std::string modality;
    std::string name;
    double sample_rate{};
    double batch_rate{};
    std::uint32_t batch_samples{};
    std::string dtype;
    std::vector<std::size_t> shape;
    std::vector<std::string> channels;
    std::vector<std::string> units;
    json metadata;
    json to_json() const;
};

class DeviceAdapter {
public:
    virtual ~DeviceAdapter() = default;
    virtual const StreamDescriptor& descriptor() const = 0;
    virtual DataBatch generate(std::uint64_t sequence, std::int64_t device_time_ns,
                               std::int64_t host_time_ns) = 0;
    virtual json preview() const = 0;
};

std::vector<std::unique_ptr<DeviceAdapter>> make_simulated_adapters();
std::string base64_encode(const std::vector<std::uint8_t>& bytes);
}  // namespace capture
