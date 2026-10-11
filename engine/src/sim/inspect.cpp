// Chain Reaction — read-only views of live state: implementation.
#include "sim/inspect.h"

#include "sim/procurement.h"
#include "sim/routes.h"
#include "sim/signals.h"
#include "sim/sim.h"
#include "sim/words.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
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

namespace {

const char* modeLabel(crx::Mode mode) {
  return mode == crx::Mode::Road ? "road" : mode == crx::Mode::River ? "river" : "sea";
}

bool anyEdgeClosed(const State& state) {
  for (const uint8_t open : state.edge_open)
    if (!open) return true;
  return false;
}

bool buysByVehicle(const Tank& tk) {
  return !tk.piped_in && tk.design_out_t_h > 0.0 &&
         (tk.role == TankRole::Feed || tk.role == TankRole::Both);
}

bool sells(const Tank& tk) { return tk.role == TankRole::Product || tk.role == TankRole::Both; }

// Hours a vehicle of this class takes between two nodes: the routed path at
// the slower of each edge's speed and the class's own (how transport moves
// it). Infinity when there is no way.
double classTravelHours(const World& world, const State& state, const PathCache& paths,
                        const VehicleClass& vc, uint32_t from, uint32_t to) {
  if (from == to) return 0.0;
  const std::vector<uint32_t> path = buildPath(world, paths, vc.mode, from, to);
  if (path.empty()) return std::numeric_limits<double>::infinity();
  double hours = 0;
  for (size_t i = 0; i + 1 < path.size(); ++i) {
    const uint32_t e = planEdge(world, state, vc.mode, path[i], path[i + 1]);
    if (e == kNoEdge) return std::numeric_limits<double>::infinity();
    const double speed = std::min(world.edges[e].speed_kmh, vc.speed_kmh);
    if (speed <= 0) return std::numeric_limits<double>::infinity();
    hours += world.edges[e].length_km / speed;
  }
  return hours;
}

// What the plant behind a selling tank is doing: the best state among the
// processes on its site that fill it.
const char* sellerState(const World& world, const State& state, uint32_t tank) {
  const Tank& tk = world.tanks[tank];
  int best = -1;  // 3 running, 2 held, 1 restarting, 0 shut down
  const Range<ProcessId> procs = world.sites[tk.site.v].processes;
  for (uint32_t p = procs.begin; p < rangeEnd(procs); ++p) {
    const Process& proc = world.processes[p];
    const ProcessType& type = world.catalog.process_types[proc.type];
    bool fills = false;
    for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size() && !fills; ++m) {
      if (proc.mode_share[m] <= 0) continue;
      for (const Stream& s : type.net[m])
        if (s.slot < kInternalStreamBase && s.t_per_t > 0 && s.slot < proc.tank_of.size() &&
            proc.tank_of[s.slot].valid() && proc.tank_of[s.slot].v == tank)
          fills = true;
    }
    if (!fills) continue;
    const ProcStatus st = state.proc[p].status;
    const int rank = st == ProcStatus::Running ? 3 : st == ProcStatus::HoldMin ? 2
                     : st == ProcStatus::Restarting ? 1 : 0;
    best = std::max(best, rank);
  }
  return best == 3 ? "running" : best == 2 ? "held" : best == 1 ? "restarting"
         : best == 0 ? "shut_down" : "no_producer";
}

// The worst state among all of a site's processes: what the map shows for
// the site. A site can be red while the plant behind one of its tanks still
// runs (the refinery's crude unit down, diesel still made from stock).
const char* siteState(const World& world, const State& state, uint32_t site) {
  int worst = 3;  // 3 running, 2 held, 1 restarting, 0 shut down
  bool any = false;
  const Range<ProcessId> procs = world.sites[site].processes;
  for (uint32_t p = procs.begin; p < rangeEnd(procs); ++p) {
    const ProcStatus st = state.proc[p].status;
    const int rank = st == ProcStatus::Running ? 3 : st == ProcStatus::HoldMin ? 2
                     : st == ProcStatus::Restarting ? 1 : 0;
    worst = std::min(worst, rank);
    any = true;
  }
  if (!any) return "no_producer";
  return worst == 3 ? "running" : worst == 2 ? "held" : worst == 1 ? "restarting" : "shut_down";
}

struct Usual {
  int seller_tank = -1;
  double delivered_t = 0;
};

