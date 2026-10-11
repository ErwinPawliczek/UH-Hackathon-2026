// Chain Reaction — engine C ABI implementation (§7.1) over the M1 sim core.
//
// The ABI and the binary snapshot layout are the fixed contracts: one JSON
// document for rare structured data (world description, commands, events),
// one self-describing binary snapshot of typed arrays for per-frame data.
// Array 0 carries the tank signals f/u/h, arrays 1/2 process rate and
// status, array 3 unit trains online, arrays 6–8 vehicles, 10 edge
// availability, 11 the market price index (§5.6). Version 2 appends arrays
// 12–14: per vehicle the client route id it is driving, progress along that
// route's polyline, and the tick its current activity ends — the client
// renders movement from these snapshot fields, not from any world payload
// schedule.
#include "crx/api.h"

#include "api_world.h"
#include "sim/routes.h"
#include "sim/inspect.h"
#include "sim/sim.h"
#include "sim/window.h"

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

namespace crx {

namespace {

// Seeded value-noise helpers shared by both terrain builders (a C++ port of
// the web stub's generator, world.ts makeTerrain).
struct TerrainRng {
  uint32_t state;
  explicit TerrainRng(uint64_t seed) : state(static_cast<uint32_t>(seed) ^ 0x9e3779b9u) {}
  double next() {
    state += 0x6D2B79F5u;
    uint32_t t = state ^ (state >> 15);
    t = t * (1u | state);
    t = (t + (t ^ (t >> 7)) * (61u | t)) ^ t;
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  }
};

double smoothStep(double x, double lo, double hi) {
  const double t = std::clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return t * t * (3 - 2 * t);
}

// One octave of bilinear value noise over a w_km × h_km map.
struct NoiseOctave {
  std::vector<double> lattice;
  int gw = 0, gh = 0;
  double cell = 1;
  NoiseOctave(TerrainRng& rng, double cell_km, double w_km, double h_km) : cell(cell_km) {
    gw = static_cast<int>(std::ceil(w_km / cell)) + 2;
    gh = static_cast<int>(std::ceil(h_km / cell)) + 2;
    lattice.resize(static_cast<size_t>(gw) * gh);
    for (double& v : lattice) v = rng.next();
  }
  double operator()(double x, double y) const {
    const double fx = x / cell, fy = y / cell;
    const int x0 = std::clamp(static_cast<int>(std::floor(fx)), 0, gw - 2);
    const int y0 = std::clamp(static_cast<int>(std::floor(fy)), 0, gh - 2);
    const double tx = std::clamp(fx - x0, 0.0, 1.0), ty = std::clamp(fy - y0, 0.0, 1.0);
    const auto g = [&](int gx, int gy) { return lattice[static_cast<size_t>(gy) * gw + gx]; };
    const double sx = tx * tx * (3 - 2 * tx);
    const double sy = ty * ty * (3 - 2 * ty);
    const double top = g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx;
    const double bottom = g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  }
};

const char* modeName(crx::Mode mode) {
  return mode == crx::Mode::River ? "river" : mode == crx::Mode::Sea ? "sea" : "road";
}

}  // namespace

// Render-only terrain (never enters the state hash) for worlds without a
// water mask: value-noise meadows, sea in the NE, highlands toward the west,
// heights in metres on a 61×41 / 10 km grid.
void buildSeedTerrain(uint64_t seed, TerrainGrid& out) {
  constexpr int kCols = 61, kRows = 41;
  constexpr double kCellKm = 10.0;
  TerrainRng rng(seed);
  const NoiseOctave base(rng, 90, 600.0, 400.0);
  const NoiseOctave detail(rng, 30, 600.0, 400.0);

  out.cols = kCols;
  out.rows = kRows;
  out.cell_km = kCellKm;
  out.height.assign(static_cast<size_t>(kCols) * kRows, 0.f);
  for (int r = 0; r < kRows; ++r) {
    for (int c = 0; c < kCols; ++c) {
      const double x = c * kCellKm, y = r * kCellKm;
      const double land = 1 - smoothStep(x + 0.9 * y, 560, 680);
      const double highlands = std::pow(1 - x / 600.0, 2);
      const double n = 0.65 * base(x, y) + 0.35 * detail(x, y);
      out.height[static_cast<size_t>(r) * kCols + c] =
          static_cast<float>(-6 + land * (5 + 26 * n + 12 * highlands));
    }
  }
}

// Render-only terrain from a hand-drawn water mask. Samples sit on a grid
// twice as fine as the mask, so each mask cell owns one interior sample and
// shares its edge and corner samples with its neighbours: a sample is water
// (below sea level) when every mask cell it touches is water, land when
// every one is land, and exactly sea level on the shoreline in between. The
// client's bilinear sampling then puts the zero contour on the mask outline,
// so drawn rivers come out as continuous water one mask cell wide.
void buildMaskTerrain(const sim::World& world, TerrainGrid& out) {
  const int mcols = static_cast<int>(world.water_cols);
  const int mrows = static_cast<int>(world.water_rows);
  const double cell = world.water_cell_km / 2.0;
  const int cols = 2 * mcols + 1, rows = 2 * mrows + 1;
  out.cols = static_cast<uint32_t>(cols);
  out.rows = static_cast<uint32_t>(rows);
  out.cell_km = cell;
  out.height.assign(static_cast<size_t>(cols) * rows, 0.f);

  // Sample class: 2 = water, 1 = shoreline, 0 = land.
  std::vector<uint8_t> cls(static_cast<size_t>(cols) * rows, 0);
  const auto maskAt = [&](int c, int r) {
    return world.water[static_cast<size_t>(r) * mcols + c] != 0;
  };
  for (int j = 0; j < rows; ++j) {
    for (int i = 0; i < cols; ++i) {
      // Mask cells this sample touches: one when the index is odd (interior),
      // the two neighbours when even (on their shared edge), clipped to the map.
      const int c0 = (i % 2 == 1) ? (i - 1) / 2 : i / 2 - 1, c1 = (i % 2 == 1) ? c0 : i / 2;
      const int r0 = (j % 2 == 1) ? (j - 1) / 2 : j / 2 - 1, r1 = (j % 2 == 1) ? r0 : j / 2;
      int water = 0, land = 0;
      for (int r = std::max(0, r0); r <= std::min(mrows - 1, r1); ++r)
        for (int c = std::max(0, c0); c <= std::min(mcols - 1, c1); ++c)
          (maskAt(c, r) ? water : land) += 1;
      cls[static_cast<size_t>(j) * cols + i] = land == 0 ? 2 : water == 0 ? 0 : 1;
    }
  }

  // Distance from each land sample to the nearest water or shoreline sample
  // (two-pass chamfer, in km) — the coast stays low, the interior rises.
  const double kFar = 1e9, diag = cell * std::sqrt(2.0);
  std::vector<double> dist(cls.size(), kFar);
  for (size_t k = 0; k < cls.size(); ++k)
    if (cls[k] != 0) dist[k] = 0.0;
  const auto relax = [&](int i, int j, int di, int dj, double step) {
    const int ni = i + di, nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) return;
    double& d = dist[static_cast<size_t>(j) * cols + i];
    d = std::min(d, dist[static_cast<size_t>(nj) * cols + ni] + step);
  };
  for (int j = 0; j < rows; ++j)
    for (int i = 0; i < cols; ++i) {
      relax(i, j, -1, 0, cell);
      relax(i, j, 0, -1, cell);
      relax(i, j, -1, -1, diag);
      relax(i, j, 1, -1, diag);
    }
  for (int j = rows - 1; j >= 0; --j)
    for (int i = cols - 1; i >= 0; --i) {
      relax(i, j, 1, 0, cell);
      relax(i, j, 0, 1, cell);
      relax(i, j, 1, 1, diag);
      relax(i, j, -1, 1, diag);
    }

