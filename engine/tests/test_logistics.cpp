// Chain Reaction — M2 logistics tests (§13 continues the T-numbering), over
// the hand-written six-site world with the FUEL_OIL truck lane.
//
//   T7 route graph — edge lengths are polyline arc lengths, cached paths
//                    agree with the graph, closures detour and isolate
//   T8 procurement & market — demand creates orders, deliveries refill
//                    buyers, prices and freight are booked
//   T9 dispatch & transport — orders bind vehicles, cycles complete, a
//                    closed span reroutes the lane at higher freight
//   T10 adaptation — lead times learn, caution rises on dry feed, the
//                    global switch freezes all of it
//   T11 route_break events — validation rejects unresolvable sites, valid
//                    breaks close/reopen spans and hold through overlaps
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN

#include <doctest/doctest.h>

#include "sim/sim.h"
#include "sim/sixsite.h"

#include <nlohmann/json.hpp>

#include <cmath>
#include <memory>
#include <string>

using namespace crx;
using namespace crx::sim;
using json = nlohmann::json;

namespace {

constexpr double kTol = 1e-9;

std::unique_ptr<Sim> makeSim(uint64_t seed = 42) {
  std::string error;
  auto sim = Sim::create(seed, error);
  REQUIRE_MESSAGE(sim != nullptr, "Sim::create failed: " << error);
  return sim;
}

std::unique_ptr<Sim> makeSimConfig(const char* config) {
  std::string error;
  auto sim = Sim::createFromConfig(config, error);
  REQUIRE_MESSAGE(sim != nullptr, "createFromConfig failed: " << error);
  return sim;
}

uint32_t siteAt(const World& w, const char* key) {
  for (uint32_t s = 0; s < w.sites.size(); ++s)
    if (w.sites[s].key == key) return s;
  return UINT32_MAX;
}

uint32_t tankAt(const World& w, uint32_t site, const char* material) {
  const int mid = w.catalog.findMaterial(material);
  REQUIRE(mid >= 0);
  for (uint32_t t = 0; t < w.tanks.size(); ++t)
    if (w.tanks[t].site.v == site && w.tanks[t].material == mid) return t;
  return UINT32_MAX;
}

// The road edge spanning two sites' road nodes, or UINT32_MAX.
uint32_t roadEdgeBetween(const World& w, uint32_t a_site, uint32_t b_site) {
  const uint32_t road = modeIndex(Mode::Road);
  const uint32_t na = w.sites[a_site].node[road], nb = w.sites[b_site].node[road];
  for (uint32_t e = 0; e < w.edges.size(); ++e) {
    const RouteEdge& edge = w.edges[e];
    if (modeIndex(edge.mode) != road) continue;
    if ((edge.a == na && edge.b == nb) || (edge.a == nb && edge.b == na)) return e;
  }
  return UINT32_MAX;
}

double totalFreight(const State& st) {
  double s = 0;
  for (const Ledger& l : st.ledger) s += l.freight;
  return s;
}

uint32_t deliveredOrders(const State& st) {
  uint32_t n = 0;
  for (const Order& o : st.order)
    if (o.status == OrdStatus::Delivered) ++n;
  return n;
}

}  // namespace

