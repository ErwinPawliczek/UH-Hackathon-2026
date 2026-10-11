// Engine tests (§12). M0 scope: core math, RNG, snapshot contract, fork.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "crx/api.h"
#include "crx/hash.h"
#include "crx/rng.h"
#include "crx/scurve.h"

#include <cstdio>
#include <cstring>
#include <string>

using namespace crx;

TEST_CASE("smoothstep: endpoints, midpoint, monotone") {
  CHECK(scurve(0.0, 0.0, 1.0) == doctest::Approx(0.0));
  CHECK(scurve(1.0, 0.0, 1.0) == doctest::Approx(1.0));
  CHECK(scurve(0.5, 0.0, 1.0) == doctest::Approx(0.5));
  CHECK(scurve(-1.0, 0.0, 1.0) == 0.0);
  CHECK(scurve(2.0, 0.0, 1.0) == 1.0);
  double prev = -1.0;
  for (int i = 0; i <= 100; ++i) {
    const double s = scurve(i / 100.0, 0.0, 1.0);
    CHECK(s >= prev);
    prev = s;
  }
}

TEST_CASE("pcg32: reproducible, seed-sensitive, in range") {
  Rng a(1), b(1), c(2);
  for (int i = 0; i < 1000; ++i) {
    REQUIRE(a.next32() == b.next32());
    c.next32();
  }
  Rng d(7);
  bool distinct = false;
  const double first = d.uniform01();
  for (int i = 0; i < 100; ++i) {
    if (d.uniform01() != first) distinct = true;
  }
  REQUIRE(distinct);
  Rng e(3);
  for (int i = 0; i < 100; ++i) {
    const uint32_t v = e.below(10);
    REQUIRE(v < 10);
  }
}

TEST_CASE("hasher: input-sensitive") {
  Hasher h1, h2;
  h1.mixF64(3.14);
  h2.mixF64(3.15);
  REQUIRE(finish(h1) != finish(h2));
}

namespace {

crx_sim* makeSim(uint64_t seed) {
  char cfg[64];
  std::snprintf(cfg, sizeof cfg, "{\"seed\":%llu}",
                static_cast<unsigned long long>(seed));
  return crx_create(cfg);
}

}  // namespace

TEST_CASE("stub engine: bad config rejected") {
  REQUIRE(crx_create("not json") == nullptr);
}

TEST_CASE("stub engine: deterministic run, seed-sensitive") {
  crx_sim* a = makeSim(1);
  crx_sim* b = makeSim(1);
  crx_sim* c = makeSim(2);
  REQUIRE(a != nullptr);
  REQUIRE(b != nullptr);
  REQUIRE(c != nullptr);
  crx_step(a, 960);
  crx_step(b, 960);
  crx_step(c, 960);
  REQUIRE(crx_state_hash(a) == crx_state_hash(b));
  REQUIRE(crx_state_hash(a) != crx_state_hash(c));
  crx_destroy(a);
  crx_destroy(b);
  crx_destroy(c);
}

TEST_CASE("stub engine: fork matches parent (test 5)") {
  crx_sim* a = makeSim(5);
  crx_step(a, 480);
  crx_sim* f = crx_fork(a);
  REQUIRE(f != nullptr);
  crx_step(a, 480);
  crx_step(f, 480);
  REQUIRE(crx_state_hash(a) == crx_state_hash(f));
  crx_destroy(a);
  crx_destroy(f);
}

TEST_CASE("snapshot: header, version, tick, array count (test 9 anchor)") {
  crx_sim* s = makeSim(3);
  crx_step(s, 96);
  uint32_t bytes = 0;
  const uint8_t* p = crx_snapshot(s, &bytes);
  REQUIRE(bytes > 116);
  REQUIRE(p[0] == 'C');
  REQUIRE(p[1] == 'R');
  REQUIRE(p[2] == 'X');
  REQUIRE(p[3] == 'S');
  uint32_t version = 0;
  std::memcpy(&version, p + 4, 4);
  REQUIRE(version == 2);
  uint64_t tick = 0;
  std::memcpy(&tick, p + 8, 8);
  REQUIRE(tick == 96);
  uint32_t count = 0;
  std::memcpy(&count, p + 16, 4);
  REQUIRE(count == 15);
  crx_destroy(s);
}

