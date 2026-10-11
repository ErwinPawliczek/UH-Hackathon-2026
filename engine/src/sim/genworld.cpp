// Bridge implementation: GeneratedWorld → sim World. Mirrors buildWorld()'s
// derivation semantics (per-tank design draws, unit capacities at the
// catalog's overdesign, swing-train mode mixes) so both world kinds behave
// identically; the route graph, fleet and contracts copy across directly.
#include "sim/genworld.h"

#include "sim/sim.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <set>
#include <utility>

namespace crx {
namespace sim {

bool buildGeneratedWorld(const Catalog& catalog, const worldgen::GeneratedWorld& gen, World& out,
                         std::string& error) {
  const auto fail = [&](const std::string& msg) {
    error = "generated world: " + msg;
    return false;
  };

  out = World{};
  out.catalog = catalog;
  out.seed = gen.seed;

  // -- schedules: the generator stores absolute t/h curves; the sim wants
  // multipliers on the design rate. Normalise per curve (they are per
  // process), mean 1 over the day.
  out.schedules.reserve(gen.schedules.size());
  for (const auto& curve : gen.schedules) {
    double sum = 0.0;
    for (const double v : curve) sum += v;
    const double mean = curve.empty() ? 1.0 : sum / static_cast<double>(curve.size());
    std::vector<double> mult;
    mult.reserve(curve.size());
    for (const double v : curve) mult.push_back(mean > 1e-12 ? v / mean : 1.0);
    out.schedules.push_back(std::move(mult));
  }

  // -- route graph: nodes, edges and the shared polyline point list.
  out.nodes.reserve(gen.nodes.size());
  for (const worldgen::WNode& n : gen.nodes) out.nodes.push_back({n.x_km, n.y_km, -1});
  // Site bindings: the generator bound sites to nodes; recover them so the
  // fleet homes correctly.
  for (size_t s = 0; s < gen.sites.size(); ++s) {
    for (const NodeId& n : gen.sites[s].node) {
      if (n.valid() && n.v < out.nodes.size()) out.nodes[n.v].site = static_cast<int>(s);
    }
  }
  out.polyline_xy.reserve(gen.polyline_xy.size());
  for (const float v : gen.polyline_xy) out.polyline_xy.push_back(static_cast<double>(v));
  out.edges.reserve(gen.edges.size());
  for (const worldgen::WEdge& e : gen.edges) {
    RouteEdge re;
    re.a = e.a.v;
    re.b = e.b.v;
    // The two mode enums list Road, River, Sea, Pipeline in the same order.
    re.mode = static_cast<crx::Mode>(static_cast<uint8_t>(e.mode));
    re.length_km = e.length_km;
    re.speed_kmh = e.speed_kmh;
    re.polyline = e.polyline;
    out.edges.push_back(re);
  }

  // -- sites, tanks, processes, units. Generated tank ids equal insertion
  // order (one site's tanks contiguous), so the generator's TankIds stay
  // valid in the built world.
  for (size_t s = 0; s < gen.sites.size(); ++s) {
    const worldgen::WSite& ws = gen.sites[s];
    const SiteId sid{static_cast<uint32_t>(s)};
    const int preset_idx = catalog.findPreset(ws.preset);
    if (preset_idx < 0) return fail("unknown site preset " + ws.preset);
    const SitePreset& preset = catalog.site_presets[static_cast<size_t>(preset_idx)];

    Site site;
    site.key = ws.name;
    site.name = ws.name;
    site.preset = preset_idx;
    site.x_km = ws.x_km;
    site.y_km = ws.y_km;
    for (int m = 0; m < kModeCount; ++m) {
      const NodeId& n = ws.node[static_cast<size_t>(m)];
      site.node[static_cast<size_t>(m)] = n.valid() ? n.v : kNoNode;
      site.bays[static_cast<size_t>(m)] = preset.bays[static_cast<size_t>(m)];
    }
    site.tanks.begin = static_cast<uint32_t>(out.tanks.size());
    for (uint32_t t = 0; t < ws.tanks.count; ++t) {
      const worldgen::WTank& wt = gen.tanks[ws.tanks.begin + t];
      const int mid = catalog.findMaterial(wt.material);
      if (mid < 0) return fail("site " + site.key + ": unknown tank material " + wt.material);
      if (catalog.materials[static_cast<size_t>(mid)].kind == MatKind::Pseudo)
        return fail("site " + site.key + ": pseudo material " + wt.material + " cannot own a tank");
      Tank tank;
      tank.key = site.key + "/" + wt.material;
      tank.site = sid;
      tank.material = static_cast<uint16_t>(mid);
      // The two role enums list Feed, Product, Internal, Both in one order.
      tank.role = static_cast<TankRole>(static_cast<uint8_t>(wt.role));
      tank.capacity_t = wt.capacity_t;
      tank.target_frac = wt.target_frac;
      const double dominant = std::max(wt.design_in_t_h, wt.design_out_t_h);
      tank.cover_days = dominant > 1e-12 ? wt.capacity_t / (dominant * 24.0) : 0.0;
      tank.design_in_t_h = wt.design_in_t_h;
      tank.design_out_t_h = wt.design_out_t_h;
      tank.piped_in = wt.piped_in;
      tank.piped_out = wt.piped_out;
      // §5.6 port export tanks: every port tank fed by a flow is a strategic
      // reserve — low-urgency buyers that only match sellers above 70% full.
      tank.export_buy = ws.preset == "PORT_TERMINAL" && tank.design_in_t_h > 1e-12;
      out.tanks.push_back(tank);
    }
    site.tanks.count = static_cast<uint32_t>(out.tanks.size()) - site.tanks.begin;

    site.processes.begin = static_cast<uint32_t>(out.processes.size());
    for (uint32_t p = 0; p < ws.processes.count; ++p) {
      const worldgen::WProcess& wp = gen.processes[ws.processes.begin + p];
      const int ti = catalog.findProcess(wp.type);
      if (ti < 0) return fail("site " + site.key + ": unknown process type " + wp.type);
      const ProcessType& type = catalog.process_types[static_cast<size_t>(ti)];

      Process proc;
      proc.site = sid;
      proc.type = static_cast<uint16_t>(ti);
      proc.design_rate_t_h = wp.design_rate_t_h;
      proc.schedule = wp.schedule;
      proc.tank_of.assign(catalog.materials.size(), TankId{});
      for (size_t m = 0; m < catalog.materials.size() && m < wp.tank_of.size(); ++m)
        proc.tank_of[m] = wp.tank_of[m];

      // Swing-train mix from the generator's mode shares: allocate the swing
      // unit's trains across modes by largest remainder so the counts sum to
      // the swing train total exactly.
      const uint8_t swing_trains =
          type.swing_unit >= 0 && type.swing_unit < static_cast<int>(type.units.size())
              ? type.units[static_cast<size_t>(type.swing_unit)].trains
              : static_cast<uint8_t>(1);
      const size_t nmodes = type.modes.size();
      proc.mode_share = wp.mode_share.size() == nmodes
                            ? wp.mode_share
                            : std::vector<double>(nmodes, 1.0 / static_cast<double>(nmodes));
      proc.mode_trains.assign(nmodes, 0);
      if (nmodes == 1) {
        proc.mode_trains[0] = swing_trains;
      } else {
        // Cumulative rounding: differences of the rounded cumulative shares
        // give a largest-remainder allocation that sums to swing_trains.
        double acc = 0.0;
        uint8_t prev = 0;
        for (size_t m = 0; m < nmodes; ++m) {
          acc += proc.mode_share[m] * swing_trains;
          const uint8_t cur = static_cast<uint8_t>(std::lround(acc));
          proc.mode_trains[m] = static_cast<uint8_t>(cur - prev);
          prev = cur;
        }
      }

      // Units in flow order from the catalog type; §3.2 overdesign on the
      // train capacity, exactly as buildWorld() pass 2.
      proc.units.begin = static_cast<uint32_t>(out.units.size());
      for (size_t us = 0; us < type.units.size(); ++us) {
        Unit unit;
        unit.process = ProcessId{static_cast<uint32_t>(out.processes.size())};
        unit.slot = static_cast<uint8_t>(us);
        unit.cap_per_train_t_h = kUnitOverdesign * proc.design_rate_t_h / type.units[us].trains;
        out.units.push_back(unit);
      }
      proc.units.count = static_cast<uint32_t>(out.units.size()) - proc.units.begin;
      out.processes.push_back(proc);
    }
    site.processes.count = static_cast<uint32_t>(out.processes.size()) - site.processes.begin;
    out.sites.push_back(site);
  }

  // -- pipelines.
  out.pipelines.reserve(gen.pipelines.size());
  for (const worldgen::WPipeline& pl : gen.pipelines) {
    if (!pl.from.valid() || !pl.to.valid() || pl.from.v >= out.tanks.size() ||
        pl.to.v >= out.tanks.size())
      return fail("pipeline references an unknown tank");
    Pipeline p;
    p.from = pl.from;
    p.to = pl.to;
    p.material = out.tanks[pl.from.v].material;
    p.cap_t_h = pl.cap_t_h;
    out.pipelines.push_back(p);
  }

  // -- fleet: resolved class + home site. Vehicles serving the overseas leg
  // (home kOverseasSite) berth at the port — give them a real home site so
  // the sim's per-vehicle state always resolves.
  uint32_t port_home = 0;
  for (size_t ps = 0; ps < gen.sites.size(); ++ps)
    if (gen.sites[ps].preset == "PORT_TERMINAL") {
      port_home = static_cast<uint32_t>(ps);
      break;
    }
  for (const worldgen::WVehicleSpec& v : gen.fleet) {
    const int cls = catalog.findVehicle(v.cls);
    if (cls < 0) return fail("unknown vehicle class " + v.cls);
    World::FleetEntry fe;
    fe.cls = static_cast<uint16_t>(cls);
    fe.home =
        v.home.valid() && v.home.v < out.sites.size() ? SiteId{v.home.v} : SiteId{port_home};
    out.fleet.push_back(fe);
  }

  // -- contracts: preferred supplier pairs, by tank id.
  for (const worldgen::WContract& c : gen.contracts) {
    if (!c.buyer.valid() || !c.seller.valid() || c.buyer.v >= out.tanks.size() ||
        c.seller.v >= out.tanks.size())
      return fail("contract references an unknown tank");
    out.contracts.push_back({c.buyer, c.seller});
  }

  return true;
}

std::vector<std::string> realSimWarmup(const worldgen::GeneratedWorld& gen,
                                       const worldgen::CatalogView& /*view*/) {
  std::vector<std::string> errors;
  crx::Catalog catalog;
  std::string err;
  if (!loadCatalogFromDir(CRX_DATA_DIR, catalog, err)) {
    errors.push_back("warm-up: catalog load failed: " + err);
    return errors;
  }
  crx::sim::World world;
  if (!buildGeneratedWorld(catalog, gen, world, err)) {
    errors.push_back("warm-up: " + err);
    return errors;
  }
  std::shared_ptr<const crx::sim::World> shared =
      std::make_shared<const crx::sim::World>(std::move(world));
  auto sim = crx::sim::Sim::fromWorld(shared, err);
  if (sim == nullptr) {
    errors.push_back("warm-up: state init failed: " + err);
    return errors;
  }
  constexpr uint32_t kTicksPerHour = 4;  // kTickHours = 0.25
  sim->step(35 * 24 * kTicksPerHour);    // ramp-up: start-up transient excluded
  const crx::sim::World& w = sim->world();
  // TEMP DIAGNOSTIC: daily level trace for the dry-out suspects and their
  // suppliers — removed once the balance question is answered.
  if (std::getenv("CRX_WARMUP_DEBUG") != nullptr) {
    const size_t n = w.tanks.size();
    for (uint32_t i = 0; i < n; ++i) {
      const std::string& sn = w.sites[w.tanks[i].site.v].name;
      const std::string& mk = w.catalog.materials[w.tanks[i].material].key;
      if ((sn.find("Eastbrook") != std::string::npos && (mk == "LPG" || mk == "CAUSTIC")) ||
          (sn.find("Refinery A") != std::string::npos && mk == "LPG") ||
          (sn.find("Chlor-alkali") != std::string::npos && mk == "CAUSTIC")) {
        std::fprintf(stderr, "DBG tank %u %s/%s cap=%.1f level=%.2f\n", i, sn.c_str(),
                     mk.c_str(), w.tanks[i].capacity_t, sim->state().tank[i].level_t);
      }
    }
  }
  for (uint32_t day = 0; day < 7; ++day) {
    sim->step(24 * kTicksPerHour);
    const crx::sim::State& st = sim->state();
    if (std::getenv("CRX_WARMUP_DEBUG") != nullptr) {
      for (uint32_t i = 0; i < w.tanks.size(); ++i) {
        const std::string& sn = w.sites[w.tanks[i].site.v].name;
        const std::string& mk = w.catalog.materials[w.tanks[i].material].key;
        if ((sn.find("Eastbrook") != std::string::npos && (mk == "LPG" || mk == "CAUSTIC")) ||
            (sn.find("Refinery A") != std::string::npos && mk == "LPG") ||
            (sn.find("Chlor-alkali") != std::string::npos && mk == "CAUSTIC")) {
          std::fprintf(stderr, "DBG day %u tank %u %s/%s level=%.2f\n", day, i, sn.c_str(),
                       mk.c_str(), st.tank[i].level_t);
        }
      }
    }
    for (size_t p = 0; p < st.sink_starved.size(); ++p)
      if (st.sink_starved[p] != 0)
        errors.push_back("warm-up: " + w.sites[w.processes[p].site.v].name + "/" +
                         w.catalog.process_types[w.processes[p].type].key +
                         " starved during warm-up");
    for (size_t t = 0; t < w.tanks.size(); ++t)
      if (w.tanks[t].capacity_t > 0 && st.tank[t].level_t <= 1e-6)
        errors.push_back("warm-up: tank " + w.tanks[t].key + " ran dry during warm-up");
  }
  return errors;
}

}  // namespace sim
}  // namespace crx