TEST_CASE("T7: route graph — arc lengths, cached paths, closure and isolation") {
  auto sim = makeSim();
  const World& w = sim->world();
  REQUIRE(w.edges.size() >= 6);

  // §6.4: every edge length_km is its polyline arc length.
  for (const RouteEdge& e : w.edges) {
    double arc = 0;
    for (uint32_t i = e.polyline.begin; i + 1 < e.polyline.begin + e.polyline.count; ++i) {
      const double dx = w.polyline_xy[2 * (i + 1)] - w.polyline_xy[2 * i];
      const double dy = w.polyline_xy[2 * (i + 1) + 1] - w.polyline_xy[2 * i + 1];
      arc += std::sqrt(dx * dx + dy * dy);
    }
    CHECK_MESSAGE(std::abs(arc - e.length_km) < 1e-6,
                  "edge length_km must equal the polyline arc length");
  }

  const uint32_t road = modeIndex(Mode::Road);
  const uint32_t cracker = siteAt(w, "STEAM_CRACKER");
  const uint32_t port = siteAt(w, "PORT_TERMINAL");
  REQUIRE(cracker != UINT32_MAX);
  REQUIRE(port != UINT32_MAX);
  const uint32_t crackerNode = w.sites[cracker].node[road];
  const uint32_t portNode = w.sites[port].node[road];
  const uint32_t direct = roadEdgeBetween(w, cracker, port);
  REQUIRE(direct != UINT32_MAX);

  State& st = sim->state();
  PathCache cache;
  refreshPaths(w, st, cache);
  const double directHours = travelHours(w, cache, Mode::Road, crackerNode, portNode);
  CHECK(std::isfinite(directHours));
  CHECK(travelKm(w, cache, Mode::Road, crackerNode, portNode) > 0.0);
  const std::vector<uint32_t> path = buildPath(w, cache, Mode::Road, crackerNode, portNode);
  REQUIRE(path.size() >= 2);
  CHECK(path.front() == crackerNode);
  CHECK(path.back() == portNode);

  // Closing the direct span forces a longer detour, still reachable.
  st.edge_open[direct] = 0;
  st.graph_version += 1;
  refreshPaths(w, st, cache);
  const double detourHours = travelHours(w, cache, Mode::Road, crackerNode, portNode);
  CHECK(std::isfinite(detourHours));
  CHECK(detourHours > directHours + 1e-9);
  const std::vector<uint32_t> detour = buildPath(w, cache, Mode::Road, crackerNode, portNode);
  REQUIRE(detour.size() >= 2);
  for (size_t i = 0; i + 1 < detour.size(); ++i) {
    const uint32_t leg = edgeBetween(w, Mode::Road, detour[i], detour[i + 1]);
    REQUIRE(leg != UINT32_MAX);
    CHECK_MESSAGE(st.edge_open[leg] != 0, "the detour path must use open edges only");
  }

  // Closing both port-adjacent spans isolates the port.
  const uint32_t poly = siteAt(w, "POLYETHYLENE");
  REQUIRE(poly != UINT32_MAX);
  const uint32_t polyPort = roadEdgeBetween(w, poly, port);
  REQUIRE(polyPort != UINT32_MAX);
  st.edge_open[polyPort] = 0;
  st.graph_version += 1;
  refreshPaths(w, st, cache);
  CHECK(std::isinf(travelHours(w, cache, Mode::Road, crackerNode, portNode)));
  CHECK(buildPath(w, cache, Mode::Road, crackerNode, portNode).empty());
}

TEST_CASE("T8: procurement & market — orders, deliveries, prices, freight") {
  auto sim = makeSim();
  const World& w = sim->world();
  const uint32_t port = siteAt(w, "PORT_TERMINAL");
  REQUIRE(port != UINT32_MAX);
  const uint32_t buyer = tankAt(w, port, "FUEL_OIL");
  REQUIRE(buyer != UINT32_MAX);

  sim->step(30 * 24 * 4);  // 30 days of 0.25 h ticks
  const State& st = sim->state();

  REQUIRE(st.order.size() > 0);
  CHECK(deliveredOrders(st) > 0);
  for (const Order& o : st.order) {
    CHECK(o.status != OrdStatus::Cancelled);
    CHECK(o.qty_t > 0.0);
    CHECK(o.price > 0.0);
  }
  // Deliveries refilled the buyer and freight was booked.
  CHECK(st.tank[buyer].level_t > 0.0);
  CHECK(totalFreight(st) > 0.0);
  // Price index positive per material; the traded material moved off its
  // start value through matching (§5.6).
  for (double p : st.price_index) CHECK(p > 0.0);
  // Steady state holds: perfect service over the month.
  std::vector<double> kpis;
  sim->computeKpis(kpis);
  CHECK(kpis[0] > 0.999);
  CHECK(kpis[5] == 0.0);
}

TEST_CASE("T9: dispatch & transport — assignment, cycles, reroute on closure") {
  auto base = makeSim();
  base->step(10 * 24 * 4);  // 10 days
  const State& sb = base->state();
  const uint32_t baseDelivered = deliveredOrders(sb);
  CHECK(baseDelivered > 0);
  // Every delivered order was bound to a vehicle and its cargo came back
  // to rest: idle trucks hold no cargo.
  for (const Order& o : sb.order)
    if (o.status == OrdStatus::Delivered) CHECK(o.vehicle != UINT32_MAX);
  for (const VehicleState& v : sb.vehicle)
    if (v.status == VehStatus::Idle) CHECK(v.cargo_t <= kTol);
  const double baseFreight = totalFreight(sb);

  // Close the direct span for the whole window: the lane reroutes through
  // the detour — deliveries continue at strictly higher freight.
  auto brk = makeSim();
  const World& wb = brk->world();
  const uint32_t direct = roadEdgeBetween(wb, siteAt(wb, "STEAM_CRACKER"),
                                          siteAt(wb, "PORT_TERMINAL"));
  REQUIRE(direct != UINT32_MAX);
  CHECK(brk->command(json{{"type", "route_break"},
                          {"site", "STEAM_CRACKER"},
                          {"site2", "PORT_TERMINAL"},
                          {"duration_h", 240}}
                         .dump())
            .find("\"ok\":true") != std::string::npos);
  brk->step(10 * 24 * 4);  // the 240 h break spans the window
  const State& st2 = brk->state();
  CHECK(deliveredOrders(st2) > 0);
  CHECK(totalFreight(st2) > baseFreight + 1e-9);
}

