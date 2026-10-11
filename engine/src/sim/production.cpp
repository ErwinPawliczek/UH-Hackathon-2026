// Chain Reaction — §5.4 production, energy booking and sink accounting.
#include "sim/production.h"

#include "sim/words.h"

#include <algorithm>
#include <cmath>

namespace crx {
namespace sim {

namespace {

constexpr double kEnergyPriceGJ = 8.0;   // $/GJ purchased heat (§3.1 note)
constexpr double kPowerPriceMWh = 80.0;  // $/MWh
constexpr double kServedEps = 0.999;     // below this share a sink is starved

// Design real output in t/h at the world's mode mix, for the production
// index KPI: real output ÷ design output.
double designRealOut(const World& world, const Process& proc) {
  const ProcessType& type = world.catalog.process_types[proc.type];
  double out = 0;
  for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
    if (proc.mode_share[m] <= 0) continue;
    for (const Stream& s : type.net[m]) {
      if (s.slot >= kInternalStreamBase || s.t_per_t <= 0) continue;
      if (world.catalog.materials[s.slot].kind == MatKind::Pseudo) continue;
      out += s.t_per_t * proc.mode_share[m];
    }
  }
  return out * proc.design_rate_t_h;
}

// Base price of the process's first real feed material (prices unmet sink
// demand); 1.0 when unpriced.
double feedPrice(const World& world, const Process& proc) {
  const ProcessType& type = world.catalog.process_types[proc.type];
  for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
    if (proc.mode_share[m] <= 0) continue;
    for (const Stream& s : type.net[m])
      if (s.t_per_t < 0 && s.slot < kInternalStreamBase &&
          world.catalog.materials[s.slot].kind != MatKind::Pseudo)
        return world.catalog.materials[s.slot].base_price;
  }
  return 1.0;
}

}  // namespace

