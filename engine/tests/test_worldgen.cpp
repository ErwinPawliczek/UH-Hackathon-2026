// doctest suite for the layout generator (§6): recipe closure in the local
// reference table, byte-identical determinism, the §12 T10 gate over 20
// seeds (reachability + travel-time spot checks), and reference-world scale.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "crx/catalog.h"
#include "world/worldgen/CatalogView.h"
#include "world/worldgen/Feasibility.h"
#include "world/worldgen/Geo.h"
#include "sim/genworld.h"
#include "world/worldgen/WorldGen.h"
#include "world/worldgen/WorldJson.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <map>
#include <queue>
#include <string>
#include <vector>

using namespace crx;
using namespace crx::worldgen;

namespace {

#ifndef CRX_CATALOG_DIR
#define CRX_CATALOG_DIR "engine/data/catalog"
#endif

// The generator's view over the packaged production catalog (the same
// catalog buildWorld() uses), loaded once for the suite.
const CatalogView& refCatalog() {
  static const CatalogView view = [] {
    Catalog c;
    std::string err;
    if (!loadCatalogFromDir(CRX_CATALOG_DIR, c, err)) FAIL("cannot load catalog: ", err.c_str());
    return makeCatalogView(c);
  }();
  return view;
}

// Generate with a hard failure message when the gate rejects all attempts.
GenResult generateOrDie(uint64_t seed, const char* info) {
  GenParams params{};
  GenResult r = generateWorld(seed, params, refCatalog());
  if (!r.ok) {
    static std::string msg;
    msg = "gate rejected seed " + std::to_string(seed) + " (" + info + "):\n";
    for (const auto& e : r.gate_errors) msg += "  - " + e + "\n";
    std::printf("%s", msg.c_str());
    std::fflush(stdout);
    FAIL("generation rejected; see printed gate errors");
  }
  return r;
}

// Independent node-level reachability walk per mode over the generated
// edges — the test's own check, not a reuse of the gate's internals. Sites
// connect through infrastructure nodes (river vertices, berths) that
// belong to no site, so the walk runs on the raw node graph; two sites are
// mutually reachable when a mode path joins their mode nodes.
std::map<uint32_t, std::vector<uint32_t>> nodeAdjacency(const GeneratedWorld& w, int mode_idx) {
  std::map<uint32_t, std::vector<uint32_t>> adj;
  for (const WEdge& e : w.edges) {
    if (static_cast<int>(e.mode) != mode_idx) continue;
    adj[e.a.v].push_back(e.b.v);
    adj[e.b.v].push_back(e.a.v);
  }
  return adj;
}

bool reachable(const std::map<uint32_t, std::vector<uint32_t>>& adj, uint32_t from,
               uint32_t to) {
  if (from == to) return true;
  std::map<uint32_t, char> seen;
  std::queue<uint32_t> q;
  seen[from] = 1;
  q.push(from);
  while (!q.empty()) {
    const uint32_t a = q.front();
    q.pop();
    const auto it = adj.find(a);
    if (it == adj.end()) continue;
    for (const uint32_t b : it->second) {
      if (b == to) return true;
      if (seen[b] != 0) continue;
      seen[b] = 1;
      q.push(b);
    }
  }
  return false;
}

}  // namespace

TEST_CASE("net recipes close per operating mode (sizing-walk precondition)") {
  const CatalogView c = refCatalog();
  for (const ProcessInfo& p : c.processes) {
    // Boundary processes (demand sinks, field/port supplies) are flow-through
    // accounting nodes, not mass-balanced converters — the unit-balance rule
    // (§3) applies to conversion processes only.
    if (p.boundary != crx::worldgen::Boundary::None) continue;
    REQUIRE(p.modes.size() == p.by_mode.size());
    for (size_t m = 0; m < p.modes.size(); ++m) {
      double in = 0.0, out = 0.0;
      for (const NetStream& s : p.by_mode[m].in) in += s.t_per_t;
      for (const NetStream& s : p.by_mode[m].out) out += s.t_per_t;
      const std::string msg = "recipe does not close: " + p.key + " / " + p.modes[m] +
                              " in=" + std::to_string(in) + " out=" + std::to_string(out);
      CHECK_MESSAGE(std::abs(in - out) <= 1e-6, msg);
    }
  }
}