  TerrainRng rng(world.seed);
  const double w_km = (cols - 1) * cell, h_km = (rows - 1) * cell;
  const NoiseOctave base(rng, 90, w_km, h_km);
  const NoiseOctave detail(rng, 30, w_km, h_km);
  for (int j = 0; j < rows; ++j) {
    for (int i = 0; i < cols; ++i) {
      const size_t k = static_cast<size_t>(j) * cols + i;
      double h = 0.0;  // shoreline
      if (cls[k] == 2) {
        h = -6.0;
      } else if (cls[k] == 0) {
        const double n = 0.65 * base(i * cell, j * cell) + 0.35 * detail(i * cell, j * cell);
        const double inland = std::min(dist[k], 1000.0);
        h = 1.5 + smoothStep(inland, 0.0, 30.0) * (3.0 + 20.0 * n);
      }
      out.height[k] = static_cast<float>(h);
    }
  }
}

void buildTerrain(const sim::World& world, TerrainGrid& out) {
  const bool masked = world.water_cell_km > 0.0 && world.water_cols > 0 && world.water_rows > 0 &&
                      world.water.size() ==
                          static_cast<size_t>(world.water_cols) * world.water_rows;
  if (masked)
    buildMaskTerrain(world, out);
  else
    buildSeedTerrain(world.seed, out);
}