void stepProduction(const World& world, State& state, const std::vector<ControlDecision>& control,
                    std::vector<ProductionResult>& out, Recorder& rec) {
  const double dt = kTickHours;
  out.assign(world.processes.size(), {});

  // FUEL_GAS credit per tonne (§3.1 note; LHV comes from the catalog data).
  double fuel_lhv = 48.0;
  const int fuel_idx = world.catalog.findMaterial("FUEL_GAS");
  if (fuel_idx >= 0) fuel_lhv = world.catalog.materials[static_cast<size_t>(fuel_idx)].lhv_gj_t;

  double made = 0, made_design = 0;

  for (size_t p = 0; p < world.processes.size(); ++p) {
    const Process& proc = world.processes[p];
    const ProcessType& type = world.catalog.process_types[proc.type];
    ProductionResult& r = out[p];
    const double rate = state.proc[p].rate_t_h;
    const double demand_dt = type.boundary == Boundary::Sink ? control[p].target * dt : 0.0;

    if (rate <= 1e-9) {
      // A stopped sink still books its demand as unmet (service-level KPI).
      if (type.boundary == Boundary::Sink && demand_dt > 1e-9) {
        state.proc_totals[p].demand_t += demand_dt;
        state.cum_demand_t += demand_dt;
        state.cum_unmet_t += demand_dt;
        state.cum_unmet_usd += demand_dt * feedPrice(world, proc);
        state.ledger[proc.site.v].unmet_t += demand_dt;
        if (state.sink_starved[p] == 0) {
          state.stockouts += 1;
          state.sink_starved[p] = 1;
          logEvent(rec, state.tick, "stockout", world.sites[proc.site.v].key, type.key,
                   world.sites[proc.site.v].name + " cannot get enough " +
                       materialWord(type.basis_key));
        }
      }
      continue;
    }

    // Per-tank deltas over the mode mix (§5.4 "summed over the mode mix").
    // Pseudo streams never touch tanks: they cross the model boundary
    // directly and book as loss (out) or supply (in).
    std::vector<std::pair<TankId, double>> deltas;  // tank → tonnes (+ fills)
    for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
      const double share = proc.mode_share[m];
      if (share <= 0) continue;
      const double tonnes = rate * share * dt;  // tonnes of mode-m basis
      for (const Stream& s : type.net[m]) {
        if (s.slot >= kInternalStreamBase) continue;
        const double t = s.t_per_t * tonnes;
        if (world.catalog.materials[s.slot].kind == MatKind::Pseudo) {
          if (t > 0) {
            r.pseudo_out_t += t;
            if (static_cast<int>(s.slot) == fuel_idx) r.fuel_gas_t += t;
          } else {
            r.pseudo_in_t += -t;
          }
          continue;
        }
        const TankId tank = proc.tank_of[s.slot];
        if (tank.valid()) deltas.emplace_back(tank, t);
      }
      // Energy booked per unit recipe, per tonne of basis (§5.4).
      for (const UnitSlot& slot : type.units) {
        if (m >= slot.by_mode.size()) continue;
        r.heat_gj += slot.by_mode[m].heat_gj * tonnes;
        r.power_mwh += slot.by_mode[m].power_mwh * tonnes;
      }
    }

    // §5.4 rationing: if any tank cannot supply or accept its share, the
    // whole process scales down for this tick.
    double scale = 1.0;
    for (const auto& [tank, delta] : deltas) {
      const double level = state.tank[tank.v].level_t;
      if (delta < -1e-12) {
        scale = std::min(scale, level / -delta);
      } else if (delta > 1e-12) {
        if (world.tanks[tank.v].reject_when_full) continue;  // overflows instead of limiting
        scale = std::min(scale, std::max(0.0, world.tanks[tank.v].capacity_t - level) / delta);
      }
    }
    scale = std::clamp(scale, 0.0, 1.0);
    r.scale = scale;

    for (const auto& [tank, delta] : deltas) {
      double applied = delta * scale;
      TankState& ts = state.tank[tank.v];
      if (applied > 0 && world.tanks[tank.v].reject_when_full) {
        // Store what fits; the rest is rejected. It was made from real feed,
        // so it leaves the system as loss (a source just makes less).
        const double room = std::max(0.0, world.tanks[tank.v].capacity_t - ts.level_t);
        const double rejected = std::max(0.0, applied - room);
        if (rejected > 0) {
          ts.rejected_t += rejected;
          if (type.boundary != Boundary::Source) state.cum_loss_t += rejected;
          applied -= rejected;
        }
      }
      ts.level_t = std::max(0.0, std::min(ts.level_t + applied, world.tanks[tank.v].capacity_t));
      if (applied < 0) {
        r.real_in_t += -applied;
        state.ledger[world.tanks[tank.v].site.v].consumed_t += -applied;
      } else {
        r.real_out_t += applied;
        state.ledger[world.tanks[tank.v].site.v].produced_t += applied;
      }
    }

    // Energy booking with the FUEL_GAS credit (§5.4), scaled with the
    // rationing factor so booked cost tracks actual throughput.
    const double heat = r.heat_gj * scale;
    const double power = r.power_mwh * scale;
    r.purchased_gj = std::max(0.0, heat - r.fuel_gas_t * scale * fuel_lhv);
    const double cost = r.purchased_gj * kEnergyPriceGJ + power * kPowerPriceMWh;
    state.cum_energy_usd += cost;
    state.ledger[proc.site.v].energy_cost += cost;

    // Boundary accounting (§12 test 2 works on these accumulators).
    state.cum_loss_t += r.pseudo_out_t * scale;
    state.cum_supplied_t += r.pseudo_in_t * scale;
    if (type.boundary == Boundary::Source) state.cum_supplied_t += r.real_out_t;

    if (type.boundary == Boundary::Sink) {
      const double served = r.real_in_t;
      state.proc_totals[p].demand_t += demand_dt;
      state.proc_totals[p].served_t += std::min(served, demand_dt);
      state.cum_demand_t += demand_dt;
      state.cum_consumed_t += served;
      const double unmet = std::max(0.0, demand_dt - served);
      if (unmet > 1e-9) {
        state.cum_unmet_t += unmet;
        state.cum_unmet_usd += unmet * feedPrice(world, proc);
        state.ledger[proc.site.v].unmet_t += unmet;
      }
      // Stockout logging on the falling edge of service (§7.2).
      const bool starved = demand_dt > 1e-9 && served < kServedEps * demand_dt;
      if (starved && state.sink_starved[p] == 0) {
        state.stockouts += 1;
        logEvent(rec, state.tick, "stockout", world.sites[proc.site.v].key, type.key,
                 world.sites[proc.site.v].name + " cannot get enough " +
                     materialWord(type.basis_key));
      }
      state.sink_starved[p] = starved ? 1 : 0;
    }

    const double design_out = designRealOut(world, proc);
    if (design_out > 0) {
      made += r.real_out_t / dt;
      made_design += design_out;
    }
  }

  if (made_design > 0) state.last_production_index = made / made_design;
}

}  // namespace sim
}  // namespace crx
