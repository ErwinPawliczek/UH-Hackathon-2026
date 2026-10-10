// doctest suite for the layout generator (§6): recipe closure in the local
// reference table, byte-identical determinism, the §12 T10 gate over 20
// seeds (reachability + travel-time spot checks), and reference-world scale.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "world/worldgen/CatalogView.h"
#include "world/worldgen/Feasibility.h"
#include "world/worldgen/Geo.h"
#include "world/worldgen/WorldGen.h"
#include "world/worldgen/WorldJson.h"

#include <cmath>
#include <map>
#include <queue>
#include <string>
#include <vector>

using namespace crx;
using namespace crx::worldgen;

namespace {

// Generate with a hard failure message when the gate rejects all attempts.
GenResult generateOrDie(uint64_t seed, const char* info) {
  GenParams params{};
  GenResult r = generateWorld(seed, params, referenceCatalog());
  if (!r.ok) {
    std::string msg = "gate rejected seed " + std::to_string(seed) + " (" + info + "):\n";
    for (const auto& e : r.gate_errors) msg += "  - " + e + "\n";
    FAIL(msg.c_str());
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
  const CatalogView c = referenceCatalog();
  for (const ProcessInfo& p : c.processes) {
    // Boundary pseudo-processes (SINK_* demand, *_SUPPLY sources) are
    // flow-through accounting nodes, not mass-balanced converters — the
    // unit-balance rule (§3) applies to conversion processes only.
    if (p.key.rfind("SINK_", 0) == 0 || p.key.size() >= 7 && p.key.compare(p.key.size() - 7, 7, "_SUPPLY") == 0)
      continue;
    REQUIRE(p.modes.size() == p.by_mode.size());
    for (size_t m = 0; m < p.modes.size(); ++m) {
      double in = 0.0, out = 0.0;
      for (const NetStream& s : p.by_mode[m].in) in += s.t_per_t;
      for (const NetStream& s : p.by_mode[m].out) out += s.t_per_t;
      CHECK_MESSAGE(std::abs(in - out) <= 1e-6,
                    ("recipe does not close: " + p.key + " / " + p.modes[m]).c_str());
    }
  }
}

TEST_CASE("same seed generates byte-identical world JSON (determinism rule)") {
  const GenParams params{};
  const CatalogView catalog = referenceCatalog();
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
  const CatalogView catalog = referenceCatalog();
  const GenResult a = generateWorld(1, params, catalog);
  const GenResult b = generateWorld(2, params, catalog);
  REQUIRE(a.ok);
  REQUIRE(b.ok);
  CHECK(toWorldJson(a.world).dump() != toWorldJson(b.world).dump());
}

TEST_CASE("§12 T10: seeds 1..20 — gate, reachability in every available mode") {
  for (uint64_t seed = 1; seed <= 20; ++seed) {
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
      if (e.mode != Mode::Sea) continue;
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
  CHECK(legs >= 2);

  // Barge pace: river edges travel at the slowest river class speed.
  double river_ref = 0.0;
  for (const VehicleClassInfo& v : referenceCatalog().vehicles)
    if (v.mode == Mode::River)
      river_ref = river_ref == 0.0 ? v.speed_kmh : std::min(river_ref, v.speed_kmh);
  REQUIRE(river_ref > 0.0);
  for (const WEdge& e : w.edges) {
    if (e.mode != Mode::River) continue;
    CHECK(e.speed_kmh == doctest::Approx(river_ref).epsilon(0.01));
  }

  // Road arcs are consistent with truck pace: hours = length / road speed,
  // so a 300 km driving day is length/300 days — verify the arithmetic
  // inputs hold on every road edge (speed positive, length positive).
  for (const WEdge& e : w.edges) {
    if (e.mode != Mode::Road) continue;
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

  // Eight cities anchored: the city-sink sites carry city indices 0..7.
  std::map<int, int> city_sites;
  for (const WSite& s : w.sites)
    if (s.city >= 0) ++city_sites[s.city];
  CHECK(city_sites.size() == 8);

  // Ports: exactly two sites with sea access.
  int ports = 0;
  for (const WSite& s : w.sites)
    if (s.node[2].valid()) ++ports;
  CHECK(ports == 2);
}

TEST_CASE("warm-up hook is pluggable and failure forces reseeding") {
  const GenParams params{};
  const CatalogView catalog = referenceCatalog();

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