// The seller that has delivered the most tonnes to this tank so far.
Usual usualSeller(const World& world, const State& state, uint32_t tank) {
  std::vector<double> by_seller(world.tanks.size(), 0.0);
  for (const Order& o : state.order)
    if (o.to == tank && o.status == OrdStatus::Delivered) by_seller[o.from] += o.qty_t;
  Usual u;
  for (size_t s = 0; s < by_seller.size(); ++s)
    if (by_seller[s] > u.delivered_t) u = {static_cast<int>(s), by_seller[s]};
  return u;
}

// The paths as they are for the current open edges (a fresh run has not
// built them yet).
PathCache currentPaths(const Sim& sim) {
  PathCache cache = sim.paths();
  refreshPaths(sim.world(), sim.state(), cache);
  return cache;
}

int resolveSiteArg(const World& world, const std::string& site) {
  if (!site.empty() && site.find_first_not_of("0123456789") == std::string::npos) {
    const unsigned long idx = std::stoul(site.substr(0, 9));
    return idx < world.sites.size() ? static_cast<int>(idx) : -1;
  }
  return world.findSite(site);
}

// Every possible way of supplying `tank`, fully priced.
struct Option {
  uint32_t seller_tank = 0;
  size_t cls = 0;
  Quote q;
};

// `open_paths` (the network with every edge open) is given when some edge is
// closed: a way of supplying the tank that only a closure has taken away
// stays in the list, blocked as a closed route.
std::vector<Option> optionsFor(const World& world, const State& state, const PathCache& paths,
                               const MarketParams& params,
                               const std::vector<std::vector<uint32_t>>& class_nodes,
                               uint32_t tank, double want, double urgency,
                               const PathCache* open_paths) {
  int contract_seller = -1;
  for (const World::Contract& c : world.contracts)
    if (c.buyer.v == tank) contract_seller = c.seller.v;
  std::vector<Option> out;
  const Tank& buyer = world.tanks[tank];
  for (uint32_t s = 0; s < world.tanks.size(); ++s) {
    const Tank& seller = world.tanks[s];
    if (seller.site == buyer.site || seller.material != buyer.material || !sells(seller)) continue;
    for (size_t cls = 0; cls < world.catalog.vehicle_classes.size(); ++cls) {
      Quote q = quoteLot(world, state, paths, params, class_nodes, tank, s, cls, want, urgency,
                         contract_seller, true);
      if (!q.possible && open_paths != nullptr)
        q = routeClosedQuote(world, state, *open_paths, params, class_nodes, tank, s, cls, want,
                             urgency, contract_seller);
      if (q.possible) out.push_back({s, cls, q});
    }
  }
  return out;
}

// Short numbers keep the document small: tonnes and dollars to the cent,
// ratios to four places.
double round2(double v) { return std::round(v * 100.0) / 100.0; }
double round4(double v) { return std::round(v * 10000.0) / 10000.0; }

json rounded(const std::vector<double>& values, double (*fn)(double)) {
  json out = json::array();
  for (const double v : values) out.push_back(fn(v));
  return out;
}

}  // namespace

std::string buyTanksJson(const Sim& sim) {
  const World& world = sim.world();
  const State& state = sim.state();
  const PathCache paths = currentPaths(sim);
  const bool closures = anyEdgeClosed(state);
  const PathCache open_paths = closures ? allOpenPaths(world) : PathCache{};
  const std::vector<std::vector<uint32_t>> class_nodes = classNodes(world, state);
  json tanks = json::array();
  for (uint32_t t = 0; t < world.tanks.size(); ++t) {
    const Tank& tk = world.tanks[t];
    if (!buysByVehicle(tk)) continue;
    const std::vector<Option> opts =
        optionsFor(world, state, paths, sim.marketParams(), class_nodes, t,
                   tk.target_frac * tk.capacity_t, 0.0, closures ? &open_paths : nullptr);
    const size_t ways = opts.size();
    if (ways == 0) continue;  // site-internal intermediates: nobody sells them
    size_t cut = 0;  // ways a closed route has taken away for now
    for (const Option& o : opts) cut += o.q.blocked == Quote::Block::RouteClosed ? 1 : 0;
    const TankState& ts = state.tank[t];
    const Site& site = world.sites[tk.site.v];
    const Usual usual = usualSeller(world, state, t);
    json row = {{"site", site.key},
                {"site_index", tk.site.v},
                {"name", site.name},
                {"material", world.catalog.materials[tk.material].key},
                {"material_name", world.catalog.materials[tk.material].name},
                {"fill", round4(tk.capacity_t > 0 ? ts.level_t / tk.capacity_t : 0.0)},
                {"cover_h", round2(ts.level_t / tk.design_out_t_h)},
                {"draw_t_h", tk.design_out_t_h},
                {"inbound_t", round2(ts.inbound_t)},
                {"options", ways},
                {"route_closed", cut},
                {"usual", nullptr},
                {"usual_state", nullptr},
                {"usual_site_state", nullptr}};
    if (usual.seller_tank >= 0) {
      row["usual"] = world.sites[world.tanks[static_cast<size_t>(usual.seller_tank)].site.v].key;
      row["usual_state"] = sellerState(world, state, static_cast<uint32_t>(usual.seller_tank));
      row["usual_site_state"] =
          siteState(world, state, world.tanks[static_cast<size_t>(usual.seller_tank)].site.v);
    }
    tanks.push_back(std::move(row));
  }
  return json{{"tick", state.tick}, {"tanks", tanks}}.dump();
}

