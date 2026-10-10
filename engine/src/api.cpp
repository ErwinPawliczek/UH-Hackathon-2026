// Chain Reaction — engine C ABI implementation (§7.1) over the M1 sim core.
//
// The ABI and the binary snapshot layout are the fixed contracts: one JSON
// document for rare structured data (world description, commands, events),
// one self-describing binary snapshot of typed arrays for per-frame data.
// Array 0 carries the tank signals f/u/h, arrays 1/2 process rate and
// status, array 3 unit trains online, arrays 6–8 vehicles (none until M2
// logistics).
#include "crx/api.h"

#include "sim/sim.h"

#include "crx/rng.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;
using crx::sim::Sim;

namespace {

constexpr uint32_t kSnapshotVersion = 1;
constexpr uint32_t kNArrays = 12;
constexpr uint32_t kHeaderBytes = 20;  // magic4 + version4 + tick8 + count4
constexpr uint32_t kTerrainSide = 16;

// Snapshot array table: scalar kind and count per array. Counts are
// world-derived; the per-array (scalars, offset) table inside the binary is
// what decoders consume.
enum ArrKind : uint32_t { kF32, kU8, kU32 };
struct ArrSpec {
  ArrKind kind;
  uint32_t scalars;
};

uint32_t scalarSize(ArrKind kind) { return kind == kU8 ? 1u : kind == kU32 ? 4u : 4u; }
uint32_t align4(uint32_t v) { return (v + 3u) & ~3u; }

// ABI object: the sim plus per-call scratch (replies, snapshot bytes, KPIs).
// Copying deep-copies the sim — that is the fork path (§7.1).
struct ApiSim {
  std::unique_ptr<Sim> sim;
  mutable std::string reply;  // scratch: points at the last command/event reply
  std::string world_json;
  mutable std::vector<double> kpis;
  std::vector<float> terrain;
  mutable std::vector<uint8_t> snap;
  mutable bool snap_dirty = true;

  ApiSim() = default;
  explicit ApiSim(uint64_t seed) {
    std::string error;
    sim = Sim::create(seed, error);
    if (sim == nullptr) throw std::runtime_error(error);
    buildWorldJson(*sim, world_json);
    buildTerrain(seed, terrain);
  }

  ApiSim(const ApiSim& other)
      : sim(std::make_unique<Sim>(*other.sim)),
        reply(other.reply),
        world_json(other.world_json),
        kpis(other.kpis),
        terrain(other.terrain),
        snap{},
        snap_dirty(true) {}
  ApiSim& operator=(const ApiSim&) = delete;

