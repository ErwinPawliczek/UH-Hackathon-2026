// Chain Reaction — world construction from a hand-written spec (§4.3).
//
// Two passes: creation (sites → tanks → processes → units, with external
// streams bound to tanks by material) then derivation (tank capacities from
// cover days over the dominant design flow, unit train capacities from
// §3.2's 110 % overdesign).
#include "sim/world.h"

#include <algorithm>
#include <cmath>

namespace crx {
namespace sim {

int World::findSite(const std::string& key) const {
  for (size_t i = 0; i < sites.size(); ++i)
    if (sites[i].key == key) return static_cast<int>(i);
  return -1;
}

int World::findTank(const std::string& key) const {
  for (size_t i = 0; i < tanks.size(); ++i)
    if (tanks[i].key == key) return static_cast<int>(i);
  return -1;
}

namespace {

constexpr double kOverdesign = 1.10;  // §3.2: trains sized at 110 % of nameplate

}  // namespace

bool buildWorld(const Catalog& catalog, uint64_t seed, const WorldSpec& spec, World& out,
                std::string& error) {
  auto fail = [&](const std::string& msg) {
    error = msg;
    return false;
  };

  out = World{};
  out.catalog = catalog;
  out.seed = seed;
  out.schedules = {{1.0}};  // one flat schedule; shocks scale demand/supply

  // Pass 1 — create entities and bind external streams to tanks.
  for (const SiteSpec& ss : spec.sites) {
    if (out.findSite(ss.key) >= 0) return fail("duplicate site key " + std::string(ss.key));

    Site& site = out.sites.emplace_back();
    site.key = ss.key;
    site.name = ss.name;
    site.x_km = ss.x_km;
    site.y_km = ss.y_km;
    site.tanks.begin = static_cast<uint32_t>(out.tanks.size());
    site.processes.begin = static_cast<uint32_t>(out.processes.size());
    const SiteId sid{static_cast<uint32_t>(out.sites.size() - 1)};

    for (const TankSpec& ts : ss.tanks) {
      const int mid = catalog.findMaterial(ts.material);
      if (mid < 0) return fail("site " + site.key + ": unknown material " + ts.material);
      const MatKind kind = catalog.materials[static_cast<size_t>(mid)].kind;
      if (kind == MatKind::Pseudo)
        return fail("site " + site.key + ": pseudo material " + ts.material +
                    " cannot own a tank");
      if (ts.cover_days <= 0 || ts.target_frac < 0 || ts.target_frac > 1)
        return fail("site " + site.key + ": tank " + ts.material +
                    " needs cover_days > 0 and target_frac in [0,1]");
      Tank& t = out.tanks.emplace_back();
      t.key = site.key + "/" + ts.material;
      t.site = sid;
      t.material = static_cast<uint16_t>(mid);
      t.role = ts.role;
      t.cover_days = ts.cover_days;
      t.target_frac = ts.target_frac;
    }

    site.tanks.count = static_cast<uint32_t>(out.tanks.size()) - site.tanks.begin;

    for (const ProcSpec& ps : ss.procs) {
      const int ti = catalog.findProcess(ps.type);
      if (ti < 0) return fail("site " + site.key + ": unknown process type " + ps.type);
      const ProcessType& type = catalog.process_types[static_cast<size_t>(ti)];
      if (ps.design_t_h <= 0)
        return fail("site " + site.key + ": " + ps.type + " needs design_t_h > 0");

      Process& proc = out.processes.emplace_back();
      proc.site = sid;
      proc.type = static_cast<uint16_t>(ti);
      proc.design_rate_t_h = ps.design_t_h;
      proc.units.begin = static_cast<uint32_t>(out.units.size());
      proc.schedule = 0;
      proc.tank_of.assign(catalog.materials.size(), TankId{});

      // Mode mix: normalise swing-train counts into shares (M1: fixed mix).
      const size_t nmodes = type.modes.size();
      if (ps.trains_by_mode.size() != nmodes)
        return fail("site " + site.key + ": " + ps.type + " needs trains_by_mode for all " +
                    std::to_string(nmodes) + " mode(s)");
      double total = 0;
      for (const uint8_t n : ps.trains_by_mode) total += n;
      if (total == 0) return fail("site " + site.key + ": " + ps.type + " has no trains");
      proc.mode_share.resize(nmodes);
      for (size_t m = 0; m < nmodes; ++m)
        proc.mode_share[m] = static_cast<double>(ps.trains_by_mode[m]) / total;
      proc.mode_trains = ps.trains_by_mode;

      // Units in flow order, from the catalog type; capacities in pass 2.
      for (size_t us = 0; us < type.units.size(); ++us) {
        Unit& unit = out.units.emplace_back();
        unit.process = ProcessId{static_cast<uint32_t>(out.processes.size() - 1)};
        unit.slot = static_cast<uint8_t>(us);
      }
      proc.units.count = static_cast<uint32_t>(out.units.size()) - proc.units.begin;

      // Bind external streams to tanks: feed streams need a Feed/Both tank,
      // product streams a Product/Both tank, of the same material.
      const uint32_t t0 = site.tanks.begin, t1 = t0 + site.tanks.count;
      for (size_t m = 0; m < nmodes; ++m) {
        for (const Stream& s : type.net[m]) {
          if (s.slot >= kInternalStreamBase) continue;  // net is external-only; guard
          if (catalog.materials[s.slot].kind == MatKind::Pseudo) continue;
          if (proc.tank_of[s.slot].valid()) continue;
          for (uint32_t tk = t0; tk < t1; ++tk) {
            if (out.tanks[tk].material != s.slot) continue;
            const TankRole r = out.tanks[tk].role;
            const bool feed_ok = s.t_per_t < 0 && (r == TankRole::Feed || r == TankRole::Both);
            const bool prod_ok = s.t_per_t > 0 && (r == TankRole::Product || r == TankRole::Both);
            if (feed_ok || prod_ok) {
              proc.tank_of[s.slot] = TankId{tk};
              break;
            }
          }
          if (!proc.tank_of[s.slot].valid())
            return fail("site " + site.key + ": " + ps.type + " mode " + type.modes[m] +
                        " stream " + s.key + " has no matching tank");
        }
      }
    }

    site.processes.count = static_cast<uint32_t>(out.processes.size()) - site.processes.begin;
  }

  // Pass 2 — derive design flows and unit capacities from the mode mixes.
  for (size_t p = 0; p < out.processes.size(); ++p) {
    const Process& proc = out.processes[p];
    const ProcessType& type = catalog.process_types[proc.type];

    for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
      const double share = proc.mode_share[m];
      if (share <= 0) continue;
      for (const Stream& s : type.net[m]) {
        if (s.slot >= kInternalStreamBase) continue;
        if (catalog.materials[s.slot].kind == MatKind::Pseudo) continue;
        const TankId tank = proc.tank_of[s.slot];
        if (!tank.valid()) continue;
        if (s.t_per_t < 0)
          out.tanks[tank.v].design_out_t_h += -s.t_per_t * proc.design_rate_t_h * share;
        else
          out.tanks[tank.v].design_in_t_h += s.t_per_t * proc.design_rate_t_h * share;
      }
    }

    // §3.2: trains together are sized at 110 % of the process nameplate
    // (nameplate is in basis t/h, so unit capacity is basis t/h per train).
    for (uint32_t u = proc.units.begin; u < rangeEnd(proc.units); ++u) {
      const UnitSlot& slot = type.units[out.units[u].slot];
      out.units[u].cap_per_train_t_h = kOverdesign * proc.design_rate_t_h / slot.trains;
    }
  }