std::string sourcingJson(const Sim& sim, const std::string& site_arg,
                         const std::string& material_arg) {
  const World& world = sim.world();
  const State& state = sim.state();
  const Catalog& catalog = world.catalog;
  const auto fail = [](const std::string& why) { return json{{"error", why}}.dump(); };

  const int site_idx = resolveSiteArg(world, site_arg);
  if (site_idx < 0) return fail("unknown site \"" + site_arg + "\"");
  const int mat_idx = catalog.findMaterial(material_arg);
  if (mat_idx < 0) return fail("unknown material \"" + material_arg + "\"");
  int tank_idx = -1;
  for (uint32_t t = 0; t < world.tanks.size(); ++t)
    if (world.tanks[t].site.v == static_cast<uint32_t>(site_idx) &&
        world.tanks[t].material == static_cast<uint16_t>(mat_idx))
      tank_idx = static_cast<int>(t);
  const Site& site = world.sites[static_cast<size_t>(site_idx)];
  if (tank_idx < 0) return fail(site.name + " has no " + material_arg + " tank");
  const uint32_t tank = static_cast<uint32_t>(tank_idx);
  const Tank& tk = world.tanks[tank];
  const TankState& ts = state.tank[tank];
  const Material& mat = catalog.materials[tk.material];

  // The tank as procurement sees it now.
  std::vector<TankSignals> signals;
  computeSignals(world, state, signals);
  const bool buys = buysByVehicle(tk);
  const double urgency = buys ? (tk.export_buy ? sim.marketParams().export_urgency : signals[tank].u) : 0.0;
  const double target = tk.target_frac * tk.capacity_t;
  const double want = target - (ts.level_t + ts.inbound_t);
  const double cover_h = tk.design_out_t_h > 0 ? ts.level_t / tk.design_out_t_h : 0.0;
  // With nothing wanted this hour the quotes are for a refill to target.
  const double quoted_for = want > 1e-6 ? want : target;

  json tank_doc = {{"site", site.key},
                   {"site_index", site_idx},
                   {"name", site.name},
                   {"material", mat.key},
                   {"material_name", mat.name},
                   {"buys", buys},
                   {"piped_in", tk.piped_in},
                   {"level_t", round2(ts.level_t)},
                   {"capacity_t", round2(tk.capacity_t)},
                   {"fill", round4(tk.capacity_t > 0 ? ts.level_t / tk.capacity_t : 0.0)},
                   {"target_t", round2(target)},
                   {"draw_t_h", tk.design_out_t_h},
                   {"cover_h", round2(cover_h)},
                   {"inbound_t", round2(ts.inbound_t)},
                   {"lead_time_h", round2(ts.lead_time_h)},
                   {"urgency", round4(urgency)},
                   {"want_t", round2(std::max(0.0, want))},
                   {"quoted_for_t", round2(quoted_for)}};

  json options = json::array();
  json next_pass = nullptr;
  json usual_doc = nullptr;
  if (buys) {
    const PathCache paths = currentPaths(sim);
    const bool closures = anyEdgeClosed(state);
    const PathCache open_paths = closures ? allOpenPaths(world) : PathCache{};
    const MarketParams& params = sim.marketParams();
    const std::vector<std::vector<uint32_t>> class_nodes = classNodes(world, state);
    std::vector<Option> opts = optionsFor(world, state, paths, params, class_nodes, tank,
                                          quoted_for, urgency, closures ? &open_paths : nullptr);

    // What the next hourly pass books for this tank: a dry run on a copy.
    Sim probe(sim);
    const size_t orders_before = state.order.size();
    probe.step(static_cast<uint32_t>(4 - state.tick % 4));
    json lots = json::array();
    double booked_t = 0;
    std::vector<std::pair<uint32_t, uint16_t>> booked;
    for (size_t i = orders_before; i < probe.state().order.size(); ++i) {
      const Order& o = probe.state().order[i];
      if (o.to != tank) continue;
      booked.emplace_back(o.from, o.cls);
      booked_t += o.qty_t;
      lots.push_back({{"seller", world.sites[world.tanks[o.from].site.v].key},
                      {"cls", catalog.vehicle_classes[o.cls].key},
                      {"tonnes", round2(o.qty_t)}});
    }
    next_pass = {{"tick", probe.state().tick}, {"lots", lots}, {"tonnes", round2(booked_t)}};

    const Usual usual = usualSeller(world, state, tank);
    if (usual.seller_tank >= 0) {
      const uint32_t us = static_cast<uint32_t>(usual.seller_tank);
      const Site& usite = world.sites[world.tanks[us].site.v];
      usual_doc = {{"site", usite.key},
                   {"site_index", world.tanks[us].site.v},
                   {"name", usite.name},
                   {"delivered_t", round2(usual.delivered_t)},
                   {"state", sellerState(world, state, us)},
                   {"site_state", siteState(world, state, world.tanks[us].site.v)}};
    }

    // Vehicles per class: how many exist and how many are idle right now.
    std::vector<int> fleet(catalog.vehicle_classes.size(), 0), idle(catalog.vehicle_classes.size(), 0);
    for (size_t v = 0; v < world.fleet.size() && v < state.vehicle.size(); ++v) {
      fleet[world.fleet[v].cls] += 1;
      if (state.vehicle[v].status == VehStatus::Idle) idle[world.fleet[v].cls] += 1;
    }

    std::stable_sort(opts.begin(), opts.end(),
                     [](const Option& a, const Option& b) { return a.q.cost < b.q.cost; });
    for (const Option& o : opts) {
      const Tank& seller = world.tanks[o.seller_tank];
      const TankState& sts = state.tank[o.seller_tank];
      const Site& ssite = world.sites[seller.site.v];
      const VehicleClass& vc = catalog.vehicle_classes[o.cls];
      const uint32_t from = ssite.node[modeIndex(vc.mode)], to = site.node[modeIndex(vc.mode)];
      // A route a closure has cut is described as it normally runs.
      const bool cut = o.q.blocked == Quote::Block::RouteClosed;
      const double travel_h = classTravelHours(world, state, cut ? open_paths : paths, vc, from, to);
      const double handling_h = vc.load_t_h > 0 ? 2.0 * o.q.lot_t / vc.load_t_h : 0.0;
      // The nearest idle vehicle of the class, as dispatch would pick it.
      double pickup_h = std::numeric_limits<double>::infinity();
      for (size_t v = 0; v < world.fleet.size() && v < state.vehicle.size(); ++v) {
        if (world.fleet[v].cls != o.cls || state.vehicle[v].status != VehStatus::Idle) continue;
        pickup_h = std::min(
            pickup_h, classTravelHours(world, state, paths, vc, state.vehicle[v].at_node, from));
      }
      const bool is_chosen =
          std::find(booked.begin(), booked.end(),
                    std::make_pair(o.seller_tank, static_cast<uint16_t>(o.cls))) != booked.end();
      const char* blocked = blockWord(o.q.blocked);
      json row = {{"seller", ssite.key},
                  {"seller_index", seller.site.v},
                  {"seller_name", ssite.name},
                  {"seller_state", sellerState(world, state, o.seller_tank)},
                  {"seller_site_state", siteState(world, state, seller.site.v)},
                  {"stock_t", round2(sts.level_t)},
                  {"free_t", round2(sts.level_t - sts.reserved_out_t)},
                  {"seller_fill", round4(o.q.seller_fill)},
                  {"cls", vc.key},
                  {"mode", modeLabel(vc.mode)},
                  {"vehicles", fleet[o.cls]},
                  {"idle_now", idle[o.cls]},
                  {"km", round2(o.q.km)},
                  {"travel_h", round2(travel_h)},
                  {"handling_h", round2(handling_h)},
                  {"pickup_h", std::isfinite(pickup_h) ? json(round2(pickup_h)) : json(nullptr)},
                  {"door_to_door_h",
                   round2((std::isfinite(pickup_h) ? pickup_h : 0.0) + handling_h + travel_h)},
                  {"lot_t", round2(o.q.lot_t)},
                  {"ask_usd_t", round2(o.q.ask)},
                  {"freight_usd_t", round2(vc.freight * o.q.km)},
                  {"time_usd_t", round2(urgency * params.value_of_time_usd_t_h * o.q.eta_h)},
                  {"switch_usd_t", round2(o.q.switch_cost)},
                  {"landed_usd_t", round2(o.q.cost)},
                  {"price_usd_t", round2((o.q.ask + o.q.bid) / 2.0)},
                  {"feasible_now", o.q.bookable()},
                  {"blocked", blocked != nullptr ? json(blocked) : json(nullptr)},
                  // A short seller says both numbers, so "can spare 3,665 t"
                  // beside "not enough for one load" stops reading as a clash.
                  {"blocked_reason",
                   blocked == nullptr ? json(nullptr)
                   : o.q.blocked == Quote::Block::SellerShort
                         ? json("it can spare " + tonnesText(std::max(0.0, sts.level_t - sts.reserved_out_t)) +
                                "; one load here is " + tonnesText(o.q.lot_t))
                         : json(blockSentence(o.q.blocked, vc.mode))},
                  {"arrives_before_dry", !cut && travel_h + handling_h < cover_h},
                  {"chosen", is_chosen},
                  {"usual", usual.seller_tank == static_cast<int>(o.seller_tank)}};
      options.push_back(std::move(row));
    }
  }

  return json{{"tick", state.tick},
              {"tank", tank_doc},
              {"next_pass", next_pass},
              {"usual", usual_doc},
              {"options", options}}
      .dump();
}