  static void buildWorldJson(const Sim& s, std::string& out);
  static void buildTerrain(uint64_t seed, std::vector<float>& out);
};

ApiSim* asApi(crx_sim* s) { return reinterpret_cast<ApiSim*>(s); }
const ApiSim* asApi(const crx_sim* s) { return reinterpret_cast<const ApiSim*>(s); }

void ApiSim::buildWorldJson(const Sim& s, std::string& out) {
  const auto& w = s.world();
  const auto& cat = w.catalog;
  json mats = json::array();
  for (const auto& m : cat.materials) mats.push_back(m.key);

  json sites = json::array();
  for (size_t i = 0; i < w.sites.size(); ++i) {
    const auto& site = w.sites[i];
    sites.push_back(
        {{"i", i}, {"key", site.key}, {"name", site.name}, {"x", site.x_km}, {"y", site.y_km}});
  }

  json tanks = json::array();
  for (size_t t = 0; t < w.tanks.size(); ++t) {
    const auto& tank = w.tanks[t];
    tanks.push_back({{"i", t},
                     {"key", tank.key},
                     {"site", tank.site.v},
                     {"material", cat.materials[tank.material].key},
                     {"capacity_t", tank.capacity_t},
                     {"target_frac", tank.target_frac}});
  }

  json procs = json::array();
  for (size_t p = 0; p < w.processes.size(); ++p) {
    const auto& proc = w.processes[p];
    const auto& type = cat.process_types[proc.type];
    procs.push_back({{"i", p},
                     {"site", proc.site.v},
                     {"type", type.key},
                     {"name", type.name},
                     {"design_t_h", proc.design_rate_t_h}});
  }

  json units = json::array();
  for (size_t u = 0; u < w.units.size(); ++u) {
    const auto& unit = w.units[u];
    const auto& slot =
        cat.process_types[w.processes[unit.process.v].type].units[unit.slot];
    units.push_back({{"i", u},
                     {"process", unit.process.v},
                     {"name", slot.key},
                     {"trains", slot.trains},
                     {"cap_per_train_t_h", unit.cap_per_train_t_h}});
  }

  json pipes = json::array();
  for (const auto& pl : w.pipelines) {
    pipes.push_back({{"from", w.tanks[pl.from.v].key},
                     {"to", w.tanks[pl.to.v].key},
                     {"material", cat.materials[pl.material].key},
                     {"cap_t_h", pl.cap_t_h}});
  }

  const json doc = {{"world", "sixsite"},
                    {"dt_h", crx::sim::kTickHours},
                    {"materials", mats},
                    {"sites", sites},
                    {"tanks", tanks},
                    {"processes", procs},
                    {"units", units},
                    {"pipelines", pipes}};
  out = doc.dump();
}

// Render-only terrain (never enters the state hash): soft island falloff
// over seeded noise, drawn from its own RNG stream.
void ApiSim::buildTerrain(uint64_t seed, std::vector<float>& out) {
  crx::Rng rng(seed ^ 0x9E3779B97F4A7C15ull);
  out.assign(static_cast<size_t>(kTerrainSide) * kTerrainSide, 0.f);
  for (uint32_t y = 0; y < kTerrainSide; ++y) {
    for (uint32_t x = 0; x < kTerrainSide; ++x) {
      const double nx = static_cast<double>(x) / (kTerrainSide - 1) - 0.5;
      const double ny = static_cast<double>(y) / (kTerrainSide - 1) - 0.5;
      const double r = std::sqrt(4.0 * (nx * nx + ny * ny));
      const double noise = 0.6 + 0.4 * rng.uniform01();
      out[y * kTerrainSide + x] = static_cast<float>(std::max(0.0, 1.0 - r) * noise);
    }
  }
}

void buildSnapshot(const Sim& sim, std::vector<uint8_t>& snap) {
  const auto& w = sim.world();
  const auto& st = sim.state();
  const auto& signals = sim.signals;

  const uint32_t nTanks = static_cast<uint32_t>(w.tanks.size());
  const uint32_t nProc = static_cast<uint32_t>(w.processes.size());
  const uint32_t nUnits = static_cast<uint32_t>(w.units.size());
  const uint32_t nSites = static_cast<uint32_t>(w.sites.size());
  const uint32_t nPipes = static_cast<uint32_t>(w.pipelines.size());
  const uint32_t nMats = static_cast<uint32_t>(w.catalog.materials.size());

  ArrSpec specs[kNArrays] = {
      {kF32, 4 * nTanks},  // 0 tanks: fill, f, u, h
      {kF32, nProc},       // 1 process rate/design
      {kU8, nProc},        // 2 process status
      {kU8, nUnits},       // 3 units: trains online
      {kU8, nSites},       // 4 sites: status
      {kF32, nSites},      // 5 sites: worst urgency
      {kF32, 0},           // 6 vehicles: x, y, dirx, diry, fill (M2)
      {kU8, 0},            // 7 vehicles: status, material (M2)
      {kU32, 0},           // 8 vehicles: order (M2)
      {kF32, nPipes},      // 9 pipelines: flow/capacity
      {kU8, 0},            // 10 edges (route graph, M2)
      {kF32, nMats},       // 11 price index (static 1.0 in M1)
  };

  uint32_t offset = align4(kHeaderBytes + 8 * kNArrays);
  uint32_t offsets[kNArrays];
  for (uint32_t a = 0; a < kNArrays; ++a) {
    offsets[a] = offset;
    offset = align4(offset + specs[a].scalars * scalarSize(specs[a].kind));
  }

  snap.assign(offset, 0);
  std::memcpy(snap.data(), "CRXS", 4);
  std::memcpy(snap.data() + 4, &kSnapshotVersion, 4);
  const uint64_t tick = st.tick;
  std::memcpy(snap.data() + 8, &tick, 8);
  std::memcpy(snap.data() + 16, &kNArrays, 4);
  for (uint32_t a = 0; a < kNArrays; ++a) {
    std::memcpy(snap.data() + kHeaderBytes + 8 * a, &specs[a].scalars, 4);
    std::memcpy(snap.data() + kHeaderBytes + 8 * a + 4, &offsets[a], 4);
  }

  auto* tankArr = reinterpret_cast<float*>(snap.data() + offsets[0]);
  for (uint32_t t = 0; t < nTanks; ++t) {
    const double cap = w.tanks[t].capacity_t;
    tankArr[4 * t + 0] = static_cast<float>(cap > 0 ? st.tank[t].level_t / cap : 0.0);
    tankArr[4 * t + 1] = static_cast<float>(signals[t].f);
    tankArr[4 * t + 2] = static_cast<float>(signals[t].u);
    tankArr[4 * t + 3] = static_cast<float>(signals[t].h);
  }
  auto* procRate = reinterpret_cast<float*>(snap.data() + offsets[1]);
  for (uint32_t p = 0; p < nProc; ++p) {
    procRate[p] = static_cast<float>(w.processes[p].design_rate_t_h > 0
                                         ? st.proc[p].rate_t_h / w.processes[p].design_rate_t_h
                                         : 0.0);
  }
  auto* procStatus = snap.data() + offsets[2];
  for (uint32_t p = 0; p < nProc; ++p) procStatus[p] = static_cast<uint8_t>(st.proc[p].status);
  auto* unitArr = snap.data() + offsets[3];
  for (uint32_t u = 0; u < nUnits; ++u) {
    const auto& slot = w.catalog.process_types[w.units[u].process.v].units[w.units[u].slot];
    const int online = static_cast<int>(slot.trains) - st.unit[u].trains_down;
    unitArr[u] = static_cast<uint8_t>(std::max(0, online));
  }
  // 4/5 sites: running flag and the worst starvation/overflow pressure among
  // the site's tanks (1 − min(min f, min h), clamped to [0,1]).
  auto* siteStatus = snap.data() + offsets[4];
  auto* siteUrg = reinterpret_cast<float*>(snap.data() + offsets[5]);
  for (uint32_t s = 0; s < nSites; ++s) {
    siteStatus[s] = 0;
    double worst = 1.0;
    for (uint32_t t = 0; t < nTanks; ++t) {
      if (w.tanks[t].site.v != s) continue;
      worst = std::min(worst, std::min(signals[t].f, signals[t].h));
    }
    siteUrg[s] = static_cast<float>(std::clamp(1.0 - worst, 0.0, 1.0));
  }
  auto* pipeArr = reinterpret_cast<float*>(snap.data() + offsets[9]);
  for (uint32_t i = 0; i < nPipes; ++i) {
    pipeArr[i] = static_cast<float>(w.pipelines[i].cap_t_h > 0
                                        ? st.pipe_flow_t_h[i] / w.pipelines[i].cap_t_h
                                        : 0.0);
  }
  auto* priceArr = reinterpret_cast<float*>(snap.data() + offsets[11]);
  for (uint32_t m = 0; m < nMats; ++m) priceArr[m] = 1.0f;
}

}  // namespace

