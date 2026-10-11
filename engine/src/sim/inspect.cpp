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

namespace {

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
    return Recorder::HourTotals{state.cum_demand_t,   state.cum_unmet_t,  state.cum_unmet_usd,
                                state.cum_freight_usd, state.cum_energy_usd, state.cum_shutdown_h};
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
      shutdown_h(n);
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
                      {"rateMin", rounded(lo, round4)},
                      {"rateMean", rounded(mean, round4)},
                      {"rateMax", rounded(hi, round4)}});
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
                      {"shutdownH", rounded(shutdown_h, round2)}}},
                    {"plants", plants}};
  return doc.dump();
}

}  // namespace sim
}  // namespace crx
