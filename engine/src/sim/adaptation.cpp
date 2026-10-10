// Chain Reaction — §5.8 adaptation implementation.
#include "sim/adaptation.h"

#include <algorithm>
#include <cmath>

namespace crx {
namespace sim {

namespace {

// Running average with weight 0.2 on the newest observation, clamped to
// 0.5–4× the world-initial value (§5.8).
void observe(double& value, double init_value, double observed) {
  value = (1.0 - kAdaptWeight) * value + kAdaptWeight * observed;
  value = std::clamp(value, 0.5 * init_value, 4.0 * init_value);
}

}  // namespace

void onDelivery(const World& world, State& state, uint32_t buyer_tank, double observed_h) {
  if (!state.adaptation) return;
  const Tank& tk = world.tanks[buyer_tank];
  TankState& ts = state.tank[buyer_tank];
  observe(ts.lead_time_h, tk.init_lead_time_h, observed_h);
}

void onPickup(const World& world, State& state, uint32_t seller_tank, uint64_t now_tick) {
  if (!state.adaptation) return;
  const Tank& tk = world.tanks[seller_tank];
  TankState& ts = state.tank[seller_tank];
  if (ts.last_pickup_tick != 0) {
    const double gap_h = static_cast<double>(now_tick - ts.last_pickup_tick) * kTickHours;
    observe(ts.pickup_gap_h, tk.init_pickup_gap_h, gap_h);
  }
  ts.last_pickup_tick = now_tick;
}

void onDryFeed(const World& world, State& state, uint32_t feed_tank) {
  if (!state.adaptation) return;
  TankState& ts = state.tank[feed_tank];
  ts.caution = std::clamp(ts.caution * kCautionBump, 1.0, 2.0);
  (void)world;
}

void stepAdaptation(const World& world, State& state) {
  if (!state.adaptation) return;
  // Excess caution decays with a 30-day time constant: each tick removes a
  // dt/τ fraction of the excess over 1 (§5.8).
  for (size_t t = 0; t < world.tanks.size(); ++t) {
    TankState& ts = state.tank[t];
    if (ts.caution > 1.0)
      ts.caution = std::max(1.0, ts.caution - (ts.caution - 1.0) * kTickHours / kCautionTauH);
  }
}

}  // namespace sim
}  // namespace crx
