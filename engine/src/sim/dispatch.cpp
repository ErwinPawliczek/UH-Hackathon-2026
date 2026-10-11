// Chain Reaction — §5.7 dispatch and transport implementation.

#include "sim/dispatch.h"

#include "sim/adaptation.h"
#include "sim/routes.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace crx {
namespace sim {
namespace {

std::string fmtQty(double v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.1f", v);
  return buf;
}

}  // namespace

namespace {

constexpr uint32_t kNoEdge = UINT32_MAX;

// The edge between two nodes in a mode, honoring closures; kNoEdge if none.
uint32_t openEdgeBetween(const World& world, const State& state, int mode, uint32_t a,
                         uint32_t b) {
  for (uint32_t i = 0; i < world.edges.size(); ++i) {
    const RouteEdge& e = world.edges[i];
    if (modeIndex(e.mode) != mode || !state.edge_open[i]) continue;
    if ((e.a == a && e.b == b) || (e.a == b && e.b == a)) return i;
  }
  return kNoEdge;
}

// One tick of movement for a vehicle under way: enter the next open edge
// (re-planning when the route was cut, §5.7), advance along it, and queue at
// the destination on arrival. Time left in the tick after reaching a node
// carries onto the next edge, so a route of many short edges takes the same
// time as one long edge of the same length.
void advanceTravel(const World& world, State& state, const PathCache& paths, uint32_t v,
                   const VehicleClass& vc) {
  VehicleState& vs = state.vehicle[v];
  const int m = modeIndex(vc.mode);
  auto arrive = [&]() {
    vs.status = vs.status == VehStatus::ToPickup ? VehStatus::QueueLoad
                                                 : VehStatus::QueueUnload;
    vs.queue_since_tick = state.tick;
  };

  double budget_h = kTickHours;
  for (;;) {
    if (vs.leg + 1 >= vs.route_nodes.size()) {
      // Already at the destination node — the common case of a home-based
      // pickup, where the path is a single node. Queue for the bays.
      arrive();
      return;
    }

    if (vs.edge == kNoEdge) {
      const uint32_t from = vs.route_nodes[vs.leg];
      const uint32_t to = vs.route_nodes[vs.leg + 1];
      const uint32_t e = openEdgeBetween(world, state, m, from, to);
      if (e == kNoEdge) {
        // Route cut: re-plan from the current node, or wait if none exists.
        const std::vector<uint32_t> replan =
            buildPath(world, paths, vc.mode, from, vs.route_nodes.back());
        if (replan.empty()) return;
        vs.route_nodes = replan;
        vs.leg = 0;
        return;  // start moving on the new route next tick
      }
      vs.edge = e;
      vs.edge_pos_km = 0;
    }

    // Advance along the current edge — committed: a closure mid-edge waits
    // for the next node (§5.7).
    const RouteEdge& edge = world.edges[vs.edge];
    const double speed = std::min(edge.speed_kmh, vc.speed_kmh);
    if (speed <= 0.0) return;
    const bool reverse = edge.b == vs.route_nodes[vs.leg];
    const double left_km = std::max(0.0, edge.length_km - vs.edge_pos_km);
    if (speed * budget_h < left_km - 1e-9) {
      vs.edge_pos_km += speed * budget_h;
      edgePose(world, vs.edge, vs.edge_pos_km, reverse, vs.x_km, vs.y_km, vs.dir_x, vs.dir_y);
      return;
    }

    // Reached the edge's far node with time to spare (or exactly on it).
    budget_h -= left_km / speed;
    edgePose(world, vs.edge, edge.length_km, reverse, vs.x_km, vs.y_km, vs.dir_x, vs.dir_y);
    vs.leg += 1;
    vs.at_node = vs.route_nodes[vs.leg];
    vs.edge = kNoEdge;
    vs.edge_pos_km = 0;
    vs.x_km = world.nodes[vs.at_node].x_km;
    vs.y_km = world.nodes[vs.at_node].y_km;
    if (vs.at_node == vs.route_nodes.back()) {
      arrive();
      return;
    }
    if (budget_h <= 1e-9) return;
  }
}

}  // namespace

void stepDispatch(const World& world, State& state, PathCache& paths, Recorder& rec,
                  double urgency_boost_h) {
  refreshPaths(world, state, paths);  // pick up edge toggles from events

  // Open orders in service order (deterministic; §5.7). Default: most
  // urgent first, ties to earlier creation, then lower order id. With an
  // urgency boost: first come first served, each order's place in the queue
  // moved up by urgency x boost hours — so urgency still jumps the queue,
  // but an old order cannot be overtaken forever.
  std::vector<uint32_t> open;
  for (uint32_t i = 0; i < state.order.size(); ++i)
    if (state.order[i].status == OrdStatus::Open) open.push_back(i);
  const bool fifo = urgency_boost_h >= 0.0;
  auto queueKey = [&](const Order& o) {
    return static_cast<double>(o.created_tick) - o.urgency * urgency_boost_h / kTickHours;
  };
  std::sort(open.begin(), open.end(), [&](uint32_t a, uint32_t b) {
    const Order& oa = state.order[a];
    const Order& ob = state.order[b];
    if (fifo) {
      const double ka = queueKey(oa), kb = queueKey(ob);
      if (ka != kb) return ka < kb;
    } else if (oa.urgency != ob.urgency) {
      return oa.urgency > ob.urgency;
    }
    if (oa.created_tick != ob.created_tick) return oa.created_tick < ob.created_tick;
    return a < b;
  });

  for (uint32_t oi : open) {
    Order& o = state.order[oi];
    const VehicleClass& vc = world.catalog.vehicle_classes[o.cls];
    const int m = modeIndex(vc.mode);
    const uint32_t pickup = m < kModeCount ? world.sites[world.tanks[o.from].site.v].node[m] : kNoNode;
    const uint32_t drop = m < kModeCount ? world.sites[world.tanks[o.to].site.v].node[m] : kNoNode;

    // An order nothing can carry — no vehicle of its class on a stretch of
    // network that reaches the pickup, or no way from pickup to drop — is
    // cancelled, releasing the seller's reservation and the buyer's inbound
    // so procurement can place the lot again by another class or seller.
    // (Before: it stayed Open forever and the buyer never re-ordered.)
    bool carriable = pickup != kNoNode && drop != kNoNode &&
                     std::isfinite(travelHours(world, paths, vc.mode, pickup, drop));
    if (carriable) {
      carriable = false;
      for (uint32_t v = 0; v < state.vehicle.size() && !carriable; ++v)
        carriable = world.fleet[v].cls == o.cls &&
                    std::isfinite(travelHours(world, paths, vc.mode, state.vehicle[v].at_node, pickup));
    }
    if (!carriable) {
      o.status = OrdStatus::Cancelled;
      TankState& seller = state.tank[o.from];
      TankState& buyer = state.tank[o.to];
      seller.reserved_out_t = std::max(0.0, seller.reserved_out_t - o.qty_t);
      buyer.inbound_t = std::max(0.0, buyer.inbound_t - o.qty_t);
      logEvent(rec, state.tick, "order_cancelled", world.tanks[o.to].key, vc.key,
               "order " + std::to_string(oi) + " (" + world.catalog.materials[o.material].key +
                   " " + fmtQty(o.qty_t) + " t): no " + vc.key + " can carry it");
      continue;
    }

    // The idle vehicle of the right class that reaches the pickup soonest
    // (§5.7). Ties break to the lower vehicle id (strict improvement only).
    int best = -1;
    double best_eta = 0;
    for (uint32_t v = 0; v < state.vehicle.size(); ++v) {
      if (world.fleet[v].cls != o.cls) continue;
      const VehicleState& vs = state.vehicle[v];
      if (vs.status != VehStatus::Idle) continue;
      const double eta = travelHours(world, paths, vc.mode, vs.at_node, pickup);
      if (!std::isfinite(eta)) continue;
      if (best < 0 || eta < best_eta - 1e-12) {
        best = static_cast<int>(v);
        best_eta = eta;
      }
    }
    if (best < 0) continue;  // no idle vehicle: the order waits (§5.7)

    const std::vector<uint32_t> path =
        buildPath(world, paths, vc.mode, state.vehicle[best].at_node, pickup);
    if (path.empty()) continue;  // route cut between match and dispatch

    o.status = OrdStatus::Assigned;
    o.vehicle = static_cast<uint32_t>(best);
    VehicleState& vs = state.vehicle[best];
    vs.status = VehStatus::ToPickup;
    vs.order = oi;
    vs.route_nodes = path;
    vs.leg = 0;
    vs.edge = kNoEdge;
    vs.edge_pos_km = 0;
    logEvent(rec, state.tick, "dispatch", world.sites[world.fleet[best].home.v].key, vc.key,
             "vehicle " + std::to_string(best) + " → order " + std::to_string(oi) + " (" +
                 world.catalog.materials[o.material].key + " " + fmtQty(o.qty_t) + " t)");
  }
}

void stepTransport(const World& world, State& state, PathCache& paths, Recorder& rec) {
  refreshPaths(world, state, paths);

  // --- Bay allocation: first come, first served per site and mode (§5.7).
  // Vehicles already loading/unloading hold their bays; free bays go to the
  // oldest queued vehicles (ties: lower vehicle id).
  std::vector<uint32_t> queued;
  for (uint32_t v = 0; v < state.vehicle.size(); ++v) {
    const VehicleState& vs = state.vehicle[v];
    if (vs.status == VehStatus::QueueLoad || vs.status == VehStatus::QueueUnload)
      queued.push_back(v);
  }
  std::sort(queued.begin(), queued.end(), [&](uint32_t a, uint32_t b) {
    const VehicleState& va = state.vehicle[a];
    const VehicleState& vb = state.vehicle[b];
    if (va.queue_since_tick != vb.queue_since_tick)
      return va.queue_since_tick < vb.queue_since_tick;
    return a < b;
  });
  for (uint32_t v : queued) {
    VehicleState& vs = state.vehicle[v];
    const int site = world.nodes[vs.at_node].site;
    if (site < 0) continue;  // infrastructure node: no bays
    const auto& vc = world.catalog.vehicle_classes[world.fleet[v].cls];
    const int m = modeIndex(vc.mode);
    unsigned busy = 0;
    for (uint32_t w = 0; w < state.vehicle.size(); ++w) {
      const VehicleState& other = state.vehicle[w];
      if (other.status != VehStatus::Loading && other.status != VehStatus::Unloading) continue;
      const auto& oc = world.catalog.vehicle_classes[world.fleet[w].cls];
      if (oc.mode != vc.mode) continue;
      if (world.nodes[other.at_node].site == site) busy += 1;
    }
    if (busy >= world.sites[static_cast<size_t>(site)].bays[m]) continue;  // all bays taken
    vs.status = vs.status == VehStatus::QueueLoad ? VehStatus::Loading : VehStatus::Unloading;
  }

  // --- Movement along the planned routes (one edge-segment per tick).
  for (uint32_t v = 0; v < state.vehicle.size(); ++v) {
    VehicleState& vs = state.vehicle[v];
    if (vs.status != VehStatus::ToPickup && vs.status != VehStatus::ToDropoff) continue;
    advanceTravel(world, state, paths, v, world.catalog.vehicle_classes[world.fleet[v].cls]);
  }

  // --- Loading from the seller tank's reserved stock (§5.7).
  for (uint32_t v = 0; v < state.vehicle.size(); ++v) {
    VehicleState& vs = state.vehicle[v];
    if (vs.status != VehStatus::Loading) continue;
    Order& o = state.order[vs.order];
    const auto& vc = world.catalog.vehicle_classes[world.fleet[v].cls];
    TankState& seller = state.tank[o.from];
    const double room = vc.capacity_t - vs.cargo_t;
    const double moved = std::min({vc.load_t_h * kTickHours, room, o.qty_t - vs.moved_t});
    seller.level_t -= moved;
    seller.reserved_out_t -= moved;
    vs.cargo_t += moved;
    vs.moved_t += moved;
    vs.cargo_material = o.material;

    if (vs.moved_t >= o.qty_t - 1e-9) {
      vs.moved_t = 0;
      const uint32_t drop = world.sites[world.tanks[o.to].site.v].node[modeIndex(vc.mode)];
      const std::vector<uint32_t> path = buildPath(world, paths, vc.mode, vs.at_node, drop);
      if (path.empty()) {
        vs.status = VehStatus::QueueLoad;  // route cut: re-queue and retry
        continue;
      }
      vs.status = VehStatus::ToDropoff;
      vs.route_nodes = path;
      vs.leg = 0;
      vs.edge = kNoEdge;
      onPickup(world, state, o.from, state.tick);
    }
  }

  // --- Unloading into the buyer tank, room-limited (§5.7).
  for (uint32_t v = 0; v < state.vehicle.size(); ++v) {
    VehicleState& vs = state.vehicle[v];
    if (vs.status != VehStatus::Unloading) continue;
    Order& o = state.order[vs.order];
    const auto& vc = world.catalog.vehicle_classes[world.fleet[v].cls];
    TankState& buyer = state.tank[o.to];
    const double room = std::max(0.0, world.tanks[o.to].capacity_t - buyer.level_t);
    const double moved = std::min({vc.load_t_h * kTickHours, vs.cargo_t, room});
    buyer.level_t += moved;
    vs.cargo_t -= moved;

    if (vs.cargo_t <= 1e-9) {
      // Completing the unload closes the order, books the trade, and feeds
      // the buyer's lead-time estimate (§5.7–5.8).
      buyer.inbound_t -= o.qty_t;
      o.status = OrdStatus::Delivered;
      o.delivered_tick = state.tick;
      Ledger& seller_led = state.ledger[world.tanks[o.from].site.v];
      Ledger& buyer_led = state.ledger[world.tanks[o.to].site.v];
      seller_led.revenue += o.qty_t * o.price;
      seller_led.freight += o.freight_usd;
      buyer_led.feed_cost += o.qty_t * o.price;
      state.cum_freight_usd += o.freight_usd;
      const double lead_h = static_cast<double>(state.tick - o.created_tick) * kTickHours;
      onDelivery(world, state, o.to, lead_h);

      vs.status = VehStatus::Idle;
      vs.route_nodes.clear();
      vs.leg = 0;
      vs.edge = kNoEdge;
      vs.cargo_t = 0;
      logEvent(rec, state.tick, "delivered", world.tanks[o.to].key,
               world.catalog.materials[o.material].key,
               fmtQty(o.qty_t) + " t in " + fmtQty(lead_h) + " h");
    }
  }
}

}  // namespace sim
}  // namespace crx
