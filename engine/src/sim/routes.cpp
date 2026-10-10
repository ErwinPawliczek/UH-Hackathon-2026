// Chain Reaction — route graph services implementation.
#include "sim/routes.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <queue>

namespace crx {
namespace sim {

namespace {

constexpr double kInfHours = std::numeric_limits<double>::infinity();
constexpr double kInfKm = kInfHours;  // same sentinel role, km units

// One mode's adjacency from the open edges, as (to, hours, km, edge_id).
struct Adj {
  uint32_t to;
  double hours;
  double km;
  uint32_t edge;
};

std::vector<std::vector<Adj>> adjacency(const World& world, const State& state, int mode) {
  std::vector<std::vector<Adj>> adj(world.nodes.size());
  for (uint32_t e = 0; e < world.edges.size(); ++e) {
    const RouteEdge& edge = world.edges[e];
    if (modeIndex(edge.mode) != mode || !state.edge_open[e]) continue;
    const double hours = edge.length_km / edge.speed_kmh;
    adj[edge.a].push_back({edge.b, hours, edge.length_km, e});
    adj[edge.b].push_back({edge.a, hours, edge.length_km, e});
  }
  return adj;
}

}  // namespace

void refreshPaths(const World& world, const State& state, PathCache& cache) {
  if (cache.version == state.graph_version && !cache.dist[0].empty()) return;
  cache.version = state.graph_version;
  const size_t n = world.nodes.size();
  for (int m = 0; m < kModeCount; ++m) {
    cache.dist[m].assign(n, std::vector<double>(n, kInfHours));
    cache.dist_km[m].assign(n, std::vector<double>(n, kInfKm));
    cache.next[m].assign(n, std::vector<uint32_t>(n, kNoNode));
    const std::vector<std::vector<Adj>> adj = adjacency(world, state, m);
    for (uint32_t s = 0; s < n; ++s) {
      // Dijkstra with node-id tie-breaking: the priority key is (hours, id).
      using Entry = std::pair<double, uint32_t>;
      std::priority_queue<Entry, std::vector<Entry>, std::greater<Entry>> pq;
      std::vector<double>& dist = cache.dist[m][s];
      std::vector<double>& dist_km = cache.dist_km[m][s];
      std::vector<uint32_t>& next = cache.next[m][s];
      dist[s] = 0;
      dist_km[s] = 0;
      next[s] = s;
      pq.push({0.0, s});
      while (!pq.empty()) {
        const auto [d, u] = pq.top();
        pq.pop();
        if (d > dist[u]) continue;  // stale entry
        for (const Adj& a : adj[u]) {
          if (d + a.hours >= dist[a.to] - 1e-12) continue;
          dist[a.to] = d + a.hours;
          dist_km[a.to] = dist_km[u] + a.km;
          next[a.to] = u;
          pq.push({dist[a.to], a.to});
        }
      }
    }
  }
}

double travelHours(const World& world, const PathCache& cache, crx::Mode mode, uint32_t from,
                   uint32_t to) {
  const int m = modeIndex(mode);
  if (m < 0 || m >= kModeCount || from >= world.nodes.size() || to >= world.nodes.size())
    return kInfHours;
  return cache.dist[m][from][to];
}

double travelKm(const World& world, const PathCache& cache, crx::Mode mode, uint32_t from,
                uint32_t to) {
  const int m = modeIndex(mode);
  if (m < 0 || m >= kModeCount || from >= world.nodes.size() || to >= world.nodes.size())
    return kInfKm;
  return cache.dist_km[m][from][to];
}

std::vector<uint32_t> buildPath(const World& world, const PathCache& cache, crx::Mode mode,
                                uint32_t from, uint32_t to) {
  const int m = modeIndex(mode);
  if (m < 0 || m >= kModeCount || from >= world.nodes.size() || to >= world.nodes.size())
    return {};
  if (cache.next[m][from][to] == kNoNode) return {};
  std::vector<uint32_t> path{to};
  uint32_t cur = to;
  while (cur != from) {
    cur = cache.next[m][from][cur];
    if (cur == kNoNode) return {};  // unreachable (cannot happen after the guard)
    path.push_back(cur);
  }
  std::reverse(path.begin(), path.end());
  return path;
}

uint32_t edgeBetween(const World& world, crx::Mode mode, uint32_t a, uint32_t b) {
  for (uint32_t e = 0; e < world.edges.size(); ++e) {
    const RouteEdge& edge = world.edges[e];
    if (edge.mode != mode) continue;
    if ((edge.a == a && edge.b == b) || (edge.a == b && edge.b == a)) return e;
  }
  return UINT32_MAX;
}

void edgePose(const World& world, uint32_t edge_id, double pos_km, bool reverse, double& x,
              double& y, double& dir_x, double& dir_y) {
  const RouteEdge& edge = world.edges[edge_id];
  const Range<uint32_t> pts = edge.polyline;
  // Walk the polyline accumulating arc length; a straight edge has two points.
  double remaining = std::max(0.0, std::min(pos_km, edge.length_km));
  double ax = world.polyline_xy[2 * pts.begin], ay = world.polyline_xy[2 * pts.begin + 1];
  double bx = ax, by = ay;
  for (uint32_t i = pts.begin + 1; i < rangeEnd(pts); ++i) {
    bx = world.polyline_xy[2 * i];
    by = world.polyline_xy[2 * i + 1];
    const double len = std::hypot(bx - ax, by - ay);
    if (remaining <= len || i == rangeEnd(pts) - 1) break;
    remaining -= len;
    ax = bx;
    ay = by;
  }
  const double len = std::hypot(bx - ax, by - ay);
  const double t = len > 0.0 ? remaining / len : 0.0;
  double dx = len > 0.0 ? (bx - ax) / len : 1.0;
  double dy = len > 0.0 ? (by - ay) / len : 0.0;
  if (reverse) {
    dx = -dx;
    dy = -dy;
  }
  x = ax + (bx - ax) * t;
  y = ay + (by - ay) * t;
  dir_x = dx;
  dir_y = dy;
}

}  // namespace sim
}  // namespace crx
