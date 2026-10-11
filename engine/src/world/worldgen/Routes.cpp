#include "world/worldgen/Routes.h"

#include "world/worldgen/Geo.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace crx {
namespace worldgen {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();

Vec2 seaward(const Frame& frame, Vec2 p, double km) {
  Vec2 dir{0.0, 0.0};
  switch (frame.sea_edge) {
    case 0: dir = {0.0, 1.0}; break;
    case 1: dir = {0.0, -1.0}; break;
    case 2: dir = {1.0, 0.0}; break;
    default: dir = {-1.0, 0.0}; break;
  }
  return p + dir * km;
}
}  // namespace

int Routes::siteNode(int site, Mode mode) const {
  if (site < 0 || site >= static_cast<int>(site_nodes.size())) return -1;
  return site_nodes[static_cast<size_t>(site)][static_cast<size_t>(mode)];
}

double Routes::km(int a, int b, Mode mode) const {
  const auto& d = dist_km[static_cast<size_t>(mode)];
  if (a < 0 || b < 0 || a >= static_cast<int>(d.size()) || b >= static_cast<int>(d.size()))
    return kInf;
  return d[static_cast<size_t>(a)][static_cast<size_t>(b)];
}

double Routes::hours(int a, int b, Mode mode) const {
  const auto& d = dist_h[static_cast<size_t>(mode)];
  if (a < 0 || b < 0 || a >= static_cast<int>(d.size()) || b >= static_cast<int>(d.size()))
    return kInf;
  return d[static_cast<size_t>(a)][static_cast<size_t>(b)];
}

bool Routes::reachable(int a, int b, Mode mode) const { return km(a, b, mode) < kInf; }

namespace {

using Edge = Routes::Edge;

struct Builder {
  Routes* r;

  uint32_t addNode(Vec2 pos, int site) {
    r->nodes.push_back({pos, site});
    r->incident.emplace_back();
    return static_cast<uint32_t>(r->nodes.size() - 1);
  }

  void addEdge(uint32_t a, uint32_t b, Mode mode, double speed, std::vector<Vec2> polyline) {
    // Undirected graph: one edge record; incident lists carry both ends.
    const double length = polylineLength(polyline);
    r->edges.push_back(Edge{a, b, mode, length, speed, std::move(polyline)});
    const uint32_t id = static_cast<uint32_t>(r->edges.size() - 1);
    r->incident[a].push_back(id);
    r->incident[b].push_back(id);
  }
};

}  // namespace