std::string economyJson(const World& world, const State& state, const Recorder& rec,
                        uint32_t bucket_h) {
  const Catalog& catalog = world.catalog;
  const uint64_t tpb = static_cast<uint64_t>(bucket_h) * 4;  // ticks per bucket
  const size_t n = static_cast<size_t>((state.tick + tpb - 1) / tpb);
  // Tick t (1-based: the first step makes tick 1) falls in bucket (t - 1) / tpb.
  const auto bucketOf = [&](uint64_t tick) {
    const size_t b = tick == 0 ? 0 : static_cast<size_t>((tick - 1) / tpb);
    return std::min(b, n == 0 ? 0 : n - 1);
  };
  const size_t hours = rec.hour_totals.size();
  const size_t n_proc = world.processes.size(), n_mat = catalog.materials.size();

  // --- Order book: by material and by vehicle class.
  struct MatSeries {
    bool any = false;
    std::vector<double> ordered_t, lots, spend_usd, freight_usd, delivered_t;
  };
  struct ClassSeries {
    bool any = false;
    std::vector<double> tonnes, tonne_km, freight_usd;
  };
  std::vector<MatSeries> mats(n_mat);
  std::vector<ClassSeries> classes(catalog.vehicle_classes.size());
  std::vector<double> spend_total(n, 0.0);
  for (const Order& o : state.order) {
    if (o.status == OrdStatus::Cancelled || n == 0) continue;  // never bought
    MatSeries& m = mats[o.material];
    if (!m.any) {
      m.any = true;
      for (auto* v : {&m.ordered_t, &m.lots, &m.spend_usd, &m.freight_usd, &m.delivered_t})
        v->assign(n, 0.0);
    }
    const size_t booked = bucketOf(o.created_tick);
    m.ordered_t[booked] += o.qty_t;
    m.lots[booked] += 1;
    m.spend_usd[booked] += o.qty_t * o.price;
    spend_total[booked] += o.qty_t * o.price;
    if (o.status != OrdStatus::Delivered) continue;
    const size_t done = bucketOf(o.delivered_tick);
    m.delivered_t[done] += o.qty_t;
    m.freight_usd[done] += o.freight_usd;
    ClassSeries& c = classes[o.cls];
    if (!c.any) {
      c.any = true;
      for (auto* v : {&c.tonnes, &c.tonne_km, &c.freight_usd}) v->assign(n, 0.0);
    }
    c.tonnes[done] += o.qty_t;
    c.tonne_km[done] += o.qty_t * o.km;
    c.freight_usd[done] += o.freight_usd;
  }

  // The state at the end of bucket b: the recorded hour it closed on, or the
  // live state for the last, partial bucket.
  const auto hourAtEnd = [&](size_t b) { return (b + 1) * bucket_h; };  // hours elapsed
  const auto totalsAt = [&](size_t b) {
    const size_t h = hourAtEnd(b);
    if (h >= 1 && h <= hours) return rec.hour_totals[h - 1];
    double rejected_t = 0, rejected_usd = 0;
    Recorder::rejectedTotals(world, state, rejected_t, rejected_usd);
    return Recorder::HourTotals{state.cum_demand_t,    state.cum_unmet_t,    state.cum_unmet_usd,
                                state.cum_freight_usd, state.cum_energy_usd, state.cum_shutdown_h,
                                rejected_t,            rejected_usd};
  };

  json materials = json::array();
  for (size_t m = 0; m < n_mat; ++m) {
    if (!mats[m].any) continue;
    json row = {{"key", catalog.materials[m].key},
                {"name", catalog.materials[m].name},
                {"basePriceUsdT", catalog.materials[m].base_price},
                {"orderedT", rounded(mats[m].ordered_t, round2)},
                {"lots", rounded(mats[m].lots, round2)},
                {"spendUsd", rounded(mats[m].spend_usd, round2)},
                {"freightUsd", rounded(mats[m].freight_usd, round2)},
                {"deliveredT", rounded(mats[m].delivered_t, round2)}};
    std::vector<double> index(n, 1.0);
    for (size_t b = 0; b < n; ++b) {
      const size_t h = hourAtEnd(b);
      index[b] = (h >= 1 && h <= hours && rec.hour_price.size() >= h * n_mat)
                     ? static_cast<double>(rec.hour_price[(h - 1) * n_mat + m])
                     : state.price_index[m];
    }
    row["priceIndex"] = rounded(index, round4);
    materials.push_back(std::move(row));
  }

  json by_class = json::array();
  for (size_t c = 0; c < classes.size(); ++c) {
    if (!classes[c].any) continue;
    by_class.push_back({{"cls", catalog.vehicle_classes[c].key},
                        {"tonnes", rounded(classes[c].tonnes, round2)},
                        {"tonneKm", rounded(classes[c].tonne_km, round2)},
                        {"freightUsd", rounded(classes[c].freight_usd, round2)}});
  }

  // --- Money and service per bucket (differences of the running totals).
  std::vector<double> freight(n), energy(n), unmet_usd(n), unmet_t(n), demand_t(n), service(n),
      shutdown_h(n), rejected_t(n), rejected_usd(n);
  Recorder::HourTotals prev{};
  for (size_t b = 0; b < n; ++b) {
    const Recorder::HourTotals now = totalsAt(b);
    freight[b] = now.freight_usd - prev.freight_usd;
    energy[b] = now.energy_usd - prev.energy_usd;
    unmet_usd[b] = now.unmet_usd - prev.unmet_usd;
    unmet_t[b] = now.unmet_t - prev.unmet_t;
    demand_t[b] = now.demand_t - prev.demand_t;
    service[b] = demand_t[b] > 0 ? 1.0 - unmet_t[b] / demand_t[b] : 1.0;
    shutdown_h[b] = now.shutdown_h - prev.shutdown_h;
    rejected_t[b] = now.rejected_t - prev.rejected_t;
    rejected_usd[b] = now.rejected_usd - prev.rejected_usd;
    prev = now;
  }

  // --- Plants: the band each one's rate moved in, per bucket.
  json plants = json::array();
  for (size_t p = 0; p < n_proc; ++p) {
    const Process& proc = world.processes[p];
    const ProcessType& type = catalog.process_types[proc.type];
    if (type.boundary == Boundary::Sink) continue;
    std::vector<double> lo(n), mean(n), hi(n);
    const double live = proc.design_rate_t_h > 0 ? state.proc[p].rate_t_h / proc.design_rate_t_h : 0;
    for (size_t b = 0; b < n; ++b) {
      const size_t first = b * bucket_h, last = std::min(hourAtEnd(b), hours);  // [first, last)
      if (first >= last || rec.hour_rate.size() < last * n_proc) {
        lo[b] = mean[b] = hi[b] = live;  // a bucket younger than its first hourly sample
        continue;
      }
      double mn = 1e300, mx = -1e300, sum = 0;
      for (size_t h = first; h < last; ++h) {
        const double r = rec.hour_rate[h * n_proc + p];
        mn = std::min(mn, r);
        mx = std::max(mx, r);
        sum += r;
      }
      lo[b] = mn;
      hi[b] = mx;
      mean[b] = sum / static_cast<double>(last - first);
    }
    const Site& site = world.sites[proc.site.v];
    plants.push_back({{"site", site.key},
                      {"site_index", proc.site.v},
                      {"name", site.name},
                      {"process", type.key},
                      {"process_name", type.name},
                      {"index", p},
                      {"boundary", type.boundary == Boundary::Source ? "source" : "none"},
                      {"designRateTph", proc.design_rate_t_h},
                      {"turndown", type.boundary == Boundary::Source ? 0.0 : type.turndown},
                      {"rateMin", rounded(lo, round4)},
                      {"rateMean", rounded(mean, round4)},
                      {"rateMax", rounded(hi, round4)}});
  }

  // Tanks that reject when full: what each has thrown away so far.
  json rejected = json::array();
  for (size_t t = 0; t < world.tanks.size(); ++t) {
    if (!world.tanks[t].reject_when_full) continue;
    const Tank& tk = world.tanks[t];
    const Material& mat = catalog.materials[tk.material];
    rejected.push_back({{"site", world.sites[tk.site.v].key},
                        {"site_index", tk.site.v},
                        {"name", world.sites[tk.site.v].name},
                        {"material", mat.key},
                        {"rejectedT", round2(state.tank[t].rejected_t)},
                        {"rejectedUsd", round2(state.tank[t].rejected_t * mat.base_price)}});
  }

  const json doc = {{"tick", state.tick},
                    {"bucketH", bucket_h},
                    {"buckets", n},
                    {"materials", materials},
                    {"byClass", by_class},
                    {"totals",
                     {{"spendUsd", rounded(spend_total, round2)},
                      {"freightUsd", rounded(freight, round2)},
                      {"energyUsd", rounded(energy, round2)},
                      {"unmetUsd", rounded(unmet_usd, round2)},
                      {"unmetT", rounded(unmet_t, round2)},
                      {"demandT", rounded(demand_t, round2)},
                      {"service", rounded(service, round4)},
                      {"shutdownH", rounded(shutdown_h, round2)},
                      {"rejectedT", rounded(rejected_t, round2)},
                      {"rejectedUsd", rounded(rejected_usd, round2)}}},
                    {"rejected", rejected},
                    {"plants", plants}};
  return doc.dump();
}

