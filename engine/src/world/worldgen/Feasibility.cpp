#include "world/worldgen/Feasibility.h"

#include "world/worldgen/Geo.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <queue>

namespace crx {
namespace worldgen {

namespace {

}  // namespace

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
                       std::to_string(straight) + " km straight");
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

  return errors;
}

}  // namespace worldgen
}  // namespace crx