  // Tank capacities: cover days over the dominant design flow (§4.3). A tank
  // no on-site process touches (pure pipeline relay) sizes from its
  // pipeline's capacity instead.
  for (const PipeSpec& ps : spec.pipes) {
    const int from = out.findTank(ps.from), to = out.findTank(ps.to);
    if (from < 0 || to < 0)
      return fail("pipeline references unknown tank " + std::string(ps.from) + " → " +
                  std::string(ps.to));
    out.tanks[static_cast<size_t>(from)].piped_out = true;
    out.tanks[static_cast<size_t>(to)].piped_in = true;
  }
  for (size_t i = 0; i < out.tanks.size(); ++i) {
    Tank& t = out.tanks[i];
    const double dominant = std::max(t.design_in_t_h, t.design_out_t_h);
    if (dominant > 0) {
      t.capacity_t = dominant * 24.0 * t.cover_days;
      continue;
    }
    double cap = 0;
    for (const PipeSpec& ps : spec.pipes)
      if (out.findTank(ps.from) == static_cast<int>(i) ||
          out.findTank(ps.to) == static_cast<int>(i))
        cap = std::max(cap, ps.cap_t_h);
    if (cap <= 0)
      return fail("tank " + t.key + " is touched by no process or pipeline");
    t.capacity_t = cap * 24.0 * t.cover_days;
  }

