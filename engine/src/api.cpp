// Chain Reaction — engine C ABI implementation (§7.1) over the M1 sim core.
//
// The ABI and the binary snapshot layout are the fixed contracts: one JSON
// document for rare structured data (world description, commands, events),
// one self-describing binary snapshot of typed arrays for per-frame data.
// Array 0 carries the tank signals f/u/h, arrays 1/2 process rate and
// status, array 3 unit trains online, arrays 6–8 vehicles, 10 edge
// availability, 11 the market price index (§5.6).
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
    buildTerrain(seed, terrain);
    buildWorldJson(*sim, terrain, world_json);
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

  static void buildWorldJson(const Sim& s, const std::vector<float>& terrain,
                             std::string& out);
  static void buildTerrain(uint64_t seed, std::vector<float>& out);
};

ApiSim* asApi(crx_sim* s) { return reinterpret_cast<ApiSim*>(s); }
const ApiSim* asApi(const crx_sim* s) { return reinterpret_cast<const ApiSim*>(s); }

void ApiSim::buildWorldJson(const Sim& s, const std::vector<float>& terrain,
                            std::string& out) {
  const auto& w = s.world();
  const auto& cat = w.catalog;
  json mats = json::array();
  for (const auto& m : cat.materials) mats.push_back(m.key);

  // §7.3 world document in the client's full-spec schema — the web scene
  // renders this directly (world.ts resolveWorld), so field names and array
  // order follow web/src/engine/world.ts, not the C++ struct spellings.
  json sites = json::array();
  for (uint32_t i = 0; i < w.sites.size(); ++i) {
    const auto& site = w.sites[i];
    json procs = json::array();
    for (uint32_t p = 0; p < w.processes.size(); ++p) {
      const auto& proc = w.processes[p];
      if (proc.site.v != i) continue;
      const auto& type = cat.process_types[proc.type];
      json units = json::array();
      for (uint32_t u = 0; u < w.units.size(); ++u) {
        const auto& unit = w.units[u];
        if (unit.process.v != static_cast<int>(p)) continue;
        const auto& slot = type.units[unit.slot];
        units.push_back({{"key", slot.key},
                         {"name", slot.name},
                         {"glyph", slot.glyph},
                         {"trains", slot.trains}});
      }
      procs.push_back({{"key", type.key},
                       {"name", type.name},
                       {"designRateTph", proc.design_rate_t_h},
                       {"units", units}});
    }
    const std::string preset =
        site.preset >= 0 && site.preset < static_cast<int>(cat.site_presets.size())
            ? cat.site_presets[site.preset].key
            : site.key;
    sites.push_back({{"name", site.name},
                     {"preset", preset},
                     {"x", site.x_km},
                     {"y", site.y_km},
                     {"processes", procs}});
  }

  json tanks = json::array();
  for (const auto& tank : w.tanks) {
    const char* role = tank.role == crx::TankRole::Feed      ? "feed"
                       : tank.role == crx::TankRole::Product ? "product"
                       : tank.role == crx::TankRole::Internal
                           ? "internal"
                           : "both";
    tanks.push_back({{"site", tank.site.v},
                     {"material", cat.materials[tank.material].key},
                     {"role", role},
                     {"capacityT", tank.capacity_t},
                     {"drawTph", tank.design_out_t_h}});
  }

  // One route per road edge, in edge order; fleet lanes reference these below.
  std::vector<uint32_t> roadRoute(w.edges.size(), UINT32_MAX);
  json routes = json::array();
  const auto roadMode = crx::sim::modeIndex(crx::Mode::Road);
  for (uint32_t e = 0; e < w.edges.size(); ++e) {
    const auto& edge = w.edges[e];
    if (crx::sim::modeIndex(edge.mode) != roadMode) continue;
    roadRoute[e] = static_cast<uint32_t>(routes.size());
    const int sa = w.nodes[edge.a].site, sb = w.nodes[edge.b].site;
    json pts = json::array();
    for (uint32_t i = edge.polyline.begin;
         i < edge.polyline.begin + edge.polyline.count; ++i)
      pts.push_back({w.polyline_xy[2 * i], w.polyline_xy[2 * i + 1]});
    routes.push_back(
        {{"mode", "road"},
         {"ends", {sa >= 0 ? w.sites[sa].name : "off-map",
                   sb >= 0 ? w.sites[sb].name : "off-map"}},
         {"sites", {sa >= 0 ? json(sa) : json(nullptr),
                    sb >= 0 ? json(sb) : json(nullptr)}},
         {"points", pts}});
  }

  json pipes = json::array();
  for (const auto& pl : w.pipelines) {
    const auto& from = w.tanks[pl.from.v];
    const auto& to = w.tanks[pl.to.v];
    // §7.3 leaves pipelines point-to-point: the tank pair carries the flow.
    pipes.push_back({{"fromSite", from.site.v},
                     {"toSite", to.site.v},
                     {"material", cat.materials[pl.material].key},
                     {"capTph", pl.cap_t_h},
                     {"points",
                      json::array({json::array({w.sites[from.site.v].x_km,
                                                w.sites[from.site.v].y_km}),
                                   json::array({w.sites[to.site.v].x_km,
                                                w.sites[to.site.v].y_km})})}});
  }

  json vehicles = json::array();
  for (const auto& f : w.fleet) {
    const auto& vc = cat.vehicle_classes[f.cls];
    // Static display lane: the first contract the vehicle can serve from its
    // home site, mapped to that span's road edge. Live dispatch (and the
    // snapshot arrays) own the actual movement; this only seats the sprite.
    uint32_t route = UINT32_MAX;
    std::string cargo;
    const int home = static_cast<int>(f.home.v);
    const uint32_t homeNode = w.sites[f.home.v].node[roadMode];
    for (const auto& c : w.contracts) {
      const auto& from = w.tanks[c.seller.v];
      const auto& to = w.tanks[c.buyer.v];
      if (from.site.v != static_cast<uint32_t>(home) &&
          to.site.v != static_cast<uint32_t>(home))
        continue;
      const int other = from.site.v == static_cast<uint32_t>(home)
                            ? to.site.v
                            : from.site.v;
      cargo = cat.materials[from.material].key;
      const uint32_t otherNode = w.sites[other].node[roadMode];
      for (uint32_t e = 0; e < w.edges.size() && route == UINT32_MAX; ++e) {
        if (roadRoute[e] == UINT32_MAX) continue;
        const auto& edge = w.edges[e];
        if ((edge.a == homeNode && edge.b == otherNode) ||
            (edge.a == otherNode && edge.b == homeNode))
          route = roadRoute[e];
      }
      break;
    }
    if (route == UINT32_MAX) {
      // No contract lane: park the vehicle on the first road edge at home.
      for (uint32_t e = 0; e < w.edges.size() && route == UINT32_MAX; ++e) {
        if (roadRoute[e] == UINT32_MAX) continue;
        if (w.edges[e].a == homeNode || w.edges[e].b == homeNode)
          route = roadRoute[e];
      }
      if (route == UINT32_MAX) route = 0;
    }
    if (cargo.empty()) cargo = cat.materials.front().key;
    // One leg = one-way traversal of the lane's edge, in ticks.
    double hours = 0;
    for (uint32_t e = 0; e < w.edges.size(); ++e) {
      if (roadRoute[e] != route) continue;
      hours = w.edges[e].length_km / std::max(1.0, w.edges[e].speed_kmh);
      break;
    }
    const double loopTicks =
        std::max(1.0, std::ceil(hours / crx::sim::kTickHours));
    vehicles.push_back({{"cls", vc.key},
                        {"cargo", cargo},
                        {"route", route},
                        {"loopTicks", loopTicks},
                        {"phase", 0.0}});
  }

  json heights = json::array();
  for (float h : terrain) heights.push_back(h);

  const json doc = {{"world", "sixsite"},
                    {"seed", w.seed},
                    {"wKm", 600},
                    {"hKm", 400},
                    {"dt_h", crx::sim::kTickHours},
                    {"materials", mats},
                    {"terrain",
                     {{"cols", 61},
                      {"rows", 41},
                      {"cellKm", 10},
                      {"seaLevelM", 0},
                      {"height", heights}}},
                    {"sites", sites},
                    {"tanks", tanks},
                    {"routes", routes},
                    {"pipelines", pipes},
                    {"vehicles", vehicles}};
  out = doc.dump();
}