std::string scoresJson(const World& world, const State& state) {
  struct Row {
    size_t site;
    double revenue, feed, freight, energy, profit, sold;
  };
  std::vector<Row> rows;
  for (size_t s = 0; s < world.sites.size(); ++s) {
    const Ledger& l = state.ledger[s];
    const SiteTrade& t = state.site_trade[s];
    Row r{s, l.revenue + t.pipe_revenue, l.feed_cost + t.pipe_feed_cost, l.freight,
          l.energy_cost, 0.0, t.sold_t};
    r.profit = r.revenue - r.feed - r.freight - r.energy;
    rows.push_back(r);
  }
  // Rank by profit, ties to the lower site index so the order is stable.
  std::vector<size_t> order(rows.size());
  for (size_t i = 0; i < order.size(); ++i) order[i] = i;
  std::stable_sort(order.begin(), order.end(),
                   [&](size_t a, size_t b) { return rows[a].profit > rows[b].profit; });
  std::vector<int> rank(rows.size(), 0);
  for (size_t i = 0; i < order.size(); ++i) rank[order[i]] = static_cast<int>(i) + 1;

  json scores = json::array();
  for (const Row& r : rows)
    scores.push_back({{"site", r.site},
                      {"key", world.sites[r.site].key},
                      {"name", world.sites[r.site].name},
                      {"profitUsd", r.profit},
                      {"revenueUsd", r.revenue},
                      {"feedUsd", r.feed},
                      {"freightUsd", r.freight},
                      {"energyUsd", r.energy},
                      {"markup", state.site_markup[r.site]},
                      {"rateShare", state.site_rate_share[r.site]},
                      {"soldT", r.sold},
                      {"rank", rank[r.site]}});
  return json{{"tick", state.tick}, {"scores", scores}}.dump();
}