  // Pass 3 — pipelines, with material consistency and positivity checks.
  out.pipelines.reserve(spec.pipes.size());
  for (const PipeSpec& ps : spec.pipes) {
    const int from = out.findTank(ps.from), to = out.findTank(ps.to);
    const Tank& ft = out.tanks[static_cast<size_t>(from)];
    const Tank& tt = out.tanks[static_cast<size_t>(to)];
    const int mid = catalog.findMaterial(ps.material);
    if (mid < 0)
      return fail("pipeline " + std::string(ps.from) + "→" + ps.to + ": unknown material " +
                  ps.material);
    if (ft.material != mid || tt.material != mid)
      return fail("pipeline " + std::string(ps.from) + "→" + ps.to + ": material " + ps.material +
                  " does not match both tanks");
    if (ps.cap_t_h <= 0)
      return fail("pipeline " + std::string(ps.from) + "→" + ps.to + " needs cap_t_h > 0");
    Pipeline& pl = out.pipelines.emplace_back();
    pl.from = TankId{static_cast<uint32_t>(from)};
    pl.to = TankId{static_cast<uint32_t>(to)};
    pl.material = static_cast<uint16_t>(mid);
    pl.cap_t_h = ps.cap_t_h;
  }

  // Pass 4 — route graph (§4.3/§5.7): one road node per site, straight
  // polylines for the declared roads, bays per site per mode, and the
  // resolved fleet and contracts. Generated worlds (M3) add river/sea nodes
  // and wiggled polylines through the same fields.
  out.nodes.reserve(out.sites.size());
  for (size_t i = 0; i < out.sites.size(); ++i) {
    Site& s = out.sites[i];
    RouteNode n;
    n.x_km = s.x_km;
    n.y_km = s.y_km;
    n.site = static_cast<int>(i);
    s.node[modeIndex(crx::Mode::Road)] = static_cast<uint32_t>(out.nodes.size());
    out.nodes.push_back(n);
  }
  for (Site& s : out.sites) {
    s.bays[modeIndex(crx::Mode::Road)] = static_cast<uint8_t>(spec.road_bays);
    s.bays[modeIndex(crx::Mode::River)] = static_cast<uint8_t>(spec.river_bays);
    s.bays[modeIndex(crx::Mode::Sea)] = static_cast<uint8_t>(spec.sea_bays);
  }
  for (const RoadSpec& rs : spec.roads) {
    const int a = out.findSite(rs.from), b = out.findSite(rs.to);
    if (a < 0 || b < 0 || a == b)
      return fail("road " + std::string(rs.from) + "→" + rs.to + ": unknown or same site");
    if (rs.speed_kmh <= 0)
      return fail("road " + std::string(rs.from) + "→" + rs.to + " needs speed_kmh > 0");
    const uint32_t na = out.sites[static_cast<size_t>(a)].node[modeIndex(crx::Mode::Road)];
    const uint32_t nb = out.sites[static_cast<size_t>(b)].node[modeIndex(crx::Mode::Road)];
    RouteEdge e;
    e.a = na;
    e.b = nb;
    e.mode = crx::Mode::Road;
    e.length_km = std::hypot(out.sites[static_cast<size_t>(a)].x_km -
                                 out.sites[static_cast<size_t>(b)].x_km,
                             out.sites[static_cast<size_t>(a)].y_km -
                                 out.sites[static_cast<size_t>(b)].y_km);
    e.speed_kmh = rs.speed_kmh;
    e.polyline = Range<uint32_t>{
        static_cast<uint32_t>(out.polyline_xy.size() / 2), 2};
    out.polyline_xy.push_back(out.nodes[na].x_km);
    out.polyline_xy.push_back(out.nodes[na].y_km);
    out.polyline_xy.push_back(out.nodes[nb].x_km);
    out.polyline_xy.push_back(out.nodes[nb].y_km);
    out.edges.push_back(e);
  }
  for (const FleetSpec& fs : spec.fleet) {
    const int cls = catalog.findVehicle(fs.vehicle_class);
    const int home = out.findSite(fs.home_site);
    if (cls < 0) return fail("fleet: unknown vehicle class " + std::string(fs.vehicle_class));
    if (home < 0) return fail("fleet: unknown home site " + std::string(fs.home_site));
    World::FleetEntry f;
    f.cls = static_cast<uint16_t>(cls);
    f.home = SiteId{static_cast<uint32_t>(home)};
    out.fleet.push_back(f);
  }
  for (const ContractSpec& cs : spec.contracts) {
    const int buyer = out.findTank(cs.buyer), seller = out.findTank(cs.seller);
    if (buyer < 0 || seller < 0)
      return fail("contract " + std::string(cs.buyer) + "←" + cs.seller + ": unknown tank");
    World::Contract c;
    c.buyer = TankId{static_cast<uint32_t>(buyer)};
    c.seller = TankId{static_cast<uint32_t>(seller)};
    out.contracts.push_back(c);
  }

  return true;
}

}  // namespace sim
}  // namespace crx
