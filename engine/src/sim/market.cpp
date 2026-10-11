// PetroGrid engine — plant economics for the market rules: implementation.
#include "sim/market.h"

#include <algorithm>
#include <cmath>

namespace crx {
namespace sim {

void stepMarket(const World& world, State& state) {
  if (!state.margin_control) return;
  const Catalog& catalog = world.catalog;
  const size_t n_tanks = world.tanks.size();

  // What each tank's contents are worth to the unit that draws on them.
  // Bought by vehicle: the rolling price paid. Otherwise the maker's price
  // from the last pass (base x (1 + cost_delta), not under its cost).
  std::vector<int> pipe_from(n_tanks, -1);
  for (const Pipeline& pipe : world.pipelines) pipe_from[pipe.to.v] = static_cast<int>(pipe.from.v);
  const auto makerPrice = [&](uint32_t t) {
    const double base = catalog.materials[world.tanks[t].material].base_price;
    return std::max(base * (1.0 + state.cost_delta[t]), state.ask_floor[t]);
  };
  const auto feedValue = [&](uint32_t t) {
    const double base = catalog.materials[world.tanks[t].material].base_price;
    if (pipe_from[t] >= 0) {
      const uint32_t up = static_cast<uint32_t>(pipe_from[t]);
      return makerPrice(up) * (1.0 + state.site_markup[world.tanks[up].site.v]);
    }
    if (world.tanks[t].design_in_t_h > 0.0) return makerPrice(t);  // made on site
    return state.tank[t].paid_avg > 0.0 ? state.tank[t].paid_avg : base;
  };
  const auto productValue = [&](uint32_t t) {
    return state.tank[t].sold_avg > 0.0 ? state.tank[t].sold_avg : makerPrice(t);
  };

  std::vector<double> delta_sum(n_tanks, 0.0), floor_sum(n_tanks, 0.0), weight(n_tanks, 0.0);
  for (size_t p = 0; p < world.processes.size(); ++p) {
    const Process& proc = world.processes[p];
    const ProcessType& type = catalog.process_types[proc.type];
    state.margin_signal[p] = 1.0;
    state.proc_margin[p] = 0.0;
    if (type.boundary != Boundary::None) continue;

    double cost = 0, cost_base = 0, revenue = 0, revenue_base = 0, energy_usd = 0;
    for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
      const double share = proc.mode_share[m];
      if (share <= 0) continue;
      for (const UnitSlot& slot : type.units) {
        if (m >= slot.by_mode.size()) continue;
        const double energy = share * (slot.by_mode[m].heat_gj * kMarketHeatUsdGJ +
                                       slot.by_mode[m].power_mwh * kMarketPowerUsdMWh);
        cost += energy;
        cost_base += energy;
        energy_usd += energy;
      }
      for (const Stream& s : type.net[m]) {
        if (s.slot >= kInternalStreamBase) continue;
        if (catalog.materials[s.slot].kind == MatKind::Pseudo) continue;
        const TankId tank = proc.tank_of[s.slot];
        if (!tank.valid()) continue;
        const double base = catalog.materials[s.slot].base_price;
        const double y = s.t_per_t * share;
        if (y < 0) {
          cost += -y * feedValue(tank.v);
          cost_base += -y * base;
        } else {
          revenue += y * productValue(tank.v);
          revenue_base += y * base;
        }
      }
    }
    state.proc_revenue[p] = revenue;
    state.proc_feed_cost[p] = cost - energy_usd;
    state.proc_energy[p] = energy_usd;
    if (revenue_base <= 0.0) continue;

    // Dearer feed raises the price of everything the unit makes by the same
    // share of its base price; the cost itself is the floor.
    const double delta = std::clamp((cost - cost_base) / revenue_base, -0.3, 1.0);
    const double floor_ratio = cost / revenue_base;
    for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
      if (proc.mode_share[m] <= 0) continue;
      for (const Stream& s : type.net[m]) {
        if (s.slot >= kInternalStreamBase || s.t_per_t <= 0) continue;
        if (catalog.materials[s.slot].kind == MatKind::Pseudo) continue;
        const TankId tank = proc.tank_of[s.slot];
        if (!tank.valid()) continue;
        const double w = s.t_per_t * proc.mode_share[m] * proc.design_rate_t_h;
        delta_sum[tank.v] += w * delta;
        floor_sum[tank.v] += w * floor_ratio * catalog.materials[s.slot].base_price;
        weight[tank.v] += w;
      }
    }

    const double margin = revenue - cost, margin_base = revenue_base - cost_base;
    state.proc_margin[p] = margin / revenue_base;
    // Units whose margin is thin even at base prices are left alone: the
    // catalog's prices, not the market, would be holding them back.
    if (margin_base > 0.02 * revenue_base) {
      const double x = std::clamp(margin / (0.5 * margin_base), 0.0, 1.0);
      state.margin_signal[p] = x * x * (3.0 - 2.0 * x);
    }
  }
  for (size_t t = 0; t < n_tanks; ++t) {
    if (weight[t] <= 0.0) continue;
    state.cost_delta[t] = delta_sum[t] / weight[t];
    state.ask_floor[t] = floor_sum[t] / weight[t];
  }
}

}  // namespace sim
}  // namespace crx