std::string buildWorldJson(const sim::World& w, const TerrainGrid& terrain,
                           std::vector<uint32_t>& edge_route) {
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
      // Flowsheet data for the site panel: every stream at design rate,
      // weighted over the process's mode mix. A stream is a "material" (it
      // has a tank on site, by index), "internal" (unit to unit inside the
      // process) or a "utility" (fuel gas, water, air, losses). Live values
      // are these times the process's rate ÷ design from the snapshot.
      const auto streamList = [&](const std::vector<std::vector<crx::Stream>>& by_mode) {
        std::vector<std::pair<std::string, double>> acc;  // key -> t/h, first-seen order
        std::vector<uint16_t> slots;
        for (size_t m = 0; m < by_mode.size() && m < proc.mode_share.size(); ++m) {
          const double share = proc.mode_share[m];
          if (share <= 0) continue;
          for (const auto& st : by_mode[m]) {
            const double tph = std::abs(st.t_per_t) * share * proc.design_rate_t_h;
            size_t k = 0;
            while (k < acc.size() && acc[k].first != st.key) ++k;
            if (k == acc.size()) {
              acc.emplace_back(st.key, 0.0);
              slots.push_back(st.slot);
            }
            acc[k].second += tph;
          }
        }
        json out = json::array();
        for (size_t k = 0; k < acc.size(); ++k) {
          const uint16_t slot = slots[k];
          const bool internal = slot >= crx::kInternalStreamBase;
          const bool utility =
              !internal && cat.materials[slot].kind == crx::MatKind::Pseudo;
          json tank = nullptr;
          if (!internal && !utility && slot < proc.tank_of.size() && proc.tank_of[slot].valid())
            tank = proc.tank_of[slot].v;
          out.push_back({{"key", acc[k].first},
                         {"tph", acc[k].second},
                         {"kind", internal ? "internal" : utility ? "utility" : "material"},
                         {"tank", tank}});
        }
        return out;
      };
      json units = json::array();
      for (uint32_t u = 0; u < w.units.size(); ++u) {
        const auto& unit = w.units[u];
        if (unit.process.v != p) continue;
        const auto& slot = type.units[unit.slot];
        std::vector<std::vector<crx::Stream>> ins, outs;
        double heat = 0, power = 0;
        for (size_t m = 0; m < slot.by_mode.size(); ++m) {
          ins.push_back(slot.by_mode[m].in);
          outs.push_back(slot.by_mode[m].out);
          const double share = m < proc.mode_share.size() ? proc.mode_share[m] : 0.0;
          heat += slot.by_mode[m].heat_gj * share * proc.design_rate_t_h;
          power += slot.by_mode[m].power_mwh * share * proc.design_rate_t_h;
        }
        units.push_back({{"key", slot.key},
                         {"name", slot.name},
                         {"glyph", slot.glyph},
                         {"trains", slot.trains},
                         {"index", u},
                         {"capPerTrainTph", unit.cap_per_train_t_h},
                         {"in", streamList(ins)},
                         {"out", streamList(outs)},
                         {"heatGjH", heat},
                         {"powerMw", power}});
      }
      // Net streams of the whole process, split by direction.
      std::vector<std::vector<crx::Stream>> net_in, net_out;
      for (const auto& mode : type.net) {
        net_in.emplace_back();
        net_out.emplace_back();
        for (const auto& st : mode) (st.t_per_t < 0 ? net_in : net_out).back().push_back(st);
      }
      json modes = json::array(), shares = json::array();
      for (size_t m = 0; m < type.modes.size(); ++m) {
        modes.push_back(type.modes[m]);
        shares.push_back(m < proc.mode_share.size() ? proc.mode_share[m] : 0.0);
      }
      procs.push_back({{"key", type.key},
                       {"name", type.name},
                       {"index", p},
                       {"designRateTph", proc.design_rate_t_h},
                       {"basis", type.basis_key},
                       {"boundary", type.boundary == crx::Boundary::Source  ? "source"
                                    : type.boundary == crx::Boundary::Sink ? "sink"
                                                                           : "none"},
                       {"modes", modes},
                       {"modeShare", shares},
                       {"turndown", type.turndown},
                       {"restartH", type.restart_h},
                       {"in", streamList(net_in)},
                       {"out", streamList(net_out)},
                       {"units", units}});
    }
    const std::string preset =
        site.preset >= 0 && site.preset < static_cast<int>(cat.site_presets.size())
            ? cat.site_presets[site.preset].key
            : site.key;
    sites.push_back({{"key", site.key},
                     {"name", site.name},
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
                     {"drawTph", tank.design_out_t_h},
                     {"rejectWhenFull", tank.reject_when_full}});
  }

  // A route end that is not a site is a junction of the drawn network (or an
  // off-map end): name it after the nearest site so the UI reads "near
  // Refinery" rather than a bare node number.
  const auto endName = [&](const sim::RouteNode& node) -> std::string {
    if (node.site >= 0) return w.sites[node.site].name;
    int best = -1;
    double best_d = 0.0;
    for (size_t s = 0; s < w.sites.size(); ++s) {
      const double d = std::hypot(w.sites[s].x_km - node.x_km, w.sites[s].y_km - node.y_km);
      if (best < 0 || d < best_d) {
        best = static_cast<int>(s);
        best_d = d;
      }
    }
    return best < 0 ? std::string("off-map") : "near " + w.sites[best].name;
  };

  // One route per edge, in edge order, every mode — vehicles (trucks, barges,
  // ships alike) map their current edge to a client route by this index. The
  // edge → route mapping lands in edge_route for the snapshot writer.
  json routes = json::array();
  edge_route.assign(w.edges.size(), UINT32_MAX);
  for (uint32_t e = 0; e < w.edges.size(); ++e) {
    const auto& edge = w.edges[e];
    const auto& na = w.nodes[edge.a];
    const auto& nb = w.nodes[edge.b];
    json pts = json::array();
    for (uint32_t i = edge.polyline.begin;
         i < edge.polyline.begin + edge.polyline.count; ++i)
      pts.push_back({w.polyline_xy[2 * i], w.polyline_xy[2 * i + 1]});
    edge_route[e] = static_cast<uint32_t>(routes.size());
    routes.push_back(
        {{"mode", modeName(edge.mode)},
         {"ends", {endName(na), endName(nb)}},
         {"sites", {na.site >= 0 ? json(na.site) : json(nullptr),
                    nb.site >= 0 ? json(nb.site) : json(nullptr)}},
         // true where the end is a network junction rather than a site
         {"junction", {na.site < 0, nb.site < 0}},
         {"points", pts}});
  }

  json pipes = json::array();
  for (const auto& pl : w.pipelines) {
    const auto& from = w.tanks[pl.from.v];
    const auto& to = w.tanks[pl.to.v];
    // The drawn path when the world carries one; otherwise §7.3's
    // point-to-point line between the two sites.
    json pts = json::array();
    if (pl.polyline.count >= 2 &&
        2 * static_cast<size_t>(pl.polyline.begin + pl.polyline.count) <= w.polyline_xy.size()) {
      for (uint32_t i = pl.polyline.begin; i < pl.polyline.begin + pl.polyline.count; ++i)
        pts.push_back({w.polyline_xy[2 * i], w.polyline_xy[2 * i + 1]});
    } else {
      pts.push_back({w.sites[from.site.v].x_km, w.sites[from.site.v].y_km});
      pts.push_back({w.sites[to.site.v].x_km, w.sites[to.site.v].y_km});
    }
    pipes.push_back({{"fromSite", from.site.v},
                     {"toSite", to.site.v},
                     {"material", cat.materials[pl.material].key},
                     {"capTph", pl.cap_t_h},
                     {"points", pts}});
  }

  // Fleet manifest only: class, home site and a representative cargo. Live
  // movement and the cargo actually on board are snapshot state (arrays 6–8
  // and 12–14), never a world payload schedule.
  json vehicles = json::array();
  for (const auto& f : w.fleet) {
    const auto& vc = cat.vehicle_classes[f.cls];
    // Representative cargo: the contract lane at the home site if there is
    // one, else the first material this class can carry in its mode.
    std::string cargo;
    for (const auto& c : w.contracts) {
      const auto& from = w.tanks[c.seller.v];
      const auto& to = w.tanks[c.buyer.v];
      if (from.site.v == static_cast<uint32_t>(f.home.v) ||
          to.site.v == static_cast<uint32_t>(f.home.v)) {
        cargo = cat.materials[from.material].key;
        break;
      }
    }
    if (cargo.empty()) {
      for (const auto& m : cat.materials) {
        if (m.phase != vc.carries) continue;
        if (!(m.modes & (1u << static_cast<uint8_t>(vc.mode)))) continue;
        cargo = m.key;
        break;
      }
    }
    if (cargo.empty()) cargo = cat.materials.front().key;
    vehicles.push_back({{"cls", vc.key}, {"cargo", cargo}, {"home", f.home.v}});
  }

  // Heights to 0.1 m: the grid is the bulk of the document and a float's
  // full decimal expansion would triple its size.
  json heights = json::array();
  for (float h : terrain.height) heights.push_back(std::round(h * 10.0) / 10.0);

  const json doc = {{"world", w.name},
                    {"seed", w.seed},
                    {"wKm", w.w_km},
                    {"hKm", w.h_km},
                    {"dt_h", crx::sim::kTickHours},
                    {"materials", mats},
                    {"terrain",
                     {{"cols", terrain.cols},
                      {"rows", terrain.rows},
                      {"cellKm", terrain.cell_km},
                      {"seaLevelM", 0},
                      {"height", heights}}},
                    {"sites", sites},
                    {"tanks", tanks},
                    {"routes", routes},
                    {"pipelines", pipes},
                    {"vehicles", vehicles}};
  return doc.dump();
}

}  // namespace crx

