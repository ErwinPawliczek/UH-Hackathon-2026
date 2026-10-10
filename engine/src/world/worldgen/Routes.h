// Route graph (§6.4). Roads: spanning tree + nearest-neighbour links, wiggled
// at a 1.2–1.4 detour factor. River: the polyline itself, access canals to
// river-adjacent or coastal sites. Sea: port↔port and port↔OVERSEAS arcs.
// Every edge length is the polyline arc length — never the Euclidean gap.
#ifndef CRX_WORLDGEN_ROUTES_H
#define CRX_WORLDGEN_ROUTES_H

#include "world/worldgen/Geo.h"
#include "world/worldgen/Layout.h"
#include "world/worldgen/WorldGenTypes.h"

#include <array>
#include <cstdint>
#include <vector>

namespace crx {
namespace worldgen {

struct Routes {
  struct NodeRef {
    Vec2 pos;
    int site = -1;  // SiteSlot index, or -1 for infrastructure nodes
  };

  struct Edge {
    uint32_t a = 0, b = 0;
    Mode mode = Mode::Road;
    double length_km = 0.0, speed_kmh = 0.0;
    std::vector<Vec2> polyline;
  };

  std::vector<NodeRef> nodes;
  std::vector<Edge> edges;
  std::vector<std::vector<uint32_t>> incident;  // edge ids per node
  std::vector<std::array<int, 3>> site_nodes;   // per site: {road, river, sea}, -1 = none
  int overseas_node = -1;                       // the OVERSEAS node in the sea subgraph

  int siteNode(int site, Mode mode) const;  // node a site uses in this mode

  // All-pairs shortest paths per mode, filled by finalize():
  // dist[mode][a][b] = km (inf when unreachable); hours likewise on edge times.
  std::array<std::vector<std::vector<double>>, 4> dist_km{};
  std::array<std::vector<std::vector<double>>, 4> dist_h{};

  double km(int a, int b, Mode mode) const;
  double hours(int a, int b, Mode mode) const;
  bool reachable(int a, int b, Mode mode) const;
};

// road_kmh / river_kmh come from the catalog's vehicle classes (§3.4).
Routes buildRoutes(const GenParams& params, Rng& rng, const Features& features,
                   const Frame& frame, const std::vector<SiteSlot>& slots, double road_kmh,
                   double river_kmh);

void finalize(Routes& routes);  // all-pairs distances per mode

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_ROUTES_H
