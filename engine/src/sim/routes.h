// Chain Reaction — §5.7 route graph services: shortest paths by time on a
// mode, cached all-pairs per mode and invalidated when an edge opens or
// closes (State::graph_version). The World supplies edges whose length_km is
// the polyline arc length (§6.4) and whose travel time is length ÷ the
// cheaper of the edge's and the vehicle class's speed.
#ifndef CRX_SIM_ROUTES_H
#define CRX_SIM_ROUTES_H

#include "sim/state.h"
#include "sim/world.h"

#include <vector>

namespace crx {
namespace sim {

// All-pairs shortest travel times per transport mode. Derived data: lives in
// Sim, not State (determinism rule — rebuilt from World + edge_open).
struct PathCache {
  // dist[mode][from][to] = hours, dist_km likewise in km (inf when
  // unreachable); next[mode][from][to] = the next node on the path (itself
  // when from == to, kNoNode when none). Hours drive routing; km prices
  // freight (§5.6).
  std::array<std::vector<std::vector<double>>, kModeCount> dist{};
  std::array<std::vector<std::vector<double>>, kModeCount> dist_km{};
  std::array<std::vector<std::vector<uint32_t>>, kModeCount> next{};
  uint64_t version = 0;  // State::graph_version the tables were built for
};

// Rebuilds the cache when its version is stale (edge open/close). Cheap at
// these world sizes; deterministic Dijkstra with node-id tie-breaking.
void refreshPaths(const World& world, const State& state, PathCache& cache);

// Travel hours from `from` to `to` on a mode (inf when unreachable).
double travelHours(const World& world, const PathCache& cache, crx::Mode mode, uint32_t from,
                   uint32_t to);

// Path distance in km (inf when unreachable) — prices freight (§5.6).
double travelKm(const World& world, const PathCache& cache, crx::Mode mode, uint32_t from,
                uint32_t to);

// Node sequence from→to (inclusive) on a mode; empty when unreachable.
std::vector<uint32_t> buildPath(const World& world, const PathCache& cache, crx::Mode mode,
                                uint32_t from, uint32_t to);

// The route-graph edge joining two nodes on a mode, or UINT32_MAX.
uint32_t edgeBetween(const World& world, crx::Mode mode, uint32_t a, uint32_t b);

// Pose along an edge at `pos_km` from its a-end (route render + movement).
void edgePose(const World& world, uint32_t edge, double pos_km, bool reverse, double& x, double& y,
              double& dir_x, double& dir_y);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_ROUTES_H