// Render-only terrain (never enters the state hash): a C++ port of the web
// stub's generator (world.ts makeTerrain) so the engine-owned world renders
// with the same island character — value-noise meadows, sea in the NE,
// highlands toward the west, heights in metres on a 61×41 / 10 km grid.
void ApiSim::buildTerrain(uint64_t seed, std::vector<float>& out) {
  constexpr int kCols = 61, kRows = 41;
  constexpr double kCellKm = 10.0;
  uint32_t rng = static_cast<uint32_t>(seed) ^ 0x9e3779b9u;
  auto next = [&rng]() {
    rng += 0x6D2B79F5u;
    uint32_t t = rng ^ (rng >> 15);
    t = t * (1u | rng);
    t = (t + (t ^ (t >> 7)) * (61u | t)) ^ t;
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  };
  auto smooth = [](double x, double lo, double hi) {
    const double t = std::clamp((x - lo) / (hi - lo), 0.0, 1.0);
    return t * t * (3 - 2 * t);
  };
  auto octave = [&](double cell) {
    const int gw = static_cast<int>(std::ceil(600.0 / cell)) + 2;
    const int gh = static_cast<int>(std::ceil(400.0 / cell)) + 2;
    std::vector<double> lattice(static_cast<size_t>(gw) * gh);
    for (double& v : lattice) v = next();
    return [lattice, gw, gh, cell](double x, double y) {
      const double fx = x / cell, fy = y / cell;
      const int x0 = static_cast<int>(std::floor(fx));
      const int y0 = static_cast<int>(std::floor(fy));
      const double tx = fx - x0, ty = fy - y0;
      const auto g = [&](int gx, int gy) { return lattice[gy * gw + gx]; };
      const double sx = tx * tx * (3 - 2 * tx);
      const double sy = ty * ty * (3 - 2 * ty);
      const double top = g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx;
      const double bottom = g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx;
      return top * (1 - sy) + bottom * sy;
    };
  };
  const auto base = octave(90);
  const auto detail = octave(30);

  out.assign(static_cast<size_t>(kCols) * kRows, 0.f);
  for (int r = 0; r < kRows; ++r) {
    for (int c = 0; c < kCols; ++c) {
      const double x = c * kCellKm, y = r * kCellKm;
      const double land = 1 - smooth(x + 0.9 * y, 560, 680);
      const double highlands = std::pow(1 - x / 600.0, 2);
      const double n = 0.65 * base(x, y) + 0.35 * detail(x, y);
      out[static_cast<size_t>(r) * kCols + c] =
          static_cast<float>(-6 + land * (5 + 26 * n + 12 * highlands));
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
  const uint32_t nVeh = static_cast<uint32_t>(w.fleet.size());
  const uint32_t nEdges = static_cast<uint32_t>(w.edges.size());

  ArrSpec specs[kNArrays] = {
      {kF32, 4 * nTanks},  // 0 tanks: fill, f, u, h
      {kF32, nProc},       // 1 process rate/design
      {kU8, nProc},        // 2 process status
      {kU8, nUnits},       // 3 units: trains online
      {kU8, nSites},       // 4 sites: status
      {kF32, nSites},      // 5 sites: worst urgency
      {kF32, 5 * nVeh},    // 6 vehicles: x, y, dirx, diry, fill
      {kU8, 2 * nVeh},     // 7 vehicles: status, cargo material
      {kU32, nVeh},        // 8 vehicles: order
      {kF32, nPipes},      // 9 pipelines: flow/capacity
      {kU8, nEdges},       // 10 edges: open flag
      {kF32, nMats},       // 11 price index
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
    // Resolve the unit's slot through its process's TYPE: process ids index
    // w.processes, not the catalog's process_types vector. The previous
    // lookup used the process id directly, reading another type's unit slots
    // (and past the end for later units), so the trains-online bytes of the
    // hosted snapshot were wrong whenever process order ≠ type order.
    const auto& slot = w.catalog.process_types[w.processes[w.units[u].process.v].type].units[w.units[u].slot];
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
  // 6/7/8 vehicles: pose (x, y, dirx, diry, fill), status + cargo material,
  // and the bound order. fill is cargo over class capacity; the material byte
  // is 255 while idle (no cargo).
  auto* vehArr = reinterpret_cast<float*>(snap.data() + offsets[6]);
  auto* vehB = snap.data() + offsets[7];
  auto* vehOrder = reinterpret_cast<uint32_t*>(snap.data() + offsets[8]);
  for (uint32_t v = 0; v < nVeh; ++v) {
    const auto& vs = st.vehicle[v];
    const auto& vc = w.catalog.vehicle_classes[w.fleet[v].cls];
    vehArr[5 * v + 0] = static_cast<float>(vs.x_km);
    vehArr[5 * v + 1] = static_cast<float>(vs.y_km);
    vehArr[5 * v + 2] = static_cast<float>(vs.dir_x);
    vehArr[5 * v + 3] = static_cast<float>(vs.dir_y);
    vehArr[5 * v + 4] =
        static_cast<float>(vc.capacity_t > 0 ? vs.cargo_t / vc.capacity_t : 0.0);
    vehB[2 * v + 0] = static_cast<uint8_t>(vs.status);
    vehB[2 * v + 1] =
        vs.cargo_t > 1e-9 ? static_cast<uint8_t>(vs.cargo_material) : 255u;
    vehOrder[v] = vs.order;
  }
  // 10 edges: availability per route-graph edge (0 = closed by event).
  auto* edgeArr = snap.data() + offsets[10];
  for (uint32_t e = 0; e < nEdges; ++e) edgeArr[e] = st.edge_open[e];
  auto* pipeArr = reinterpret_cast<float*>(snap.data() + offsets[9]);
  for (uint32_t i = 0; i < nPipes; ++i) {
    pipeArr[i] = static_cast<float>(w.pipelines[i].cap_t_h > 0
                                        ? st.pipe_flow_t_h[i] / w.pipelines[i].cap_t_h
                                        : 0.0);
  }
  // 11 price index: §5.6 market values, 1.0 until a matching round moves one.
  auto* priceArr = reinterpret_cast<float*>(snap.data() + offsets[11]);
  for (uint32_t m = 0; m < nMats; ++m)
    priceArr[m] = static_cast<float>(st.price_index[m]);
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
    ApiSim::buildTerrain(api->sim->world().seed, api->terrain);
    ApiSim::buildWorldJson(*api->sim, api->terrain, api->world_json);
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
