#include "world/worldgen/Feasibility.h"

#include "world/worldgen/Geo.h"
#include "world/worldgen/Sizing.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <queue>
#include <set>

namespace crx {
namespace worldgen {

namespace {

std::vector<Vec2> polyPts(const GeneratedWorld& w, const Range<uint32_t>& r) {
  std::vector<Vec2> pts;
  pts.reserve(r.count);
  for (uint32_t i = 0; i < r.count; ++i) {
    const size_t o = (static_cast<size_t>(r.begin) + i) * 2;
    if (o + 1 >= w.polyline_xy.size()) break;
    pts.push_back({w.polyline_xy[o], w.polyline_xy[o + 1]});
  }
  return pts;
}

}  // namespace

// Structural guarantees for the default world (M3 brief §6.7): preset
// presence, the supplier-count rule, product outlets, route non-overlap,
// tank cover, mode usage. The gate enforces these on every candidate seed,
// and the doctest suites assert them directly over seed sweeps.
std::vector<std::string> checkConstraints(const GeneratedWorld& world,
                                          const CatalogView& catalog) {
  std::vector<std::string> errors;
  if (world.sites.size() < 25 || world.sites.size() > 30)
    errors.push_back("site count " + std::to_string(world.sites.size()) +
                     " outside the 25-30 brief");

  // -- preset presence: the fixed skeleton carries all eight plant preset
  // families (both cracker flavours), their sources, and their sinks.
  std::map<std::string, int> preset_count;
  for (const WSite& s : world.sites) ++preset_count[s.preset];
  for (const char* k : {"GAS_PLANT", "REFINERY", "STEAM_CRACKER_GAS", "STEAM_CRACKER_FLEX",
                        "CHLOR_ALKALI", "POLYETHYLENE", "POLYPROPYLENE", "VINYLS",
                        "STYRENICS"})
    if (preset_count[k] == 0) errors.push_back(std::string("missing plant preset ") + k);
  for (const char* k : {"OIL_FIELD", "GAS_FIELD", "SALT_MINE"})
    if (preset_count[k] == 0) errors.push_back(std::string("missing source ") + k);
  for (const char* k : {"PORT_TERMINAL", "GAS_GRID", "FUEL_DEPOT", "PACKAGING",
                        "CONSTRUCTION", "CONSUMER_GOODS", "PAINTS_COATINGS",
                        "PROCESS_INDUSTRIES"})
    if (preset_count[k] == 0) errors.push_back(std::string("missing sink ") + k);
  if (preset_count["PORT_TERMINAL"] != 1)
    errors.push_back("expected exactly one port, found " +
                     std::to_string(preset_count["PORT_TERMINAL"]));
  if (preset_count["CHLOR_ALKALI"] != 1)
    errors.push_back("expected exactly one chlor-alkali plant, found " +
                     std::to_string(preset_count["CHLOR_ALKALI"]));

  int port_site = -1;
  for (size_t s = 0; s < world.sites.size(); ++s)
    if (world.sites[s].preset == "PORT_TERMINAL") port_site = static_cast<int>(s);

  // -- suppliers: at least two sources for every traded material. A flow into
  // the port of an exportable material stocks the export tank, which counts
  // as the second supplier (the port sells from stock domestically). The one
  // deliberate exception: chlorine from the single chlor-alkali plant.
  std::map<std::string, std::set<int>> src;
  std::set<std::string> port_stocked;
  for (const WFlowRecord& f : world.flows) {
    if (f.t_d <= 1e-9) continue;
    if (f.from_site >= 0) src[f.material].insert(f.from_site);
    if (f.to_site >= 0 && f.to_site == port_site) port_stocked.insert(f.material);
  }
  int single_supplier = 0;
  for (const MaterialInfo& mi : catalog.materials) {
    if (mi.kind != MatKind::Traded) continue;
    const auto it = src.find(mi.key);
    const size_t n = (it == src.end() ? 0 : it->second.size()) +
                     (port_stocked.count(mi.key) ? 1 : 0);
    if (n == 0) continue;  // not produced in this world
    if (n < 2) {
      ++single_supplier;
      std::string names;
      if (it != src.end())
        for (const int s : it->second)
          names += (names.empty() ? "" : ", ") + world.sites[static_cast<size_t>(s)].name;
      if (port_stocked.count(mi.key)) names += (names.empty() ? "" : ", ") + std::string("port stock");
      if (mi.key != "CHLORINE")
        errors.push_back("material " + mi.key + " has " + std::to_string(n) +
                         " supplier(s) [" + names + "], need two");
    }
  }
  if (single_supplier != 1)
    errors.push_back("expected exactly one single-supplier material (chlorine), found " +
                     std::to_string(single_supplier));

  // -- outlets: every traded material made at a non-port site must flow
  // somewhere — the test-world bug was PE, propylene and benzene with no
  // destination, accumulating until the tank filled.
  std::map<std::string, int> consumed;
  std::map<std::string, int> made_at_sites;
  for (const WFlowRecord& f : world.flows) {
    if (f.t_d <= 1e-9) continue;
    ++consumed[f.material];  // every flow has a destination by construction
  }
  for (const WTank& t : world.tanks) {
    if (t.role != TankRole::Product && t.role != TankRole::Both) continue;
    if (t.site.v >= world.sites.size()) continue;
    if (static_cast<int>(t.site.v) == port_site) continue;
    if (t.design_out_t_h <= 1e-9) continue;
    const MaterialInfo* mi = catalog.material(t.material);
    if (mi == nullptr || mi->kind != MatKind::Traded) continue;
    ++made_at_sites[t.material];
  }
  for (const auto& [m, sites] : made_at_sites)
    if (consumed[m] == 0)
      errors.push_back("material " + m + " made at " + std::to_string(sites) +
                       " site(s) with no outlet");

  // -- route non-overlap: no road edge lies along a pipeline, and no pipeline
  // shares its line with two or more others (§6.4). Crossings are fine.
  std::vector<std::vector<Vec2>> road, pipe;
  for (const WEdge& e : world.edges)
    if (e.mode == Mode::Road) road.push_back(polyPts(world, e.polyline));
  for (const WPipeline& p : world.pipelines) pipe.push_back(polyPts(world, p.polyline));
  const double kOverlapM = 10.0;
  for (size_t i = 0; i < road.size(); ++i)
    for (size_t j = 0; j < pipe.size(); ++j)
      if (overlapAlong(road[i], pipe[j]) > kOverlapM)
        errors.push_back("road edge " + std::to_string(i) + " lies on pipeline " +
                         std::to_string(j));
  std::vector<int> shares(pipe.size(), 0);
  for (size_t i = 0; i < pipe.size(); ++i)
    for (size_t j = i + 1; j < pipe.size(); ++j)
      if (overlapAlong(pipe[i], pipe[j]) > kOverlapM) {
        ++shares[i];
        ++shares[j];
      }
  for (size_t i = 0; i < pipe.size(); ++i)
    if (shares[i] >= 2)
      errors.push_back("pipeline " + std::to_string(i) + " shares its line with " +
                       std::to_string(shares[i]) + " other pipelines");

  // -- tank cover: realised cover ≈ the preset's cover × the site's seeded
  // weight (±15%); keep a loose band so float storage never trips it.
  for (const WTank& t : world.tanks) {
    if (t.site.v >= world.sites.size()) continue;
    const WSite& s = world.sites[t.site.v];
    const PresetInfo* p = catalog.preset(s.preset);
    if (p == nullptr) continue;
    const double flow = std::max(t.design_in_t_h, t.design_out_t_h);
    if (flow <= 1e-9) continue;
    const double cover_d = t.capacity_t / flow / 24.0;
    const double target =
        t.role == TankRole::Internal ? p->cover_internal_d
        : p->cover_by_material.count(t.material)
            ? p->cover_by_material.at(t.material)
            : t.role == TankRole::Feed ? p->cover_feed_d : p->cover_product_d;
    if (target <= 0.0) continue;
    if (cover_d < target * 0.75 || cover_d > target * 1.3)
      errors.push_back("tank " + t.material + " at " + s.name + " covers " +
                       std::to_string(cover_d) + " d, target " + std::to_string(target) +
                       " d");
  }

  // -- mode usage (§6.4): gases and olefins only ever pipe; barge, ship and
  // road all move visible traffic; the fleet is big enough to see.
  for (const WFlowRecord& f : world.flows) {
    if (f.t_d <= 1e-9 || f.piped) continue;
    if (f.material == "ETHYLENE" || f.material == "PROPYLENE" ||
        f.material == "METHANE" || f.material == "RAW_GAS")
      errors.push_back("material " + f.material + " moved by vehicle; must pipe");
  }
  std::set<std::string> classes;
  for (const WVehicleSpec& v : world.fleet) classes.insert(v.cls);
  if (classes.count("BARGE_TANK") == 0) errors.push_back("no barge traffic");
  if (classes.count("SHIP_TANK") == 0) errors.push_back("no ship traffic");
  if (classes.count("TRUCK_TANK") == 0 && classes.count("TRUCK_PRESS") == 0 &&
      classes.count("TRUCK_BULK") == 0)
    errors.push_back("no road traffic");
  if (world.nVehicles() < 40)
    errors.push_back("fleet of " + std::to_string(world.nVehicles()) +
                     " vehicles is too small to show traffic");

  return errors;
}

std::vector<std::string> checkFeasibility(const GeneratedWorld& world,
                                          const CatalogView& catalog) {
  std::vector<std::string> errors;
  const size_t n_sites = world.sites.size();
  if (n_sites == 0) {
    errors.push_back("no sites generated");
    return errors;
  }

  // -- reachability: every site reaches every other in each available mode
  // (§12 T10). River/sea are only required between sites that have access.
  // The walk is node-level: sites connect through infrastructure nodes
  // (river vertices, berths) that belong to no site, so a site-level
  // adjacency built only from site-paired edges would see the river as
  // fragments even when the polyline chain is intact.
  for (const int mi : {0, 1, 2}) {
    const Mode mode = static_cast<Mode>(mi);
    std::map<uint32_t, std::vector<uint32_t>> node_adj;
    for (const WEdge& e : world.edges) {
      if (e.mode != mode) continue;
      node_adj[e.a.v].push_back(e.b.v);
      node_adj[e.b.v].push_back(e.a.v);
    }
    std::vector<std::pair<size_t, NodeId>> participants;
    for (size_t s = 0; s < n_sites; ++s)
      if (world.sites[s].node[mi].valid()) participants.emplace_back(s, world.sites[s].node[mi]);
    if (participants.size() < 2) continue;

    std::map<uint32_t, char> reached;
    std::queue<uint32_t> q;
    reached[participants[0].second.v] = 1;
    q.push(participants[0].second.v);
    while (!q.empty()) {
      const uint32_t a = q.front();
      q.pop();
      const auto it = node_adj.find(a);
      if (it == node_adj.end()) continue;
      for (const uint32_t b : it->second) {
        if (reached[b] != 0) continue;
        reached[b] = 1;
        q.push(b);
      }
    }
    for (const auto& [s, node] : participants) {
      if (reached[node.v] == 0) {
        errors.push_back("site " + world.sites[s].name + " unreachable by mode " +
                         std::to_string(mi));
      }
    }
  }

  // -- overseas leg ≈ params.sea_leg_days of ship time (§12 T10 spot check).
  if (world.overseas_node.valid()) {
    for (const WSite& s : world.sites) {
      const NodeId berth = s.node[2];
      if (!berth.valid()) continue;
      for (const WEdge& e : world.edges) {
        if (e.mode != Mode::Sea) continue;
        if (!(e.a == world.overseas_node || e.b == world.overseas_node)) continue;
        if (!(e.a == berth || e.b == berth)) continue;
        if (e.speed_kmh <= 0.f) {
          errors.push_back("overseas edge with zero speed at " + s.name);
          continue;
        }
        const double hours = static_cast<double>(e.length_km) / e.speed_kmh;
        const double target = world.params.sea_leg_days * 24.0;
        if (std::abs(hours - target) > 2.0) {
          errors.push_back("overseas leg " + std::to_string(hours) + " h ≠ " +
                           std::to_string(target) + " h at " + s.name);
        }
      }
    }
  }

  // -- arc lengths: every edge length is its polyline arc — at least the
  // straight gap, at most the 1.4 wiggle bound (float storage + rounding
  // slack of 0.5 km).
  for (const WEdge& e : world.edges) {
    if (e.a.v >= world.nodes.size() || e.b.v >= world.nodes.size()) {
      errors.push_back("edge endpoint out of range");
      continue;
    }
    const WNode& a = world.nodes[e.a.v];
    const WNode& b = world.nodes[e.b.v];
    const double straight = distKM({a.x_km, a.y_km}, {b.x_km, b.y_km});
    if (static_cast<double>(e.length_km) < straight - 0.5 ||
        static_cast<double>(e.length_km) > straight * 1.45 + 0.5) {
      errors.push_back("edge arc " + std::to_string(e.length_km) + " km out of band vs " +
                       std::to_string(straight) + " km straight (mode " +
                       std::to_string(static_cast<int>(e.mode)) + " nodes " +
                       std::to_string(e.a.v) + "->" + std::to_string(e.b.v) + ")");
    }
    if (e.speed_kmh <= 0.f) errors.push_back("edge with zero speed");
  }

  // -- utilisation: design rate ≤ nameplate × target utilisation (§6.5).
  for (const WProcess& p : world.processes) {
    const ProcessInfo* info = catalog.process(p.type);
    if (info == nullptr) {
      errors.push_back("process type not in catalog: " + p.type);
      continue;
    }
    if (info->nameplate_t_d <= 0.0) continue;  // boundary sinks/sources
    const double nameplate_t_h = info->nameplate_t_d / 24.0;
    if (p.design_rate_t_h > nameplate_t_h * world.params.target_utilisation + 1e-9) {
      errors.push_back("process " + p.type + " at rate " +
                       std::to_string(p.design_rate_t_h) + " t/h over utilisation target");
    }
  }

  const std::vector<std::string> constraint_errors = checkConstraints(world, catalog);
  errors.insert(errors.end(), constraint_errors.begin(), constraint_errors.end());
  return errors;
}

}  // namespace worldgen
}  // namespace crx