namespace {

constexpr uint32_t kSnapshotVersion = 2;
constexpr uint32_t kNArrays = 15;
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
  // Client route index per world edge (world JSON routes[] order), filled by
  // buildWorldJson and read by the snapshot writer (array 12). UINT32_MAX
  // where an edge has no client route (none today — every edge gets one).
  std::vector<uint32_t> edge_route;
  mutable std::vector<double> kpis;
  crx::TerrainGrid terrain;
  mutable std::vector<uint8_t> snap;
  mutable bool snap_dirty = true;

  ApiSim() = default;
  explicit ApiSim(uint64_t seed) {
    std::string error;
    sim = Sim::create(seed, error);
    if (sim == nullptr) throw std::runtime_error(error);
    describeWorld();
  }

  // Render-side description of the sim's world: terrain grid and world JSON.
  void describeWorld() {
    crx::buildTerrain(sim->world(), terrain);
    world_json = crx::buildWorldJson(sim->world(), terrain, edge_route);
  }

  ApiSim(const ApiSim& other)
      : sim(std::make_unique<Sim>(*other.sim)),
        reply(other.reply),
        world_json(other.world_json),
        edge_route(other.edge_route),
        kpis(other.kpis),
        terrain(other.terrain),
        snap{},
        snap_dirty(true) {}
  ApiSim& operator=(const ApiSim&) = delete;
};

