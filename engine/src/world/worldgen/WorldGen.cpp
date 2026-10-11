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
                        const CatalogView& catalog, const DemandConstants& demands) {
  GeneratedWorld w;
  w.seed = seed;
  w.params = params;

  // Terrain frame: sea edge and the river feature polyline, serialized so a
  // frozen world file rebuilds the renderer's height field (§6.1).
  w.sea_edge = frame.sea_edge;
  w.river_xy.reserve(ft.river.size() * 2);
  for (const Vec2& p : ft.river) {
    w.river_xy.push_back(static_cast<float>(p.x));
    w.river_xy.push_back(static_cast<float>(p.y));
  }

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
  // Designed throughput per site (t/h, in+out) — the basis for bay scaling.
  std::vector<double> site_throughput(slots.size(), 0.0);
  for (const SizingResult::TankDesign& t : sizing.tanks)
    if (t.site < site_throughput.size())
      site_throughput[t.site] += t.in_t_h + t.out_t_h;
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
      // Preset bays are M1-scale floors. Scale them to the site's designed
      // throughput so unload capacity never caps delivery: a truck bay turns
      // ~24 loads/day (≈600 t), a river bay ~3 barges/day (≈6000 t), a sea
      // bay ~1 ship/day (≈40000 t) at catalog load rates with queue margin.
      // A preset bay count of 0 means that mode is not used at this site.
      const double t_day = site_throughput[s] * 24.0;
      const int road = preset->bays_road > 0 ? 1 + static_cast<int>(t_day / 600.0) : 0;
      const int river = preset->bays_river > 0 ? 1 + static_cast<int>(t_day / 6000.0) : 0;
      const int sea = preset->bays_sea > 0 ? 1 + static_cast<int>(t_day / 40000.0) : 0;
      ws.bays[0] = static_cast<uint8_t>(std::clamp(std::max(road, static_cast<int>(preset->bays_road)), 0, 24));
      ws.bays[1] = static_cast<uint8_t>(std::clamp(std::max(river, static_cast<int>(preset->bays_river)), 0, 12));
      ws.bays[2] = static_cast<uint8_t>(std::clamp(std::max(sea, static_cast<int>(preset->bays_sea)), 0, 8));
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

      // tank_of: material-indexed (the sim contract — one tank per traded
      // material, at the material's own index). A stream that netted to zero
      // has no tank; point it at the site's first tank so the index stays
      // total.
      std::vector<TankId> tank_of(catalog.materials.size(), TankId{});
      auto materialIndex = [&](const std::string& key) {
        for (size_t i = 0; i < catalog.materials.size(); ++i)
          if (catalog.materials[i].key == key) return static_cast<int>(i);
        return -1;
      };
      auto streamTank = [&](const std::string& material) {
        const int mid = materialIndex(material);
        if (mid < 0) return;
        const auto it = tank_id.find({wp.site.v, material});
        if (it != tank_id.end()) {
          tank_of[static_cast<size_t>(mid)] = it->second;
          return;
        }
        // Zero-net stream: reuse the site's own tank range start (the site
        // always has at least one tank when any of its processes run).
        if (w.sites[static_cast<size_t>(d.site)].tanks.count > 0) {
          tank_of[static_cast<size_t>(mid)] =
              TankId{w.sites[static_cast<size_t>(d.site)].tanks.begin};
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

    // Mode mix (§5.3 M1 policy): fixed per design mode. Single-mode types run
    // all swing trains on their one mode; the gas cracker burns pure ethane;
    // the flex cracker rides the generator's feed policy.
    if (p != nullptr && p->modes.size() > 1) {
      wp.mode_share.assign(p->modes.size(), 0.0);
      if (d.mode == "FLEX") {
        for (size_t m = 0; m < p->modes.size(); ++m)
          wp.mode_share[m] = p->modes[m] == "ETHANE"   ? demands.flex_ethane
                             : p->modes[m] == "LPG"    ? demands.flex_lpg
                                                       : demands.flex_naphtha;
      } else {
        for (size_t m = 0; m < p->modes.size(); ++m)
          if (p->modes[m] == d.mode) wp.mode_share[m] = 1.0;
      }
    }

    // Schedule curve: city demand sinks ride the demand sinusoid (§3.3),
    // everything else — plant trains and the port's flat export/bunker
    // sinks — runs flat at the design rate. Values are absolute t/h.
    wp.schedule = static_cast<uint16_t>(w.schedules.size());
    std::vector<float> curve(24, 0.0f);
    if (d.demand_curved) {
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

  // -- per-site process ranges: regroup the flat list by site so the sim
  // bridge (which walks sites, not the flat list) sees each site's processes
  // contiguously; remap the units' back-references to the new flat indices.
  {
    std::vector<uint32_t> remap(w.processes.size(), 0u);
    std::vector<WProcess> ordered;
    ordered.reserve(w.processes.size());
    for (size_t ps = 0; ps < slots.size(); ++ps) {
      w.sites[ps].processes.begin = static_cast<uint32_t>(ordered.size());
      for (size_t i = 0; i < w.processes.size(); ++i) {
        if (w.processes[i].site.v != ps) continue;
        remap[i] = static_cast<uint32_t>(ordered.size());
        ordered.push_back(w.processes[i]);
      }
      w.sites[ps].processes.count =
          static_cast<uint32_t>(ordered.size()) - w.sites[ps].processes.begin;
    }
    w.processes = std::move(ordered);
    for (WUnit& u : w.units) u.process = ProcessId{remap[u.process.v]};
  }

  // -- pipelines: straight links between the piped flows' endpoint tanks.
  // Any new pipeline collinear with a committed one — the same pair twice, or
  // sites that line up across pairs (A→B and B→C on one axis) — or lying on a
  // road gets a shallow lateral bend, so no road lies on a pipeline and no
  // line carries three pipelines (§6.4). The gate re-verifies overlap on the
  // finished world; the threshold matches its tolerance, not a loose 10 km.
  std::vector<std::vector<Vec2>> built_lines;
  for (const Routes::Edge& e : routes.edges)
    if (e.mode == Mode::Road) built_lines.push_back(e.polyline);
  const auto collides = [&](const std::vector<Vec2>& line) {
    for (const auto& other : built_lines)
      if (overlapAlong(line, other) > 0.05) return true;
    return false;
  };
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
    const double dx = b.x - a.x, dy = b.y - a.y;
    const double len = std::hypot(dx, dy);
    std::vector<Vec2> line;
    int bend = 0;
    do {
      if (bend == 0 || len <= 1e-6) {
        line = straightPolyline(a, b);
      } else {
        const double side = (bend % 2 == 1) ? 1.0 : -1.0;
        const double off = 0.6 * static_cast<double>((bend + 1) / 2);  // km
        const Vec2 mid{(a.x + b.x) / 2.0 - dy / len * off * side,
                       (a.y + b.y) / 2.0 + dx / len * off * side};
        line = {a, mid, b};
      }
      ++bend;
    } while (bend <= 7 && collides(line));
    built_lines.push_back(line);
    double length_km = 0.0;
    for (size_t i = 1; i < line.size(); ++i) length_km += distKM(line[i - 1], line[i]);
    pl.length_km = static_cast<float>(length_km);
    pl.polyline.begin = static_cast<uint32_t>(w.polyline_xy.size() / 2);
    for (const Vec2& p : line) {
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

  // -- flow records for the constraint suites and demo tooling (not serialized).
  w.flows.reserve(sizing.flows.size());
  for (const SizingResult::FlowLine& f : sizing.flows)
    w.flows.push_back({f.material, f.from_site, f.to_site, f.t_d, f.piped});

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
    GeneratedWorld world = assemble(s, params, frame, ft, slots, routes, sizing, catalog, demands);
    res.gate_errors = checkFeasibility(world, catalog);
    // The warm-up runs 28 simulated days and presumes a structurally sound
    // world; run it only on candidates the structural gate already cleared.
    if (warmup != nullptr && res.gate_errors.empty()) {
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