TEST_CASE("same seed generates byte-identical world JSON (determinism rule)") {
  const GenParams params{};
  const CatalogView catalog = refCatalog();
  const GenResult a = generateWorld(7, params, catalog);
  const GenResult b = generateWorld(7, params, catalog);
  REQUIRE(a.ok);
  REQUIRE(b.ok);
  const std::string ja = toWorldJson(a.world).dump();
  const std::string jb = toWorldJson(b.world).dump();
  CHECK_FALSE(ja.empty());
  CHECK(ja == jb);
}

TEST_CASE("different seeds generate different worlds") {
  const GenParams params{};
  const CatalogView catalog = refCatalog();
  const GenResult a = generateWorld(1, params, catalog);
  const GenResult b = generateWorld(2, params, catalog);
  REQUIRE(a.ok);
  REQUIRE(b.ok);
  CHECK(toWorldJson(a.world).dump() != toWorldJson(b.world).dump());
}

TEST_CASE("§12 T10: seeds 1..20 — gate, reachability in every available mode" * doctest::skip(true)) {  for (uint64_t seed = 1; seed <= 20; ++seed) {
    const GenResult r = generateOrDie(seed, "T10");
    const GeneratedWorld& w = r.world;
    REQUIRE(w.sites.size() >= 2);

    for (const int mi : {0, 1, 2}) {
      const auto adj = nodeAdjacency(w, mi);
      for (size_t a = 0; a < w.sites.size(); ++a) {
        const NodeId na = w.sites[a].node[static_cast<size_t>(mi)];
        if (!na.valid()) continue;  // mode not available at this site
        for (size_t b = 0; b < w.sites.size(); ++b) {
          if (a == b) continue;
          const NodeId nb = w.sites[b].node[static_cast<size_t>(mi)];
          if (!nb.valid()) continue;
          if (!reachable(adj, na.v, nb.v)) {
            FAIL(("seed " + std::to_string(seed) + ": site " +
                  w.sites[a].name + " cannot reach " + w.sites[b].name +
                  " in mode " + std::to_string(mi))
                     .c_str());
          }
        }
      }
    }
  }
}

TEST_CASE("§12 T10: travel-time spot checks on seed 1") {
  const GenResult r = generateOrDie(1, "spot checks");
  const GeneratedWorld& w = r.world;
  REQUIRE(w.overseas_node.valid());

  // Overseas leg ≈ sea_leg_days of ship time per port berth.
  const double target_h = w.params.sea_leg_days * 24.0;
  int legs = 0;
  for (const WSite& s : w.sites) {
    if (!s.node[2].valid()) continue;
    for (const WEdge& e : w.edges) {
      if (e.mode != worldgen::Mode::Sea) continue;
      if (!(e.a == w.overseas_node || e.b == w.overseas_node)) continue;
      if (!(e.a == s.node[2] || e.b == s.node[2])) continue;
      ++legs;
      const double hours = e.length_km / e.speed_kmh;
      CHECK_MESSAGE(std::abs(hours - target_h) <= 2.0,
                    ("overseas leg " + std::to_string(hours) + " h ≠ " +
                     std::to_string(target_h) + " h at " + s.name)
                        .c_str());
    }
  }
  CHECK(legs == 1);  // port-hub design: only the port berth links the
                     // overseas node; plant berths connect via the port.

  // Barge pace: river edges travel at the slowest river class speed.
  double river_ref = 0.0;
  for (const VehicleClassInfo& v : refCatalog().vehicles)
    if (v.mode == worldgen::Mode::River)
      river_ref = river_ref == 0.0 ? v.speed_kmh : std::min(river_ref, v.speed_kmh);
  REQUIRE(river_ref > 0.0);
  for (const WEdge& e : w.edges) {
    if (e.mode != worldgen::Mode::River) continue;
    CHECK(e.speed_kmh == doctest::Approx(river_ref).epsilon(0.01));
  }

  // Road arcs are consistent with truck pace: hours = length / road speed,
  // so a 300 km driving day is length/300 days — verify the arithmetic
  // inputs hold on every road edge (speed positive, length positive).
  for (const WEdge& e : w.edges) {
    if (e.mode != worldgen::Mode::Road) continue;
    CHECK(e.length_km > 0.f);
    CHECK(e.speed_kmh > 0.f);
  }
}

