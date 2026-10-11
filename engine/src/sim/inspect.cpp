// Chain Reaction — read-only views of live state: implementation.
#include "sim/inspect.h"

#include "sim/routes.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

namespace crx {
namespace sim {

namespace {

using nlohmann::json;

constexpr uint32_t kNoEdge = UINT32_MAX;

json siteRef(const World& world, uint32_t site) {
  return {{"site", site}, {"key", world.sites[site].key}, {"name", world.sites[site].name}};
}

// The edge a vehicle will take between two consecutive route nodes: the open
// one if there is one, else any (a closed edge still shows the plan).
uint32_t planEdge(const World& world, const State& state, crx::Mode mode, uint32_t a, uint32_t b) {
  uint32_t any = kNoEdge;
  for (uint32_t e = 0; e < world.edges.size(); ++e) {
    const RouteEdge& edge = world.edges[e];
    if (edge.mode != mode) continue;
    if (!((edge.a == a && edge.b == b) || (edge.a == b && edge.b == a))) continue;
    if (state.edge_open[e]) return e;
    if (any == kNoEdge) any = e;
  }
  return any;
}

// The edge's drawn points in the direction of travel.
std::vector<std::pair<double, double>> edgePoints(const World& world, uint32_t e, bool reverse) {
  const Range<uint32_t> pts = world.edges[e].polyline;
  std::vector<std::pair<double, double>> out;
  out.reserve(pts.count);
  for (uint32_t i = pts.begin; i < rangeEnd(pts); ++i)
    out.emplace_back(world.polyline_xy[2 * i], world.polyline_xy[2 * i + 1]);
  if (reverse) std::reverse(out.begin(), out.end());
  return out;
}

}  // namespace

const char* vehicleStatusName(VehStatus status) {
  switch (status) {
    case VehStatus::Idle: return "idle";
    case VehStatus::ToPickup: return "to_pickup";
    case VehStatus::QueueLoad: return "queue_load";
    case VehStatus::Loading: return "loading";
    case VehStatus::ToDropoff: return "to_dropoff";
    case VehStatus::QueueUnload: return "queue_unload";
    case VehStatus::Unloading: return "unloading";
  }
  return "idle";
}

std::string vehicleJson(const World& world, const State& state, uint32_t index) {
  if (index >= state.vehicle.size() || index >= world.fleet.size()) return {};
  const VehicleState& vs = state.vehicle[index];
  const VehicleClass& vc = world.catalog.vehicle_classes[world.fleet[index].cls];
  const bool idle = vs.status == VehStatus::Idle;
  const bool travelling = vs.status == VehStatus::ToPickup || vs.status == VehStatus::ToDropoff;
  const bool has_order = !idle && vs.order < state.order.size();

  json cargo = nullptr;
  if (vs.cargo_t > 1e-9)
    cargo = {{"material", world.catalog.materials[vs.cargo_material].key}, {"tonnes", vs.cargo_t}};

  json order = nullptr;
  json leg_destination = nullptr;
  if (has_order) {
    const Order& o = state.order[vs.order];
    const uint32_t from = world.tanks[o.from].site.v, to = world.tanks[o.to].site.v;
    order = {{"id", vs.order},
             {"material", world.catalog.materials[o.material].key},
             {"tonnes", o.qty_t},
             {"from", siteRef(world, from)},
             {"to", siteRef(world, to)},
             {"createdTick", o.created_tick},
             {"etaTick", o.eta_tick},
             {"priceUsdT", o.price},
             {"freightUsd", o.freight_usd}};
    const bool inbound_to_pickup = vs.status == VehStatus::ToPickup ||
                                   vs.status == VehStatus::QueueLoad ||
                                   vs.status == VehStatus::Loading;
    leg_destination = siteRef(world, inbound_to_pickup ? from : to);
  }

  // Standing on a node (not part-way along an edge): the site it belongs to.
  json at_site = nullptr;
  if (vs.edge == kNoEdge && vs.at_node < world.nodes.size() && world.nodes[vs.at_node].site >= 0)
    at_site = world.nodes[vs.at_node].site;

  // Path from here to the end of the current leg, and the leg's full length.
  json path = json::array();
  double remaining_km = 0, trip_km = 0;
  if (travelling && !vs.route_nodes.empty()) {
    for (size_t i = 0; i + 1 < vs.route_nodes.size(); ++i) {
      const uint32_t e = planEdge(world, state, vc.mode, vs.route_nodes[i], vs.route_nodes[i + 1]);
      if (e != kNoEdge) trip_km += world.edges[e].length_km;
    }
    path.push_back({vs.x_km, vs.y_km});
    size_t next = vs.leg;
    if (vs.edge != kNoEdge && vs.leg < vs.route_nodes.size()) {
      // The rest of the edge under way, from the distance already covered.
      const RouteEdge& edge = world.edges[vs.edge];
      const bool reverse = edge.b == vs.route_nodes[vs.leg];
      const auto pts = edgePoints(world, vs.edge, reverse);
      double walked = 0;
      for (size_t i = 1; i < pts.size(); ++i) {
        walked += std::hypot(pts[i].first - pts[i - 1].first, pts[i].second - pts[i - 1].second);
        if (walked > vs.edge_pos_km + 1e-9) path.push_back({pts[i].first, pts[i].second});
      }
      remaining_km += std::max(0.0, edge.length_km - vs.edge_pos_km);
      next = vs.leg + 1;
    }
    for (size_t i = next; i + 1 < vs.route_nodes.size(); ++i) {
      const uint32_t a = vs.route_nodes[i], b = vs.route_nodes[i + 1];
      const uint32_t e = planEdge(world, state, vc.mode, a, b);
      if (e == kNoEdge) break;  // the plan no longer exists past here
      const auto pts = edgePoints(world, e, world.edges[e].b == a);
      for (size_t k = 1; k < pts.size(); ++k) path.push_back({pts[k].first, pts[k].second});
      remaining_km += world.edges[e].length_km;
    }
  }

  const json doc = {{"index", index},
                    {"cls", vc.key},
                    {"capacityT", vc.capacity_t},
                    {"status", vehicleStatusName(vs.status)},
                    {"cargo", cargo},
                    {"order", order},
                    {"at", {{"site", at_site}}},
                    {"legDestination", leg_destination},
                    {"position", {vs.x_km, vs.y_km}},
                    {"path", path},
                    {"remainingKm", remaining_km},
                    {"tripKm", trip_km}};
  return doc.dump();
}

}  // namespace sim
}  // namespace crx