TEST_CASE("T10: adaptation — learning, caution, and the global switch") {
  const World& w = makeSim()->world();  // world is shared across sims
  const uint32_t port = siteAt(w, "PORT_TERMINAL");
  const uint32_t buyer = tankAt(w, port, "FUEL_OIL");
  REQUIRE(buyer != UINT32_MAX);
  const double initialLead = w.tanks[buyer].init_lead_time_h;
  CHECK(initialLead > 0);

  // Learning on: lead times move away from the world initial after a month
  // of observed deliveries.
  auto on = makeSim();
  on->step(30 * 24 * 4);  // 30 days
  CHECK(std::abs(on->state().tank[buyer].lead_time_h - initialLead) > 1e-6);
  CHECK(on->state().tank[buyer].caution >= 1.0);

  // Learning frozen: the same month leaves the parameters at their initials.
  auto off = makeSimConfig("{\"seed\":42,\"adaptation\":false}");
  off->step(30 * 24 * 4);  // 30 days
  CHECK(off->state().adaptation == false);
  CHECK(off->state().tank[buyer].lead_time_h == doctest::Approx(initialLead));

  // Caution: starving the port (both spans closed) runs its feed tank dry,
  // and every dry feed that stops a process bumps that tank's caution.
  auto starve = makeSim();
  REQUIRE(starve->command(json{{"type", "route_break"},
                               {"site", "STEAM_CRACKER"},
                               {"site2", "PORT_TERMINAL"},
                               {"duration_h", 25 * 24}}
                             .dump())
              .find("\"ok\":true") != std::string::npos);
  REQUIRE(starve->command(json{{"type", "route_break"},
                               {"site", "POLYETHYLENE"},
                               {"site2", "PORT_TERMINAL"},
                               {"duration_h", 25 * 24}}
                             .dump())
              .find("\"ok\":true") != std::string::npos);
  starve->step(25 * 24 * 4);  // 25 days starved
  CHECK(starve->state().tank[buyer].caution > 1.0);
  CHECK(starve->state().tank[buyer].caution <= 2.0);
}

TEST_CASE("T11: route_break events — validation, close/reopen, overlap hold") {
  auto sim = makeSim();
  const World& w = sim->world();
  const uint32_t direct =
      roadEdgeBetween(w, siteAt(w, "STEAM_CRACKER"), siteAt(w, "PORT_TERMINAL"));
  REQUIRE(direct != UINT32_MAX);

  // Unresolvable references are rejected with an error, not a crash (the
  // M2 regression: an unresolved site2 used to queue and dereference
  // sites[UINT32_MAX] on the apply tick).
  CHECK(sim->command(json{{"type", "route_break"}, {"site", "STEAM_CRACKER"},
                          {"site2", "NOT_A_SITE"}, {"duration_h", 48}}
                        .dump())
            .find("\"ok\":false") != std::string::npos);
  CHECK(sim->command(json{{"type", "route_break"}, {"site", "NOT_A_SITE"},
                          {"site2", "PORT_TERMINAL"}, {"duration_h", 48}}
                        .dump())
            .find("\"ok\":false") != std::string::npos);
  CHECK(sim->command(json{{"type", "route_break"}, {"site", "STEAM_CRACKER"}}
                        .dump())
            .find("\"ok\":false") != std::string::npos);
  CHECK(sim->state().edge_open[direct] == 1);

  // A valid break closes the span from the next tick and logs it.
  REQUIRE(sim->command(json{{"type", "route_break"}, {"site", "STEAM_CRACKER"},
                            {"site2", "PORT_TERMINAL"}, {"duration_h", 4}}
                          .dump())
              .find("\"ok\":true") != std::string::npos);
  sim->step(1);
  CHECK(sim->state().edge_open[direct] == 0);
  bool logged = false;
  for (const LogEntry& e : sim->recorder().log)
    if (e.type == "route_break") logged = true;
  CHECK(logged);

  // Overlapping breaks on the same span hold it closed until the last ends.
  sim->step(48);  // first break expired
  CHECK(sim->state().edge_open[direct] == 1);
}
