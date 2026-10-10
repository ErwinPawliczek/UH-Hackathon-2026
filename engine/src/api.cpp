// Chain Reaction — stub engine (M0).
//
// Animates deterministic fake data through the real C ABI so the web shell,
// the CLI and the snapshot golden path are exercised before the true
// simulation core lands (M1). The ABI and the snapshot layout are the real
// contracts; everything below is placeholder physics.

#include "crx/api.h"

#include "crx/hash.h"
#include "crx/rng.h"
#include "crx/scurve.h"

#include <nlohmann/json.hpp>

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace crx {

namespace {

constexpr uint32_t kSnapshotVersion = 1;
constexpr double kDtH = 0.25;                      // hours per tick
constexpr double kTickPeriod = 96.0 * 2.0;         // wobble period: 2 days
constexpr uint32_t kMaxSeriesPoints = 4 * 24 * 60; // 60 days hourly

// Stub entity counts — the shapes the web shell renders first.
constexpr uint32_t kNSites = 4;
constexpr uint32_t kNTanks = 8;
constexpr uint32_t kNProc = 4;
constexpr uint32_t kNUnits = 6;
constexpr uint32_t kNVeh = 6;
constexpr uint32_t kNPipes = 3;
constexpr uint32_t kNEdges = 8;
constexpr uint32_t kNMats = 22;

constexpr uint32_t kNArrays = 12;
constexpr uint32_t kKpiCount = 8;

constexpr const char* kMaterialKeys[kNMats] = {
    "CRUDE",  "RAW_GAS", "SALT",    "METHANE",  "ETHANE",   "LPG",
    "NAPHTHA", "GASOLINE", "JET",    "DIESEL",   "FUEL_OIL", "SOLVENT",
    "BENZENE", "ETHYLENE", "PROPYLENE", "CHLORINE", "CAUSTIC", "STYRENE",
    "PE",     "PP",      "PVC",     "PS"};

constexpr const char* kSiteNames[kNSites] = {"Oil Field", "Refinery", "Steam Cracker",
                                             "Port Terminal"};
constexpr const double kSiteX[kNSites] = {120.0, 260.0, 340.0, 480.0};
constexpr const double kSiteY[kNSites] = {260.0, 210.0, 150.0, 90.0};

// Snapshot array table: scalar type and count formula per array.
enum ArrKind : uint32_t { kF32, kU8, kU32 };
struct ArrSpec {
  ArrKind kind;
  uint32_t scalars;
};
constexpr ArrSpec kArrSpecs[kNArrays] = {
    {kF32, 4 * kNTanks},  // 0 tanks: fill, f, u, h
    {kF32, kNProc},       // 1 process rate/design
    {kU8, kNProc},        // 2 process status
    {kU8, kNUnits},       // 3 units: trains online
    {kU8, kNSites},       // 4 sites: status
    {kF32, kNSites},      // 5 sites: worst urgency
    {kF32, 5 * kNVeh},    // 6 vehicles: x, y, dirx, diry, fill
    {kU8, 2 * kNVeh},     // 7 vehicles: status, material
    {kU32, kNVeh},        // 8 vehicles: order
    {kF32, kNPipes},      // 9 pipelines: flow/capacity
    {kU8, kNEdges},       // 10 edges: open
    {kF32, kNMats},       // 11 prices: index
};

constexpr uint32_t kHeaderBytes = 20;  // magic4 + version4 + tick8 + count4

uint32_t scalarSize(ArrKind kind) { return kind == kU8 ? 1u : kind == kU32 ? 4u : 4u; }

uint32_t align4(uint32_t v) { return (v + 3u) & ~3u; }

// Triangle wave in [0,1] over kTickPeriod ticks, phase-shifted per entity.
double wobble(uint64_t tick, double phase) {
  const double t = std::fmod(static_cast<double>(tick) / kTickPeriod + phase, 1.0);
  return t < 0.5 ? 2.0 * t : 2.0 - 2.0 * t;
}

struct Sim {
  explicit Sim(uint64_t seed_in) : seed(seed_in), rng(seed_in) {
    for (uint32_t i = 0; i < kNTanks; ++i) tankPhase.push_back(rng.uniform01());
    for (uint32_t i = 0; i < kNVeh; ++i) vehPhase.push_back(rng.uniform01());
    for (uint32_t i = 0; i < kNPipes; ++i) pipePhase.push_back(rng.uniform01());
    buildTerrain();
    buildWorldJson();
    series.assign(kNTanks, {});
    kpis.assign(kKpiCount, 0.0);
  }

  uint64_t seed;
  uint64_t tick = 0;
  Rng rng;
  uint32_t terrainSide = 16;

  std::vector<double> tankPhase;
  std::vector<double> vehPhase;
  std::vector<double> pipePhase;
  std::vector<float> terrain;
  std::string worldJson;
  std::string reply;
  std::vector<std::vector<float>> series;  // per-tank hourly fill
  std::vector<double> kpis;
  mutable std::vector<uint8_t> snap;
  mutable bool snapDirty = true;

  double tankFill(uint32_t i) const {
    return 0.55 + 0.40 * scurve(wobble(tick, tankPhase[i]), 0.15, 0.85);
  }

  void buildTerrain() {
    // Island-ish height grid: radial falloff over seed noise. Render-only.
    terrain.assign(static_cast<size_t>(terrainSide) * terrainSide, 0.f);
    for (uint32_t y = 0; y < terrainSide; ++y) {
      for (uint32_t x = 0; x < terrainSide; ++x) {
        const double nx = static_cast<double>(x) / (terrainSide - 1) - 0.5;
        const double ny = static_cast<double>(y) / (terrainSide - 1) - 0.5;
        const double r = std::sqrt(4.0 * (nx * nx + ny * ny));  // [0, ~1.4]
        const double noise = 0.6 + 0.4 * rng.uniform01();
        terrain[y * terrainSide + x] =
            static_cast<float>(std::max(0.0, (1.0 - r)) * noise);
      }
    }
  }

  void buildWorldJson() {
    json mats = json::array();
    for (const char* k : kMaterialKeys) mats.push_back(k);

    json sites = json::array();
    for (uint32_t s = 0; s < kNSites; ++s) {
      sites.push_back({{"i", s},
                       {"name", kSiteNames[s]},
                       {"x", kSiteX[s]},
                       {"y", kSiteY[s]}});
    }

    json tanks = json::array();
    for (uint32_t t = 0; t < kNTanks; ++t) {
      tanks.push_back({{"i", t},
                       {"site", t % kNSites},
                       {"material", kMaterialKeys[(t * 3) % kNMats]}});
    }

    const json w = {{"world", "stub"},
                    {"dt_h", kDtH},
                    {"materials", mats},
                    {"sites", sites},
                    {"tanks", tanks}};
    worldJson = w.dump();
  }

  void recordSeries() {
    if (tick % 4 != 0) return;  // hourly
    for (uint32_t t = 0; t < kNTanks; ++t) {
      auto& s = series[t];
      s.push_back(static_cast<float>(tankFill(t)));
      if (s.size() > kMaxSeriesPoints) s.erase(s.begin());
    }
  }

  void computeKpis() {
    // Placeholder measures so the KPI pipeline is exercised end to end.
    const double w = scurve(wobble(tick, 0.0), 0.0, 1.0);
    kpis[0] = 1.0 - 0.10 * w;              // service level
    kpis[1] = 1000.0 * w;                  // unmet t
    kpis[2] = 500000.0 * w;                // unmet $
    kpis[3] = 1.0 - 0.15 * w;              // production index
    kpis[4] = 12.0 * w;                    // shutdown hours
    kpis[5] = 3.0 * w;                     // stock-outs
    kpis[6] = 20000.0 * w;                 // freight cost
    kpis[7] = 8000.0 * w;                  // energy cost
  }

  void buildSnapshot() const {
    uint32_t offset = align4(kHeaderBytes + 8 * kNArrays);
    uint32_t offsets[kNArrays];
    for (uint32_t a = 0; a < kNArrays; ++a) {
      offsets[a] = offset;
      offset = align4(offset + kArrSpecs[a].scalars * scalarSize(kArrSpecs[a].kind));
    }

    snap.assign(offset, 0);
    std::memcpy(snap.data(), "CRXS", 4);
    std::memcpy(snap.data() + 4, &kSnapshotVersion, 4);
    const uint64_t t = tick;
    std::memcpy(snap.data() + 8, &t, 8);
    std::memcpy(snap.data() + 16, &kNArrays, 4);
    for (uint32_t a = 0; a < kNArrays; ++a) {
      std::memcpy(snap.data() + kHeaderBytes + 8 * a, &kArrSpecs[a].scalars, 4);
      std::memcpy(snap.data() + kHeaderBytes + 8 * a + 4, &offsets[a], 4);
    }

    // 0 tanks: fill, f, u, h
    auto* tanks = reinterpret_cast<float*>(snap.data() + offsets[0]);
    for (uint32_t i = 0; i < kNTanks; ++i) {
      const double fill = tankFill(i);
      tanks[4 * i + 0] = static_cast<float>(fill);
      tanks[4 * i + 1] = static_cast<float>(scurve(fill, 0.25, 1.25));
      tanks[4 * i + 2] = static_cast<float>(1.0 - scurve(fill, 0.2, 1.0));
      tanks[4 * i + 3] = static_cast<float>(scurve(1.0 - fill, 0.1, 1.0));
    }
    // 1/2 processes
    auto* procRate = reinterpret_cast<float*>(snap.data() + offsets[1]);
    auto* procStatus = snap.data() + offsets[2];
    for (uint32_t i = 0; i < kNProc; ++i) {
      procRate[i] = static_cast<float>(0.70 + 0.30 * scurve(wobble(tick, 0.1 * i), 0.0, 1.0));
      procStatus[i] = 0;  // Running
    }
    // 3 units: trains online
    for (uint32_t i = 0; i < kNUnits; ++i) snap[offsets[3] + i] = i % 2 == 0 ? 2 : 1;
    // 4/5 sites
    for (uint32_t i = 0; i < kNSites; ++i) {
      snap[offsets[4] + i] = 0;  // running
      auto* urg = reinterpret_cast<float*>(snap.data() + offsets[5]);
      urg[i] = static_cast<float>(0.5 * scurve(wobble(tick, 0.2 * i), 0.0, 1.0));
    }
    // 6/7/8 vehicles
    auto* veh = reinterpret_cast<float*>(snap.data() + offsets[6]);
    for (uint32_t v = 0; v < kNVeh; ++v) {
      const double ang = 6.283185307179586 *
                         (wobble(tick, vehPhase[v]) + 0.125 * v);
      veh[5 * v + 0] = static_cast<float>(300.0 + 220.0 * std::cos(ang));
      veh[5 * v + 1] = static_cast<float>(200.0 + 150.0 * std::sin(ang));
      veh[5 * v + 2] = static_cast<float>(-std::sin(ang));
      veh[5 * v + 3] = static_cast<float>(std::cos(ang));
      veh[5 * v + 4] = static_cast<float>(0.4 + 0.6 * scurve(wobble(tick, vehPhase[v] + 0.3), 0.0, 1.0));
      snap[offsets[7] + 2 * v] = 3;                       // ToDropoff
      snap[offsets[7] + 2 * v + 1] = (v * 5) % kNMats;    // cargo material
      auto* ord = reinterpret_cast<uint32_t*>(snap.data() + offsets[8]);
      ord[v] = v;                                         // order index
    }
    // 9 pipelines
    auto* pipes = reinterpret_cast<float*>(snap.data() + offsets[9]);
    for (uint32_t i = 0; i < kNPipes; ++i) {
      pipes[i] = static_cast<float>(0.3 + 0.5 * scurve(wobble(tick, pipePhase[i]), 0.0, 1.0));
    }
    // 10 edges all open
    for (uint32_t i = 0; i < kNEdges; ++i) snap[offsets[10] + i] = 1;
    // 11 prices
    auto* prices = reinterpret_cast<float*>(snap.data() + offsets[11]);
    for (uint32_t m = 0; m < kNMats; ++m) {
      prices[m] = static_cast<float>(1.0 + 0.05 * scurve(wobble(tick, 0.02 * m), 0.0, 1.0));
    }

    snapDirty = false;
  }

  uint64_t hashState() const {
    if (snapDirty) buildSnapshot();
    Hasher hasher;
    hasher.mixU64(seed);
    hasher.mixU64(tick);
    hasher.mix(snap.data(), snap.size());
    return finish(hasher);
  }
};

Sim* asSim(crx_sim* s) { return reinterpret_cast<Sim*>(s); }
const Sim* asSim(const crx_sim* s) { return reinterpret_cast<const Sim*>(s); }

}  // namespace

}  // namespace crx