ApiSim* asApi(crx_sim* s) { return reinterpret_cast<ApiSim*>(s); }
const ApiSim* asApi(const crx_sim* s) { return reinterpret_cast<const ApiSim*>(s); }

void buildSnapshot(const Sim& sim, const std::vector<uint32_t>& edge_route,
                   std::vector<uint8_t>& snap) {
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
      {kU32, nVeh},        // 12 vehicles: client route id (v2, UINT32_MAX = none)
      {kF32, nVeh},        // 13 vehicles: progress 0..1 along that route (v2)
      {kU32, nVeh},        // 14 vehicles: tick the current activity ends (v2)
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
  // 4/5 sites: the worst state among the site's processes, in the client's
  // site-state order (0 running, 1 holding at minimum, 3 shut down,
  // 4 restarting — a shutdown outranks a restart outranks a hold), and the
  // worst starvation/overflow pressure among the site's tanks
  // (1 − min(min f, min h), clamped to [0,1]).
  auto* siteStatus = snap.data() + offsets[4];
  auto* siteUrg = reinterpret_cast<float*>(snap.data() + offsets[5]);
  for (uint32_t s = 0; s < nSites; ++s) {
    using crx::sim::ProcStatus;
    bool down = false, restarting = false, holding = false;
    for (uint32_t p = 0; p < nProc; ++p) {
      if (w.processes[p].site.v != s) continue;
      down = down || st.proc[p].status == ProcStatus::Shutdown;
      restarting = restarting || st.proc[p].status == ProcStatus::Restarting;
      holding = holding || st.proc[p].status == ProcStatus::HoldMin;
    }
    // 5 = limited: nothing is stopped, but a supply or demand shock is
    // holding the site away from normal.
    bool limited = false;
    for (const auto& ev : st.active)
      limited = limited || (ev.site == s && ev.multiplier != 1.0 &&
                            (ev.type == crx::sim::EventDef::Type::SupplyShock ||
                             ev.type == crx::sim::EventDef::Type::DemandShock));
    siteStatus[s] = down ? 3 : restarting ? 4 : holding ? 1 : limited ? 5 : 0;
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
    // 12–14 (v2): assigned route, progress and activity ETA — the client
    // interpolates movement along the route polyline from these. All three
    // are pure functions of (World, State) computed here, so they stay
    // deterministic and outside the hashed state (no wall clock anywhere).
    auto* vehRoute = reinterpret_cast<uint32_t*>(snap.data() + offsets[12]);
    auto* vehProg = reinterpret_cast<float*>(snap.data() + offsets[13]);
    auto* vehEta = reinterpret_cast<uint32_t*>(snap.data() + offsets[14]);
    const uint32_t kNone = UINT32_MAX;
    using crx::sim::VehStatus;
    vehRoute[v] = kNone;
    vehProg[v] = 0.0f;
    vehEta[v] = kNone;
    if (vs.edge != UINT32_MAX && vs.edge < edge_route.size() &&
        edge_route[vs.edge] != UINT32_MAX) {
      const auto& edge = w.edges[vs.edge];
      // Same direction convention as advanceTravel: reverse means the vehicle
      // travels b→a against the polyline's stored order.
      const bool reverse =
          vs.leg < vs.route_nodes.size() && vs.route_nodes[vs.leg] == edge.b;
      const double frac =
          vs.edge_pos_km / std::max(edge.length_km, 1e-9);
      vehRoute[v] = edge_route[vs.edge];
      vehProg[v] = static_cast<float>(std::clamp(reverse ? 1.0 - frac : frac, 0.0, 1.0));
    }
    // Activity-end ETA in ticks: remaining travel along the planned route
    // (current edge remainder, then the legs ahead at per-edge speeds), or
    // the rest of the load/unload at the class's bay rate. Queue waits are
    // contention-dependent and stay unestimated (kNone).
    double etaHours = -1.0;
    if (vs.status == VehStatus::ToPickup || vs.status == VehStatus::ToDropoff) {
      etaHours = 0.0;
      if (vs.edge != UINT32_MAX) {
        const auto& edge = w.edges[vs.edge];
        etaHours += (edge.length_km - vs.edge_pos_km) /
                    std::max(1.0, std::min(edge.speed_kmh, vc.speed_kmh));
      }
      for (uint32_t i = vs.leg + 1; i + 1 < vs.route_nodes.size(); ++i) {
        const uint32_t e =
            edgeBetween(w, vc.mode, vs.route_nodes[i], vs.route_nodes[i + 1]);
        if (e == UINT32_MAX) {
          etaHours = -1.0;  // route hole (closure mid-plan): not derivable
          break;
        }
        etaHours += w.edges[e].length_km /
                    std::max(1.0, std::min(w.edges[e].speed_kmh, vc.speed_kmh));
      }
    } else if (vs.status == VehStatus::Loading && vs.order < st.order.size()) {
      etaHours = (st.order[vs.order].qty_t - vs.moved_t) / std::max(1e-9, vc.load_t_h);
    } else if (vs.status == VehStatus::Unloading && vs.order < st.order.size()) {
      etaHours = vs.cargo_t / std::max(1e-9, vc.load_t_h);
    }
    if (etaHours >= 0.0)
      vehEta[v] = static_cast<uint32_t>(
          tick + static_cast<uint64_t>(std::ceil(etaHours / crx::sim::kTickHours - 1e-9)));
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
    api->describeWorld();
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
  *n = static_cast<uint32_t>(api->terrain.height.size());
  return api->terrain.height.data();
}

const uint8_t* crx_snapshot(crx_sim* sim, uint32_t* bytes) {
  ApiSim* api = asApi(sim);
  if (api->snap_dirty) {
    buildSnapshot(*api->sim, api->edge_route, api->snap);
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

const char* crx_step_report(crx_sim* sim, uint32_t ticks) {
  ApiSim* api = asApi(sim);
  if (api == nullptr) return "{}";
  const crx::sim::WindowReport report = crx::sim::runWindow(*api->sim, ticks);
  api->snap_dirty = true;
  api->reply = crx::sim::windowJson(api->sim->world(), report);
  return api->reply.c_str();
}

const char* crx_vehicle(const crx_sim* sim, uint32_t index) {
  const ApiSim* api = asApi(sim);
  if (api == nullptr) return nullptr;
  api->reply = crx::sim::vehicleJson(api->sim->world(), api->sim->state(), index);
  return api->reply.empty() ? nullptr : api->reply.c_str();
}

const char* crx_economy(const crx_sim* sim, uint32_t bucket_h) {
  const ApiSim* api = asApi(sim);
  if (api == nullptr || bucket_h < 1 || bucket_h > 168) return nullptr;
  api->reply = crx::sim::economyJson(api->sim->world(), api->sim->state(), api->sim->recorder(),
                                     bucket_h);
  return api->reply.c_str();
}

const char* crx_sourcing(const crx_sim* sim, const char* site, const char* material) {
  const ApiSim* api = asApi(sim);
  if (api == nullptr) return "{\"error\":\"null\"}";
  const bool no_site = site == nullptr || site[0] == '\0';
  const bool no_material = material == nullptr || material[0] == '\0';
  if (no_site && no_material)
    api->reply = crx::sim::buyTanksJson(*api->sim);
  else if (no_site || no_material)
    api->reply = R"({"error":"give both site and material, or neither"})";
  else
    api->reply = crx::sim::sourcingJson(*api->sim, site, material);
  return api->reply.c_str();
}

uint64_t crx_tick(const crx_sim* sim) { return asApi(sim)->sim->state().tick; }

uint64_t crx_state_hash(const crx_sim* sim) { return asApi(sim)->sim->stateHash(); }

const char* crx_version(void) { return "crx 0.2.0-m1"; }