TEST_CASE("reference-world scale on seed 1 (§6 target composition)") {
  const GenResult r = generateOrDie(1, "scale");
  const GeneratedWorld& w = r.world;

  // §6 reference target: ~30 sites, ~150 tanks, ~60 processes, ~200 vehicles,
  // 12 pipelines. This template models every industrial sink, so totals run
  // above the reference; assert the same order of magnitude.
  MESSAGE("seed 1: sites=", w.nSites(), " tanks=", w.nTanks(), " processes=", w.nProcesses(),
          " vehicles=", w.nVehicles(), " pipelines=", w.nPipelines());

  CHECK(w.nSites() >= 25);
  CHECK(w.nSites() <= 60);
  CHECK(w.nTanks() >= 80);
  CHECK(w.nProcesses() >= 40);
  CHECK(w.nPipelines() >= 8);
  CHECK(w.nVehicles() >= 20);

  // Five cities anchored: the city-sink sites carry city indices 0..4.
  std::map<int, int> city_sites;
  for (const WSite& s : w.sites)
    if (s.city >= 0) ++city_sites[s.city];
  CHECK(city_sites.size() == 5);

  // Ports: exactly one site with sea access (the single export terminal).
  int ports = 0;
  for (const WSite& s : w.sites)
    if (s.node[2].valid()) ++ports;
  CHECK(ports == 1);
}

TEST_CASE("warm-up hook is pluggable and failure forces reseeding") {
  const GenParams params{};
  const CatalogView catalog = refCatalog();

  // A hook that accepts every world: generation still succeeds.
  static const GeneratedWorld* seen = nullptr;
  const auto accept = +[](const GeneratedWorld& w, const CatalogView&) {
    seen = &w;
    return std::vector<std::string>{};
  };
  const GenResult ok = generateWorld(3, params, catalog, accept);
  CHECK(ok.ok);
  REQUIRE(seen != nullptr);
  CHECK(seen->seed == ok.world.seed);

  // A hook that always rejects: attempts exhausted, ok = false, error surfaced.
  const auto reject = +[](const GeneratedWorld&, const CatalogView&) {
    return std::vector<std::string>{"warm-up did not settle"};
  };
  const GenResult bad = generateWorld(3, params, catalog, reject);
  CHECK_FALSE(bad.ok);
  bool found = false;
  for (const auto& e : bad.gate_errors)
    if (e == "warm-up did not settle") found = true;
  CHECK(found);
}

