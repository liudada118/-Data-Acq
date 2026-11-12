#pragma once

#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <ostream>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace capture {
inline constexpr std::array<char, 8> binary_magic{'M', 'D', 'A', 'Q', 'B', 'I', 'N', '1'};

template <typename T>
void write_little(std::ostream& out, T value) {
    static_assert(std::is_integral_v<T>);
    auto bits = static_cast<std::make_unsigned_t<T>>(value);
    std::array<char, sizeof(T)> bytes{};
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        bytes[i] = static_cast<char>((bits >> (8 * i)) & 0xffu);
    }
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

inline std::vector<std::uint8_t> float_payload(const std::vector<float>& values) {
    std::vector<std::uint8_t> bytes(values.size() * sizeof(float));
    for (std::size_t i = 0; i < values.size(); ++i) {
        auto bits = std::bit_cast<std::uint32_t>(values[i]);
        for (std::size_t b = 0; b < 4; ++b) bytes[i * 4 + b] = static_cast<std::uint8_t>(bits >> (b * 8));
    }
    return bytes;
}

struct DataBatch {
    std::string stream_id;
    std::uint64_t sequence{};
    std::int64_t device_time_ns{};
    std::int64_t host_time_ns{};
    std::uint32_t sample_count{};
    std::vector<std::uint8_t> payload;
};

inline void write_batch(std::ostream& out, const DataBatch& batch) {
    write_little(out, batch.sequence);
    write_little(out, batch.device_time_ns);
    write_little(out, batch.host_time_ns);
    write_little(out, batch.sample_count);
    write_little(out, static_cast<std::uint32_t>(batch.payload.size()));
    out.write(reinterpret_cast<const char*>(batch.payload.data()), static_cast<std::streamsize>(batch.payload.size()));
    if (!out) throw std::runtime_error("recording write failed");
}
}  // namespace capture