// ---- C ABI ----

using crx::asSim;
using crx::Sim;

crx_sim* crx_create(const char* config_json) {
  uint64_t seed = 42;
  if (config_json != nullptr) {
    try {
      const json cfg = json::parse(config_json);
      if (cfg.contains("seed")) cfg.at("seed").get_to(seed);
    } catch (...) {
      return nullptr;
    }
  }
  return reinterpret_cast<crx_sim*>(new Sim(seed));
}

crx_sim* crx_fork(const crx_sim* src) {
  if (src == nullptr) return nullptr;
  return reinterpret_cast<crx_sim*>(new Sim(*asSim(src)));
}

void crx_destroy(crx_sim* sim) { delete asSim(sim); }

void crx_step(crx_sim* sim, uint32_t ticks) {
  Sim* s = asSim(sim);
  if (s == nullptr) return;
  for (uint32_t i = 0; i < ticks; ++i) {
    ++s->tick;
    s->recordSeries();
  }
  s->computeKpis();
  s->snapDirty = true;
}

const char* crx_command(crx_sim* sim, const char* json_cmd) {
  Sim* s = asSim(sim);
  if (s == nullptr || json_cmd == nullptr) return R"({"ok":false,"error":"null"})";
  try {
    const json cmd = json::parse(json_cmd);
    s->reply = json{{"ok", true}, {"echoed", cmd}}.dump();
  } catch (...) {
    s->reply = R"({"ok":false,"error":"bad json"})";
  }
  return s->reply.c_str();
}

