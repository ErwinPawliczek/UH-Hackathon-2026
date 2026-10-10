#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace crx {

// FNV-1a 64. Hashes plain-old-data state so a run can be fingerprinted and
// compared across runs of the same platform (determinism rule 4, §12 test 4).
struct Hasher {
  uint64_t h = 14695981039346656037ull;

  void mix(const void* data, size_t bytes) {
    const auto* p = static_cast<const uint8_t*>(data);
    for (size_t i = 0; i < bytes; ++i) {
      h ^= p[i];
      h *= 1099511628211ull;
    }
  }
  void mixU64(uint64_t v) { mix(&v, sizeof v); }
  void mixU32(uint32_t v) { mix(&v, sizeof v); }
  void mixF64(double v) {
    uint64_t bits;
    static_assert(sizeof bits == sizeof v, "64-bit double");
    std::memcpy(&bits, &v, sizeof bits);
    mix(&bits, sizeof bits);
  }
};

inline uint64_t finish(const Hasher& hasher) { return hasher.h; }

}  // namespace crx