Routes buildRoutes(const GenParams& params, Rng& rng, const Features& ft, const Frame& frame,
                   const std::vector<SiteSlot>& slots, double road_kmh, double river_kmh) {
  Routes routes;
  routes.site_nodes.assign(slots.size(), {-1, -1, -1});
  Builder b{&routes};

  // -- Road network: one node per site, spanning tree + k nearest links.
  for (size_t s = 0; s < slots.size(); ++s)
    routes.site_nodes[s][0] = static_cast<int>(b.addNode(slots[s].pos, static_cast<int>(s)));

  const size_t n = slots.size();
  if (n > 1) {
    // Prim's tree over the site positions.
    std::vector<bool> in_tree(n, false);
    std::vector<double> cost(n, kInf);
    std::vector<uint32_t> parent(n, UINT32_MAX);
    cost[0] = 0.0;
    for (size_t iter = 0; iter < n; ++iter) {
      size_t u = SIZE_MAX;
      for (size_t i = 0; i < n; ++i)
        if (!in_tree[i] && (u == SIZE_MAX || cost[i] < cost[u])) u = i;
      in_tree[u] = true;
      if (parent[u] != UINT32_MAX) {
        const int a = routes.site_nodes[u][0], bp = routes.site_nodes[parent[u]][0];
        b.addEdge(static_cast<uint32_t>(a), static_cast<uint32_t>(bp), Mode::Road, road_kmh,
                  wigglePolyline(slots[u].pos, slots[parent[u]].pos, rng.uniform(1.2, 1.4), rng));
      }
      for (size_t v = 0; v < n; ++v) {
        if (in_tree[v]) continue;
        const double d = distKM(slots[u].pos, slots[v].pos);
        if (d < cost[v]) {
          cost[v] = d;
          parent[v] = static_cast<uint32_t>(u);
        }
      }
    }
    // Nearest-neighbour links (k=3): redundancy so road closures can reroute.
    for (size_t i = 0; i < n; ++i) {
      std::array<std::pair<double, uint32_t>, 3> best = {
          {{kInf, UINT32_MAX}, {kInf, UINT32_MAX}, {kInf, UINT32_MAX}}};
      for (size_t j = 0; j < n; ++j) {
        if (i == j) continue;
        const double d = distKM(slots[i].pos, slots[j].pos);
        for (auto& cand : best) {
          if (d < cand.first) {
            cand = {d, static_cast<uint32_t>(j)};
            break;
          }
        }
      }
      for (const auto& [d, j] : best) {
        (void)d;
        if (j == UINT32_MAX) continue;
        const int a = routes.site_nodes[i][0], bp = routes.site_nodes[j][0];
        const bool linked = std::any_of(
            routes.incident[static_cast<size_t>(a)].begin(),
            routes.incident[static_cast<size_t>(a)].end(), [&](uint32_t eid) {
              const Edge& e = routes.edges[eid];
              return e.mode == Mode::Road &&
                     (e.a == static_cast<uint32_t>(bp) || e.b == static_cast<uint32_t>(bp));
            });
        if (!linked)
          b.addEdge(static_cast<uint32_t>(a), static_cast<uint32_t>(bp), Mode::Road, road_kmh,
                    wigglePolyline(slots[i].pos, slots[j].pos, rng.uniform(1.2, 1.4), rng));
      }
    }
  }

  // -- River network: the polyline chain + access links. Access reuses the
  // site's road node (site river node == road node when access exists).
  std::vector<uint32_t> river_nodes;
  river_nodes.reserve(ft.river.size());
  for (const Vec2 p : ft.river) river_nodes.push_back(b.addNode(p, -1));
  for (size_t i = 1; i < river_nodes.size(); ++i)
    b.addEdge(river_nodes[i - 1], river_nodes[i], Mode::River, river_kmh,
              {ft.river[i - 1], ft.river[i]});

  for (size_t s = 0; s < slots.size(); ++s) {
    const Vec2 pos = slots[s].pos;
    const double coast_d = frame.distToCoast(pos);
    if (coast_d < 3.0) {
      // Coastal sites reach the river along the shoreline to the mouth. The
      // access edge is added even for a site sitting on the mouth itself —
      // claiming access without an edge would isolate the site in the
      // river-mode graph and fail the reachability gate.
      const double along = distKM(pos, ft.river.back());
      if (along <= 90.0) {
        routes.site_nodes[s][1] = routes.site_nodes[s][0];
        b.addEdge(routes.site_nodes[s][0], river_nodes.back(), Mode::River, river_kmh,
                  straightPolyline(pos, ft.river.back()));
      }
    } else {
      // Inland sites within 15 km of the river connect to the nearest vertex.
      double best_d = 1e18;
      size_t best_v = SIZE_MAX;
      for (size_t v = 0; v < ft.river.size(); ++v) {
        const double d = distKM(pos, ft.river[v]);
        if (d < best_d) {
          best_d = d;
          best_v = v;
        }
      }
      if (best_v != SIZE_MAX && best_d <= 18.0) {
        routes.site_nodes[s][1] = routes.site_nodes[s][0];
        b.addEdge(routes.site_nodes[s][0], river_nodes[best_v], Mode::River, river_kmh,
                  straightPolyline(pos, ft.river[best_v]));
      }
    }
  }

  // -- Sea network: port berth, coastal plant berths, overseas leg. Refineries
  // and crackers sit 3–9 km inland so they get marine berths too (§6.3): sea
  // legs between plant berths and the port berth carry the liquid exports.
  const auto has_sea_berth = [](const std::string& preset) {
    return preset == "PORT_TERMINAL" || preset == "REFINERY" ||
           preset == "STEAM_CRACKER_GAS" || preset == "STEAM_CRACKER_FLEX";
  };
  const uint32_t overseas = b.addNode(frame.overseas, -1);
  routes.overseas_node = static_cast<int>(overseas);
  uint32_t port_berth = UINT32_MAX;
  std::vector<uint32_t> plant_berths;
  for (size_t s = 0; s < slots.size(); ++s) {
    if (!has_sea_berth(slots[s].preset)) continue;
    const Vec2 berth_pos = seaward(frame, slots[s].pos, 10.0);
    const uint32_t berth = b.addNode(berth_pos, static_cast<int>(s));
    routes.site_nodes[s][2] = static_cast<int>(berth);
    if (slots[s].preset == "PORT_TERMINAL") {
      b.addEdge(berth, overseas, Mode::Sea, params.ship_speed_kmh,
                straightPolyline(berth_pos, frame.overseas));
      port_berth = berth;
    } else {
      plant_berths.push_back(berth);
    }
  }
  for (const uint32_t berth : plant_berths) {
    if (port_berth == UINT32_MAX) break;
    b.addEdge(berth, port_berth, Mode::Sea, params.ship_speed_kmh,
              straightPolyline(routes.nodes[berth].pos, routes.nodes[port_berth].pos));
  }

  finalize(routes);
  return routes;
}

void finalize(Routes& routes) {
  const size_t n = routes.nodes.size();
  for (size_t m = 0; m < 4; ++m) {
    routes.dist_km[m].assign(n, std::vector<double>(n, kInf));
    routes.dist_h[m].assign(n, std::vector<double>(n, kInf));
  }
  for (const Edge& e : routes.edges) {
    const size_t m = static_cast<size_t>(e.mode);
    const double h = e.length_km / std::max(1.0, e.speed_kmh);
    for (const auto& [a, b] : {std::pair{e.a, e.b}, std::pair{e.b, e.a}}) {
      if (e.length_km < routes.dist_km[m][a][b]) {
        routes.dist_km[m][a][b] = e.length_km;
        routes.dist_h[m][a][b] = h;
      }
    }
  }
  for (size_t m = 0; m < 4; ++m)
    for (size_t i = 0; i < n; ++i) {
      routes.dist_km[m][i][i] = 0.0;
      routes.dist_h[m][i][i] = 0.0;
    }
  for (size_t m = 0; m < 4; ++m)
    for (size_t k = 0; k < n; ++k)
      for (size_t i = 0; i < n; ++i) {
        const double dik = routes.dist_km[m][i][k];
        if (dik == kInf) continue;
        for (size_t j = 0; j < n; ++j) {
          const double cand = dik + routes.dist_km[m][k][j];
          if (cand < routes.dist_km[m][i][j]) {
            routes.dist_km[m][i][j] = cand;
            routes.dist_h[m][i][j] = routes.dist_h[m][i][k] + routes.dist_h[m][k][j];
          }
        }
      }
}

}  // namespace worldgen
}  // namespace crx
