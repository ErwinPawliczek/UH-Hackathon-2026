#include "world/worldgen/WorldGen.h"

#include "world/worldgen/Feasibility.h"
#include "world/worldgen/Geo.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <utility>

namespace crx {
namespace worldgen {

namespace {

// Reference edge speeds per mode from the catalog's vehicle classes (§3.4):
// the slowest class that uses the mode defines the mode's edge speed, so
// every travel time is conservative. Sea falls back to the parameter.
double modeSpeed(const CatalogView& catalog, Mode mode, double fallback) {
  double best = 0.0;
  for (const VehicleClassInfo& v : catalog.vehicles) {
    if (v.mode != mode || v.speed_kmh <= 0.0) continue;
    best = best == 0.0 ? v.speed_kmh : std::min(best, v.speed_kmh);
  }
  return best > 0.0 ? best : fallback;
}

GeneratedWorld assemble(uint64_t seed, const GenParams& params, const Frame& frame,
                        const Features& ft, const std::vector<SiteSlot>& slots,
                        const Routes& routes, const SizingResult& sizing,
                        const CatalogView& catalog) {
  GeneratedWorld w;
  w.seed = seed;
  w.params = params;

  // -- nodes and edges (polyline vertices appended in edge order).
  w.nodes.reserve(routes.nodes.size());
  for (const Routes::NodeRef& n : routes.nodes)
    w.nodes.push_back({static_cast<float>(n.pos.x), static_cast<float>(n.pos.y)});
  w.overseas_node =
      routes.overseas_node >= 0 ? NodeId{static_cast<uint32_t>(routes.overseas_node)} : NodeId{};

  w.edges.reserve(routes.edges.size());
  for (const Routes::Edge& e : routes.edges) {
    Range<uint32_t> poly{static_cast<uint32_t>(w.polyline_xy.size() / 2),
                         static_cast<uint32_t>(e.polyline.size())};
    for (const Vec2& p : e.polyline) {
      w.polyline_xy.push_back(static_cast<float>(p.x));
      w.polyline_xy.push_back(static_cast<float>(p.y));
    }
    WEdge we;
    we.a = NodeId{e.a};
    we.b = NodeId{e.b};
    we.mode = e.mode;
    we.length_km = static_cast<float>(e.length_km);
    we.speed_kmh = static_cast<float>(e.speed_kmh);
    we.polyline = poly;
    w.edges.push_back(we);
  }

  // -- sites: one per slot, named by preset with a per-preset ordinal (city
  // sinks take the city's name).
  std::map<std::string, int> ordinal;
  for (size_t s = 0; s < slots.size(); ++s) {
    const SiteSlot& slot = slots[s];
    const int n = ++ordinal[slot.preset];
    std::string name = slot.name.empty() ? slot.preset + "_" + std::to_string(n) : slot.name;
    if (slot.city >= 0 && slot.city < static_cast<int>(ft.cities.size()))
      name = slot.preset + "_" + ft.cities[static_cast<size_t>(slot.city)].name;

    WSite ws;
    ws.name = name;
    ws.preset = slot.preset;
    ws.variant = slot.variant;
    ws.x_km = static_cast<float>(slot.pos.x);
    ws.y_km = static_cast<float>(slot.pos.y);
    ws.region = static_cast<uint16_t>(
        1 + (slot.pos.x > params.map_w_km / 2.0 ? 1 : 0) +
        (slot.pos.y > params.map_h_km / 2.0 ? 2 : 0));
    for (const int mi : {0, 1, 2}) {
      const int idx = routes.site_nodes[s][static_cast<size_t>(mi)];
      if (idx >= 0) ws.node[static_cast<size_t>(mi)] = NodeId{static_cast<uint32_t>(idx)};
    }
    if (const PresetInfo* preset = catalog.preset(slot.preset)) {
      ws.bays[0] = preset->bays_road;
      ws.bays[1] = preset->bays_river;
      ws.bays[2] = preset->bays_sea;
    }
    ws.city = slot.city;
    w.sites.push_back(ws);
  }

  // -- tanks: the sizing walk's (site, material) designs, in map order so
  // each site's tanks are contiguous.
  std::map<std::pair<int, std::string>, WTank> tank_map;
  for (const SizingResult::TankDesign& t : sizing.tanks) {
    WTank wt;
    wt.site = SiteId{static_cast<uint32_t>(t.site)};
    wt.material = t.material;
    wt.role = t.role;
    wt.capacity_t = t.capacity_t;
    wt.target_frac = 0.5;
    wt.design_in_t_h = t.in_t_h;
    wt.design_out_t_h = t.out_t_h;
    tank_map[{t.site, t.material}] = wt;
  }
  for (const SizingResult::FlowLine& f : sizing.flows) {
    if (!f.piped) continue;
    if (f.from_site >= 0) tank_map[{f.from_site, f.material}].piped_out = true;
    if (f.to_site >= 0) tank_map[{f.to_site, f.material}].piped_in = true;
  }
  std::map<std::pair<uint32_t, std::string>, TankId> tank_id;
  for (size_t s = 0; s < slots.size(); ++s) {
    auto it = tank_map.lower_bound({static_cast<int>(s), std::string()});
    w.sites[s].tanks.begin = static_cast<uint32_t>(w.tanks.size());
    while (it != tank_map.end() && it->first.first == static_cast<int>(s)) {
      const TankId id{static_cast<uint32_t>(w.tanks.size())};
      tank_id[{static_cast<uint32_t>(s), it->first.second}] = id;
      w.tanks.push_back(it->second);
      ++it;
    }
    w.sites[s].tanks.count = static_cast<uint32_t>(w.tanks.size()) - w.sites[s].tanks.begin;
  }

  // -- processes and units (train capacity split evenly across trains).
  for (const SizingResult::ProcDesign& d : sizing.processes) {
    WProcess wp;
    wp.site = SiteId{static_cast<uint32_t>(d.site)};
    wp.type = d.type;
    wp.design_rate_t_h = d.rate_t_h;

    const ProcessInfo* p = catalog.process(d.type);
    if (p != nullptr) {
      uint32_t total_trains = 0;
      for (const auto& u : p->units) total_trains += u.trains;
      wp.units.begin = static_cast<uint32_t>(w.units.size());
      uint8_t slot = 0;
      for (const auto& u : p->units) {
        for (uint8_t t = 0; t < u.trains; ++t) {
          WUnit wu;
          wu.process = ProcessId{static_cast<uint32_t>(w.processes.size())};
          wu.slot = slot++;
          wu.cap_per_train_t_h = total_trains > 0 ? d.rate_t_h / total_trains : 0.0;
          w.units.push_back(wu);
        }
      }
      wp.units.count = static_cast<uint32_t>(w.units.size()) - wp.units.begin;

      // tank_of: one tank per external (traded) stream — products first,
      // then feeds, in recipe order. A stream that netted to zero has no
      // tank; point it at the site's first tank so the index stays total.
      std::vector<TankId> tank_of;
      auto streamTank = [&](const std::string& material) {
        const auto it = tank_id.find({wp.site.v, material});
        if (it != tank_id.end()) {
          tank_of.push_back(it->second);
          return;
        }
        // Zero-net stream: reuse the site's own tank range start (the site
        // always has at least one tank when any of its processes run).
        if (w.sites[static_cast<size_t>(d.site)].tanks.count > 0) {
          tank_of.push_back(TankId{w.sites[static_cast<size_t>(d.site)].tanks.begin});
        }
      };
      for (size_t mi = 0; mi < p->modes.size(); ++mi) {
        if (p->modes[mi] != d.mode) continue;
        for (const NetStream& s : p->by_mode[mi].out) {
          const MaterialInfo* m = catalog.material(s.material);
          if (m != nullptr && m->kind == MatKind::Traded) streamTank(s.material);
        }
        for (const NetStream& s : p->by_mode[mi].in) {
          const MaterialInfo* m = catalog.material(s.material);
          if (m != nullptr && m->kind == MatKind::Traded) streamTank(s.material);
        }
        break;
      }
      wp.tank_of = tank_of;
    }

    // Schedule curve: boundary sinks ride the demand sinusoid, everything
    // else runs flat at the design rate. Values are absolute t/h, one curve
    // per process.
    wp.schedule = static_cast<uint16_t>(w.schedules.size());
    std::vector<float> curve(24, 0.0f);
    if (d.type.rfind("SINK_", 0) == 0) {
      double raw[24];
      double sum = 0.0;
      for (int h = 0; h < 24; ++h) {
        raw[h] = 1.0 + 0.25 * std::sin(2.0 * 3.14159265358979323846 * (h - 8) / 24.0);
        sum += raw[h];
      }
      const double scale = sum > 0.0 ? 24.0 / sum : 0.0;
      for (int h = 0; h < 24; ++h)
        curve[static_cast<size_t>(h)] = static_cast<float>(d.rate_t_h * raw[h] * scale);
    } else {
      for (int h = 0; h < 24; ++h) curve[static_cast<size_t>(h)] = static_cast<float>(d.rate_t_h);
    }
    w.schedules.push_back(curve);
    w.processes.push_back(wp);
  }

  // -- pipelines: straight links between the piped flows' endpoint tanks.
  for (const SizingResult::FlowLine& f : sizing.flows) {
    if (!f.piped) continue;
    const TankId from = f.from_site == kOverseasSite
                            ? TankId{}
                            : tank_id[{static_cast<uint32_t>(f.from_site), f.material}];
    const TankId to = f.to_site == kOverseasSite
                          ? TankId{}
                          : tank_id[{static_cast<uint32_t>(f.to_site), f.material}];
    WPipeline pl;
    pl.from = from;
    pl.to = to;
    pl.cap_t_h = f.t_d / 24.0;
    const Vec2 a = f.from_site == kOverseasSite
                       ? frame.overseas
                       : (f.from_site >= 0 ? slots[static_cast<size_t>(f.from_site)].pos : Vec2{});
    const Vec2 b = f.to_site == kOverseasSite
                       ? frame.overseas
                       : (f.to_site >= 0 ? slots[static_cast<size_t>(f.to_site)].pos : Vec2{});
    pl.length_km = static_cast<float>(distKM(a, b));
    pl.polyline.begin = static_cast<uint32_t>(w.polyline_xy.size() / 2);
    for (const Vec2& p : straightPolyline(a, b)) {
      w.polyline_xy.push_back(static_cast<float>(p.x));
      w.polyline_xy.push_back(static_cast<float>(p.y));
    }
    pl.polyline.count = static_cast<uint32_t>(w.polyline_xy.size() / 2) - pl.polyline.begin;
    w.pipelines.push_back(pl);
  }

  // -- fleet: group the vehicle lines by (class, home site); each vehicle is
  // one spec homed at the site's node for the class's mode.
  std::map<std::pair<std::string, int>, int> fleet_count;
  for (const SizingResult::VehicleLine& v : sizing.fleet) fleet_count[{v.cls, v.home_site}] += v.count;
  for (const auto& [key, count] : fleet_count) {
    const VehicleClassInfo* vc = catalog.vehicle(key.first);
    NodeId home;
    if (key.second == kOverseasSite) {
      home = w.overseas_node;
    } else if (key.second >= 0 && vc != nullptr) {
      const int idx = routes.siteNode(key.second, vc->mode);
      if (idx >= 0) home = NodeId{static_cast<uint32_t>(idx)};
    }
    for (int i = 0; i < count; ++i) w.fleet.push_back({key.first, home});
  }

  // -- contracts: cheapest feasible supplier per domestic vehicle flow (the
  // matching walk already made the choice). Overseas legs face the external
  // market, not a supplier tank — no contract.
  for (const SizingResult::FlowLine& f : sizing.flows) {
    if (f.piped) continue;
    if (f.from_site == kOverseasSite || f.to_site == kOverseasSite) continue;
    const TankId buyer = tank_id[{static_cast<uint32_t>(f.to_site), f.material}];
    const TankId seller = tank_id[{static_cast<uint32_t>(f.from_site), f.material}];
    if (!buyer.valid() || !seller.valid()) continue;
    w.contracts.push_back({buyer, seller});
  }

  return w;
}

}  // namespace

GenResult generateWorld(uint64_t seed, const GenParams& params, const CatalogView& catalog,
                        WarmupHook warmup) {
  const DemandConstants demands{};
  GenResult res;
  for (int attempt = 0; attempt < params.max_gate_attempts; ++attempt) {
    // Gate reseeds on failure: attempt k streams from seed + k·φ so every
    // attempt is a fresh, deterministic world.
    const uint64_t s = seed + static_cast<uint64_t>(attempt) * 0x9E3779B97F4A7C15ull;
    Rng rng(s);
    const Frame frame = makeFrame(params, rng);
    const Features ft = makeFeatures(params, rng, frame);
    const std::vector<SiteSlot> slots = placeSites(params, rng, ft, frame);
    Routes routes = buildRoutes(params, rng, ft, frame, slots, modeSpeed(catalog, Mode::Road, 70.0),
                                modeSpeed(catalog, Mode::River, 12.0));
    finalize(routes);
    const SizingResult sizing = sizeWorld(catalog, params, demands, ft, slots, routes);
    GeneratedWorld world = assemble(s, params, frame, ft, slots, routes, sizing, catalog);
    res.gate_errors = checkFeasibility(world, catalog);
    if (warmup != nullptr) {
      for (std::string& e : warmup(world, catalog)) res.gate_errors.push_back(std::move(e));
    }
    if (res.gate_errors.empty()) {
      res.world = std::move(world);
      res.ok = true;
      return res;
    }
  }
  return res;
}

}  // namespace worldgen
}  // namespace crx