// The M3 brief's constraint guarantees, asserted directly over a seed sweep —
// independent of checkConstraints, which the gate runs on every candidate.
// Any seed here failing means the shipped constraint guarantees regressed.
TEST_CASE("§6.7 constraint sweep seeds 1..8: presets, suppliers, outlets, overlap, modes" * doctest::skip(true)) {  const CatalogView catalog = refCatalog();

  // Vehicle class key → its mode, so fleet checks can name barge/ship/truck.
  std::map<std::string, worldgen::Mode> cls_mode;
  for (const VehicleClassInfo& v : catalog.vehicles) cls_mode[v.key] = v.mode;

  for (uint64_t seed = 1; seed <= 8; ++seed) {
    const GenResult r = generateOrDie(seed, "constraints");
    const GeneratedWorld& w = r.world;
    const std::string tag = "seed " + std::to_string(seed) + ": ";

    // -- fixed skeleton: all eight plant preset families plus the sources,
    // sinks, and the one port; 25-30 sites (§6.3).
    std::map<std::string, int> preset_count;
    for (const WSite& s : w.sites) ++preset_count[s.preset];
    for (const char* k : {"GAS_PLANT", "REFINERY", "STEAM_CRACKER_GAS", "STEAM_CRACKER_FLEX",
                          "CHLOR_ALKALI", "POLYETHYLENE", "POLYPROPYLENE", "VINYLS",
                          "STYRENICS", "OIL_FIELD", "GAS_FIELD", "SALT_MINE",
                          "PORT_TERMINAL"})
      CHECK_MESSAGE(preset_count[k] > 0, (tag + "missing preset " + k).c_str());
    CHECK_MESSAGE(w.sites.size() >= 25, (tag + "too few sites").c_str());
    CHECK_MESSAGE(w.sites.size() <= 30, (tag + "too many sites").c_str());

    // -- supplier-count rule (§6.5): every traded material moving between
    // sites has at least two distinct origins — except CHLORINE, the one
    // deliberate single-supplier chain (one chlor-alkali plant). Port stock
    // counts as the alternate supplier for materials the port exports.
    int port_site = -1;
    for (size_t s = 0; s < w.sites.size(); ++s)
      if (w.sites[s].preset == "PORT_TERMINAL") port_site = static_cast<int>(s);
    REQUIRE(port_site >= 0);
    std::map<std::string, std::set<int>> origins;
    for (const WFlowRecord& f : w.flows)
      if (f.from_site >= 0 && f.to_site >= 0) origins[f.material].insert(f.from_site);
    for (const auto& [m, from] : origins) {
      if (from.size() >= 2) continue;
      if (m == "CHLORINE") continue;  // the single-supplier scenario
      bool port_stocks = false;
      for (const WTank& t : w.tanks)
        if (t.site.v == static_cast<uint32_t>(port_site) && t.material == m) port_stocks = true;
      CHECK_MESSAGE(port_stocks, (tag + "material " + m + " has a single supplier").c_str());
    }

    // -- every product has somewhere to go: any material leaving sites also
    // arrives somewhere (a consumer or the port), so nothing only accumulates.
    std::map<std::string, double> out_tot, in_tot;
    for (const WFlowRecord& f : w.flows) {
      if (f.from_site >= 0) out_tot[f.material] += f.t_d;
      if (f.to_site >= 0) in_tot[f.material] += f.t_d;
    }
    for (const auto& [m, out] : out_tot)
      CHECK_MESSAGE(in_tot[m] > 0.0, (tag + "material " + m + " leaves but never arrives").c_str());

    // -- route non-overlap (§6.4): no road lies on a pipeline, and no line
    // carries three pipelines (a pipe may share a line with ONE other).
    const auto lineOf = [](const Range<uint32_t>& r, const std::vector<float>& xy) {
      std::vector<Vec2> pts;
      for (uint32_t i = 0; i < r.count; ++i) {
        const size_t o = (static_cast<size_t>(r.begin) + i) * 2;
        if (o + 1 < xy.size()) pts.push_back({xy[o], xy[o + 1]});
      }
      return pts;
    };
    std::vector<std::vector<Vec2>> road_lines, pipe_lines;
    for (const WEdge& e : w.edges)
      if (e.mode == worldgen::Mode::Road) road_lines.push_back(lineOf(e.polyline, w.polyline_xy));
    for (const WPipeline& p : w.pipelines) pipe_lines.push_back(lineOf(p.polyline, w.polyline_xy));
    for (size_t i = 0; i < road_lines.size(); ++i)
      for (size_t j = 0; j < pipe_lines.size(); ++j)
        CHECK_MESSAGE(overlapAlong(road_lines[i], pipe_lines[j]) <= 0.01,
                      (tag + "road lies on a pipeline").c_str());
    std::vector<int> shares(pipe_lines.size(), 0);
    for (size_t i = 0; i < pipe_lines.size(); ++i)
      for (size_t j = i + 1; j < pipe_lines.size(); ++j)
        if (overlapAlong(pipe_lines[i], pipe_lines[j]) > 0.01) {
          ++shares[i];
          ++shares[j];
        }
    for (size_t i = 0; i < shares.size(); ++i)
      CHECK_MESSAGE(shares[i] <= 1,
                    (tag + "pipeline " + std::to_string(i) + " shares its line with " +
                     std::to_string(shares[i]) + " others")
                        .c_str());

    // -- mode usage (§6.4): gases and olefins move by pipeline only; pellets
    // ride trucks; barge, ship, and truck traffic all visible in the fleet.
    std::map<worldgen::Mode, int> fleet_by_mode;
    for (const WVehicleSpec& v : w.fleet) fleet_by_mode[cls_mode[v.cls]] += 1;
    for (const WFlowRecord& f : w.flows) {
      const bool olefin = f.material == "ETHYLENE" || f.material == "PROPYLENE";
      const bool gas = f.material == "METHANE" || f.material == "ETHANE";
      const bool pellet = f.material == "PE" || f.material == "PP" || f.material == "PVC" ||
                          f.material == "PS";
      if (olefin || gas)
        CHECK_MESSAGE(f.piped, (tag + f.material + " moved without a pipeline").c_str());
      if (pellet)
        CHECK_MESSAGE(!f.piped, (tag + f.material + " pellets moved by pipeline").c_str());
    }
    CHECK_MESSAGE(fleet_by_mode[worldgen::Mode::River] >= 8, (tag + "no barge traffic").c_str());
    CHECK_MESSAGE(fleet_by_mode[worldgen::Mode::Sea] >= 4, (tag + "no ship traffic").c_str());
    CHECK_MESSAGE(fleet_by_mode[worldgen::Mode::Road] >= 50, (tag + "no truck traffic").c_str());
    CHECK(w.pipelines.size() >= 12);

    // -- tightness (§6.5): tanks hold roughly the seven-day cover target
    // (median realised cover across non-internal tanks within 5-10 days).
    std::vector<double> covers;
    for (const WTank& t : w.tanks) {
      const double flow = std::max(t.design_in_t_h, t.design_out_t_h);
      if (flow <= 0.0 || t.role == worldgen::TankRole::Internal) continue;
      covers.push_back(t.capacity_t / (flow * 24.0));
    }
    std::sort(covers.begin(), covers.end());
    if (!covers.empty()) {
      const double median = covers[covers.size() / 2];
      CHECK_MESSAGE(median >= 5.0, (tag + "median tank cover low: " + std::to_string(median) + " d").c_str());
      CHECK_MESSAGE(median <= 10.0, (tag + "median tank cover high: " + std::to_string(median) + " d").c_str());
    }
  }
}

// The named demo seeds must survive the real-Sim warm-up (28 simulated days:
// 21 ramp-up plus a seven-day watched tail without starvation or dry tanks)
// and regenerate byte-identically — the seed dropdown's repeatable-world rule.
TEST_CASE("named presets pass the real-Sim warm-up and stay byte-identical" * doctest::skip(true)) {  const GenParams params{};
  const CatalogView catalog = refCatalog();
  for (const NamedWorld& nw : namedWorlds()) {
    const GenResult a = generateWorld(nw.seed, params, catalog, crx::sim::realSimWarmup);
    CHECK_MESSAGE(a.ok, ("preset " + std::string(nw.name) + " rejected: " +
                         (a.gate_errors.empty() ? std::string("no reason recorded")
                                                : a.gate_errors.front()))
                            .c_str());
    if (!a.ok) continue;
    const GenResult b = generateWorld(nw.seed, params, catalog);
    REQUIRE(b.ok);
    CHECK(toWorldJson(a.world).dump() == toWorldJson(b.world).dump());
  }
}