std::vector<uint16_t> tradedMaterials(const World& world, uint32_t seller, uint32_t buyer) {
  std::vector<uint16_t> out;
  if (seller == buyer) return out;
  const auto add = [&](uint16_t m) {
    if (std::find(out.begin(), out.end(), m) == out.end()) out.push_back(m);
  };
  const uint8_t vehicle_modes = (1u << static_cast<uint8_t>(Mode::Road)) |
                                (1u << static_cast<uint8_t>(Mode::River)) |
                                (1u << static_cast<uint8_t>(Mode::Sea));
  for (const Tank& from : world.tanks) {
    if (from.site.v != seller) continue;
    if (from.role != TankRole::Product && from.role != TankRole::Both) continue;
    if (!(world.catalog.materials[from.material].modes & vehicle_modes)) continue;
    for (const Tank& to : world.tanks)
      if (to.site.v == buyer && to.material == from.material &&
          (to.role == TankRole::Feed || to.role == TankRole::Both))
        add(from.material);
  }
  for (const Pipeline& pipe : world.pipelines)
    if (world.tanks[pipe.from.v].site.v == seller && world.tanks[pipe.to.v].site.v == buyer)
      add(world.tanks[pipe.to.v].material);
  std::sort(out.begin(), out.end());
  return out;
}

