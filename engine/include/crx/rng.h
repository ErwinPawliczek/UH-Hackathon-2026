#pragma once

#include <cstdint>

namespace crx {

// PCG32 (O'Neill). Own generator per determinism rule 1: same seed and stream
// give the same sequence on every run of the same platform.
struct Rng {
  uint64_t state = 0x853c49e6748fea9bull;
  uint64_t inc = 0xda3e39cb94b95bddull;

  Rng() = default;

  explicit Rng(uint64_t seed, uint64_t stream = 0) {
    state = 0;
    inc = (stream << 1u) | 1u;
    next32();
    next32();
    state += seed;
    next32();
  }

  uint32_t next32() {
    const uint64_t old = state;
    state = old * 6364136223846793005ull + inc;
    const uint32_t xorshifted = static_cast<uint32_t>(((old >> 18u) ^ old) >> 27u);
    const uint32_t rot = static_cast<uint32_t>(old >> 59u);
    return (xorshifted >> rot) | (xorshifted << ((-rot) & 31u));
  }

  double uniform01() { return static_cast<double>(next32()) * (1.0 / 4294967296.0); }

  double uniform(double lo, double hi) { return lo + (hi - lo) * uniform01(); }

  // Unbiased-enough power-of-two-multiply take; n == 0 returns 0.
  uint32_t below(uint32_t n) {
    return n == 0 ? 0 : static_cast<uint32_t>((static_cast<uint64_t>(next32()) * n) >> 32);
  }
};

}  // namespace crx
