// Chain Reaction — window accounting implementation.
#include "sim/window.h"

#include <nlohmann/json.hpp>

namespace crx {
namespace sim {

namespace {

bool isDown(ProcStatus s) { return s == ProcStatus::Shutdown || s == ProcStatus::Restarting; }

}  // namespace

double inventoryUsd(const World& world, const State& state) {
  double usd = 0;
  for (size_t t = 0; t < world.tanks.size(); ++t)
    usd += state.tank[t].level_t * world.catalog.materials[world.tanks[t].material].base_price;
  for (const VehicleState& v : state.vehicle)
    if (v.cargo_t > 0) usd += v.cargo_t * world.catalog.materials[v.cargo_material].base_price;
  return usd;
}

WindowReport runWindow(Sim& sim, uint32_t ticks) {
  const World& w = sim.world();
  const State before = sim.state();  // the opening balances
  WindowReport r;
  r.from_tick = before.tick;
  r.inventory_usd_start = inventoryUsd(w, before);

  for (uint32_t p = 0; p < w.processes.size(); ++p) {
    const Boundary b = w.catalog.process_types[w.processes[p].type].boundary;
    if (b == Boundary::Sink) {
      WindowCustomer c;
      c.process = p;
      c.dry_at_start = before.sink_starved[p] != 0;
      r.customers.push_back(c);
    } else if (b == Boundary::None) {
      WindowPlant pl;
      pl.process = p;
      pl.down_at_start = isDown(before.proc[p].status);
      r.plants.push_back(pl);
    }
  }

  // Tick by tick, only to catch the first time each thing goes wrong; the
  // tonnes, dollars and hours come from the running totals afterwards.
  for (uint32_t i = 0; i < ticks; ++i) {
    sim.step(1);
    const State& st = sim.state();
    for (WindowCustomer& c : r.customers)
      if (c.first_dry_tick == 0 && st.sink_starved[c.process] != 0) c.first_dry_tick = st.tick;
    for (WindowPlant& pl : r.plants)
      if (pl.first_down_tick == 0 && isDown(st.proc[pl.process].status))
        pl.first_down_tick = st.tick;
  }

  const State& after = sim.state();
  r.to_tick = after.tick;
  r.demand_t = after.cum_demand_t - before.cum_demand_t;
  r.unmet_t = after.cum_unmet_t - before.cum_unmet_t;
  r.unmet_usd = after.cum_unmet_usd - before.cum_unmet_usd;
  r.freight_usd = after.cum_freight_usd - before.cum_freight_usd;
  r.energy_usd = after.cum_energy_usd - before.cum_energy_usd;
  r.shutdown_h = after.cum_shutdown_h - before.cum_shutdown_h;
  r.inventory_usd_end = inventoryUsd(w, after);
  double t0 = 0, usd0 = 0, t1 = 0, usd1 = 0;
  Recorder::rejectedTotals(w, before, t0, usd0);
  Recorder::rejectedTotals(w, after, t1, usd1);
  r.rejected_t = t1 - t0;
  r.rejected_usd = usd1 - usd0;
  r.service = r.demand_t > 0 ? 1.0 - r.unmet_t / r.demand_t : 1.0;
  for (WindowCustomer& c : r.customers) {
    c.demand_t = after.proc_totals[c.process].demand_t - before.proc_totals[c.process].demand_t;
    c.served_t = after.proc_totals[c.process].served_t - before.proc_totals[c.process].served_t;
  }
  for (WindowPlant& pl : r.plants)
    pl.down_h = after.proc_totals[pl.process].down_h - before.proc_totals[pl.process].down_h;
  return r;
}

std::string windowJson(const World& world, const WindowReport& r) {
  using nlohmann::json;
  const auto tickOrNull = [](uint64_t t) { return t == 0 ? json(nullptr) : json(t); };

  json customers = json::array();
  for (const WindowCustomer& c : r.customers) {
    const Process& proc = world.processes[c.process];
    const ProcessType& type = world.catalog.process_types[proc.type];
    const Site& site = world.sites[proc.site.v];
    customers.push_back({{"site", site.key},
                         {"site_index", proc.site.v},
                         {"name", site.name},
                         {"process", type.key},
                         {"process_name", type.name},
                         {"material", type.basis_key},
                         {"demand_t", c.demand_t},
                         {"served_t", c.served_t},
                         {"service", c.demand_t > 0 ? c.served_t / c.demand_t : 1.0},
                         {"first_dry_tick", tickOrNull(c.first_dry_tick)},
                         {"dry_at_start", c.dry_at_start}});
  }
  json plants = json::array();
  for (const WindowPlant& pl : r.plants) {
    const Process& proc = world.processes[pl.process];
    const ProcessType& type = world.catalog.process_types[proc.type];
    const Site& site = world.sites[proc.site.v];
    plants.push_back({{"site", site.key},
                      {"site_index", proc.site.v},
                      {"name", site.name},
                      {"process", type.key},
                      {"process_name", type.name},
                      {"down_h", pl.down_h},
                      {"first_down_tick", tickOrNull(pl.first_down_tick)},
                      {"down_at_start", pl.down_at_start}});
  }
  const json doc = {{"from_tick", r.from_tick},
                    {"to_tick", r.to_tick},
                    {"totals",
                     {{"service", r.service},
                      {"demand_t", r.demand_t},
                      {"unmet_t", r.unmet_t},
                      {"unmet_usd", r.unmet_usd},
                      {"freight_usd", r.freight_usd},
                      {"energy_usd", r.energy_usd},
                      {"shutdown_h", r.shutdown_h},
                      {"rejected_t", r.rejected_t},
                      {"rejected_usd", r.rejected_usd},
                      {"inventory_usd", r.inventory_usd_end},
                      {"inventory_change_usd", r.inventory_usd_end - r.inventory_usd_start}}},
                    {"customers", customers},
                    {"plants", plants}};
  return doc.dump();
}

}  // namespace sim
}  // namespace crx