const char* crx_world_json(const crx_sim* sim) { return asSim(sim)->worldJson.c_str(); }

const float* crx_terrain(const crx_sim* sim, uint32_t* n) {
  const Sim* s = asSim(sim);
  *n = static_cast<uint32_t>(s->terrain.size());
  return s->terrain.data();
}

const uint8_t* crx_snapshot(crx_sim* sim, uint32_t* bytes) {
  Sim* s = asSim(sim);
  if (s->snapDirty) s->buildSnapshot();
  *bytes = static_cast<uint32_t>(s->snap.size());
  return s->snap.data();
}

const char* crx_events(const crx_sim* sim, uint64_t /*since_seq*/) {
  (void)sim;
  return "[]";
}

const float* crx_series(const crx_sim* sim, uint32_t kind, uint32_t id, uint32_t* n) {
  const Sim* s = asSim(sim);
  if (kind != 0 || id >= s->series.size()) {
    *n = 0;
    return nullptr;
  }
  *n = static_cast<uint32_t>(s->series[id].size());
  return s->series[id].data();
}

const double* crx_kpis(const crx_sim* sim, uint32_t* n) {
  const Sim* s = asSim(sim);
  *n = static_cast<uint32_t>(s->kpis.size());
  return s->kpis.data();
}

uint64_t crx_tick(const crx_sim* sim) { return asSim(sim)->tick; }

uint64_t crx_state_hash(const crx_sim* sim) { return asSim(sim)->hashState(); }

const char* crx_version(void) { return "crx 0.1.0-m0"; }