// ---- C ABI ----

crx_sim* crx_create(const char* config_json) {
  try {
    std::string error;
    auto sim = Sim::createFromConfig(config_json, error);
    if (sim == nullptr) {
      std::fprintf(stderr, "crx_create: %s\n", error.c_str());
      return nullptr;
    }
    auto* api = new ApiSim();
    api->sim = std::move(sim);
    ApiSim::buildWorldJson(*api->sim, api->world_json);
    ApiSim::buildTerrain(api->sim->world().seed, api->terrain);
    return reinterpret_cast<crx_sim*>(api);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "crx_create: %s\n", e.what());
    return nullptr;
  }
}

crx_sim* crx_fork(const crx_sim* src) {
  if (src == nullptr) return nullptr;
  return reinterpret_cast<crx_sim*>(new ApiSim(*asApi(src)));
}

void crx_destroy(crx_sim* sim) { delete asApi(sim); }

void crx_step(crx_sim* sim, uint32_t ticks) {
  ApiSim* api = asApi(sim);
  if (api == nullptr) return;
  api->sim->step(ticks);
  api->snap_dirty = true;
}

const char* crx_command(crx_sim* sim, const char* json_cmd) {
  ApiSim* api = asApi(sim);
  if (api == nullptr || json_cmd == nullptr) return R"({"ok":false,"error":"null"})";
  api->reply = api->sim->command(json_cmd);
  return api->reply.c_str();
}

const char* crx_world_json(const crx_sim* sim) { return asApi(sim)->world_json.c_str(); }

const float* crx_terrain(const crx_sim* sim, uint32_t* n) {
  const ApiSim* api = asApi(sim);
  *n = static_cast<uint32_t>(api->terrain.size());
  return api->terrain.data();
}

const uint8_t* crx_snapshot(crx_sim* sim, uint32_t* bytes) {
  ApiSim* api = asApi(sim);
  if (api->snap_dirty) {
    buildSnapshot(*api->sim, api->snap);
    api->snap_dirty = false;
  }
  *bytes = static_cast<uint32_t>(api->snap.size());
  return api->snap.data();
}

const char* crx_events(const crx_sim* sim, uint64_t since_seq) {
  const ApiSim* api = asApi(sim);
  api->reply = crx::sim::eventsJson(api->sim->recorder(), since_seq);
  return api->reply.c_str();
}

const float* crx_series(const crx_sim* sim, uint32_t kind, uint32_t id, uint32_t* n) {
  const ApiSim* api = asApi(sim);
  const crx::sim::Recorder& rec = api->sim->recorder();
  const std::vector<float>* ring = nullptr;
  if (kind == 0) ring = id < rec.tank_fill.size() ? &rec.tank_fill[id] : nullptr;
  if (kind == 1) ring = id < rec.proc_rate.size() ? &rec.proc_rate[id] : nullptr;
  if (ring == nullptr) {
    *n = 0;
    return nullptr;
  }
  *n = static_cast<uint32_t>(ring->size());
  return ring->data();
}

const double* crx_kpis(const crx_sim* sim, uint32_t* n) {
  const ApiSim* api = asApi(sim);
  api->sim->computeKpis(api->kpis);
  *n = static_cast<uint32_t>(api->kpis.size());
  return api->kpis.data();
}

uint64_t crx_tick(const crx_sim* sim) { return asApi(sim)->sim->state().tick; }

uint64_t crx_state_hash(const crx_sim* sim) { return asApi(sim)->sim->stateHash(); }

const char* crx_version(void) { return "crx 0.2.0-m1"; }