// Snapshot v2 vehicle arrays (12–14): assigned route, progress along it, and
// the tick the current activity ends — the client's movement contract.
TEST_CASE("snapshot: vehicle route, progress and eta arrays") {
  crx_sim* s = makeSim(3);
  crx_step(s, 480);  // 5 days: dispatch is past its first deliveries
  uint32_t bytes = 0;
  const uint8_t* p = crx_snapshot(s, &bytes);
  uint32_t counts[15];
  uint32_t offsets[15];
  for (uint32_t i = 0; i < 15; ++i) std::memcpy(&counts[i], p + 20 + 8 * i, 4);
  for (uint32_t i = 0; i < 15; ++i) std::memcpy(&offsets[i], p + 24 + 8 * i, 4);
  const uint32_t nVeh = counts[8];
  REQUIRE(nVeh > 0);
  const auto route = reinterpret_cast<const uint32_t*>(p + offsets[12]);
  const auto prog = reinterpret_cast<const float*>(p + offsets[13]);
  const auto eta = reinterpret_cast<const uint32_t*>(p + offsets[14]);
  const auto status = p + offsets[7];
  bool anyOnRoute = false;
  for (uint32_t v = 0; v < nVeh; ++v) {
    if (route[v] != UINT32_MAX) {
      CHECK(route[v] < counts[10]);  // a client route index, or "none"
      CHECK(prog[v] >= 0.0f);
      CHECK(prog[v] <= 1.0f);
      anyOnRoute = true;
    }
    CHECK(status[2 * v] <= 6);  // §4.4 VehStatus range
    if (eta[v] != UINT32_MAX) CHECK(eta[v] >= 480);  // never behind the tick
  }
  REQUIRE(anyOnRoute);  // five days in, some vehicle is under way
  crx_destroy(s);
}

// Replay determinism at the API surface: two fresh sessions stepped the same
// way must emit byte-identical snapshots (the v2 arrays are pure functions of
// the hashed state — no wall clock).
TEST_CASE("snapshot: identical runs produce identical snapshot bytes") {
  std::string first;
  for (int run = 0; run < 2; ++run) {
    crx_sim* s = makeSim(42);
    crx_step(s, 300);
    crx_step(s, 300);
    uint32_t bytes = 0;
    const uint8_t* p = crx_snapshot(s, &bytes);
    std::string hex;
    hex.reserve(static_cast<size_t>(bytes) * 2);
    for (uint32_t i = 0; i < bytes; ++i) {
      char buf[3];
      std::snprintf(buf, sizeof buf, "%02x", p[i]);
      hex += buf;
    }
    if (run == 0) first = hex;
    else REQUIRE(hex == first);
    crx_destroy(s);
  }
}

TEST_CASE("command and world json") {
  crx_sim* s = makeSim(1);
  const char* r = crx_command(
      s, "{\"cmd\":\"event\",\"type\":\"unit_outage\",\"site\":0,\"unit\":\"X\","
         "\"trains\":1,\"duration_h\":24}");
  REQUIRE(std::string(r).find("\"ok\":true") != std::string::npos);
  REQUIRE(std::string(crx_command(s, "garbage")).find("\"ok\":false") !=
          std::string::npos);
  const std::string world = crx_world_json(s);
  REQUIRE(world.front() == '{');
  REQUIRE(world.find("sites") != std::string::npos);
  crx_destroy(s);
}

TEST_CASE("series: hourly tank history") {
  crx_sim* s = makeSim(9);
  crx_step(s, 960);  // 10 days
  uint32_t n = 0;
  const float* series = crx_series(s, 0, 0, &n);
  REQUIRE(n >= 240);
  REQUIRE(series != nullptr);
  for (uint32_t i = 0; i < n; ++i) {
    REQUIRE(series[i] >= 0.0f);
    REQUIRE(series[i] <= 1.0f);
  }
  uint32_t nBad = 1;
  REQUIRE(crx_series(s, 5, 0, &nBad) == nullptr);
  REQUIRE(nBad == 0);
  crx_destroy(s);
}