std::string partnersJson(const World& world, const State& state, uint32_t site) {
  if (site >= world.sites.size()) return std::string();
  const auto list = [&](bool selling) {
    json rows = json::array();
    for (uint32_t other = 0; other < world.sites.size(); ++other) {
      const uint32_t seller = selling ? site : other, buyer = selling ? other : site;
      const std::vector<uint16_t> mats = tradedMaterials(world, seller, buyer);
      if (mats.empty()) continue;
      json names = json::array();
      for (const uint16_t m : mats) names.push_back(materialWord(world.catalog, m));
      rows.push_back({{"site", other},
                      {"key", world.sites[other].key},
                      {"name", world.sites[other].name},
                      {"materials", names},
                      {"blocked", state.tradeBlocked(seller, buyer)}});
    }
    return rows;
  };
  return json{{"site", site},
              {"name", world.sites[site].name},
              {"buyers", list(true)},
              {"suppliers", list(false)}}
      .dump();
}

std::string summaryJson(const World& world, const State& state) {
  json sites = json::array();
  int stopped_now = 0;
  for (size_t s = 0; s < world.sites.size(); ++s) {
    bool down = false, restarting = false, holding = false, customer = true, any = false;
    for (size_t p = 0; p < world.processes.size(); ++p) {
      if (world.processes[p].site.v != s) continue;
      any = true;
      down = down || state.proc[p].status == ProcStatus::Shutdown;
      restarting = restarting || state.proc[p].status == ProcStatus::Restarting;
      holding = holding || state.proc[p].status == ProcStatus::HoldMin;
      customer = customer &&
                 world.catalog.process_types[world.processes[p].type].boundary == Boundary::Sink;
    }
    customer = customer && any;
    bool limited = false;
    for (const EventDef& ev : state.active)
      limited = limited || (ev.site == s && ev.multiplier != 1.0 &&
                            (ev.type == EventDef::Type::SupplyShock ||
                             ev.type == EventDef::Type::DemandShock));
    const int status = down ? 3 : restarting ? 4 : holding ? 1 : limited ? 5 : 0;
    stopped_now += (status == 3 || status == 4) ? 1 : 0;
    const Ledger& l = state.ledger[s];
    sites.push_back({{"site", s},
                     {"key", world.sites[s].key},
                     {"name", world.sites[s].name},
                     {"customer", customer},
                     {"status", status},
                     {"stoppedHours", state.site_trade[s].stopped_h},
                     {"outputT", customer ? l.consumed_t : l.produced_t},
                     {"lostSalesUsd", state.site_trade[s].unmet_usd}});
  }
  json pipes = json::array();
  for (size_t i = 0; i < world.pipelines.size(); ++i) {
    const Pipeline& pipe = world.pipelines[i];
    const uint32_t from = world.tanks[pipe.from.v].site.v, to = world.tanks[pipe.to.v].site.v;
    std::string what = materialWord(world.catalog, world.tanks[pipe.to.v].material);
    if (!what.empty()) what[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(what[0])));
    pipes.push_back({{"index", i},
                     {"name", what + " pipeline from " + world.sites[from].name + " to " + world.sites[to].name},
                     {"from", from},
                     {"to", to},
                     {"movedT", state.pipe_moved_t[i]}});
  }
  json prices = json::array();
  for (size_t m = 0; m < world.catalog.materials.size(); ++m) {
    const double t = state.mat_bought_t[m];
    prices.push_back({{"material", world.catalog.materials[m].key},
                      {"name", world.catalog.materials[m].name},
                      {"tonnes", t},
                      {"avgUsdPerT", t > 0.0 ? state.mat_bought_usd[m] / t : 0.0}});
  }
  return json{{"tick", state.tick},
              {"prices", prices},
              {"economy",
               {{"lostSalesUsd", state.cum_unmet_usd},
                {"deliveredT", state.cum_demand_t - state.cum_unmet_t},
                {"plantsStoppedNow", stopped_now}}},
              {"sites", sites},
              {"pipelines", pipes}}
      .dump();
}

}  // namespace sim
}  // namespace crx
