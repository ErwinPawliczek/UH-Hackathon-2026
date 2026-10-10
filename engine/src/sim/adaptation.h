// Chain Reaction — §5.8 adaptation: the three learned tank parameters.
// lead_time and pickup_gap are running averages (weight 0.2 on the newest
// observation) clamped to 0.5–4× their world-initial values; caution rises
// 1.25× each time a tank runs dry and stops a process, and decays back
// toward 1 with a 30-day time constant, clamped to [1, 2]. The global switch
// (State::adaptation) turns all of it off for comparison runs (§5.8).
#ifndef CRX_SIM_ADAPTATION_H
#define CRX_SIM_ADAPTATION_H

#include "sim/state.h"
#include "sim/world.h"

namespace crx {
namespace sim {

constexpr double kAdaptWeight = 0.2;      // weight of the newest observation
constexpr double kCautionBump = 1.25;     // per dry run (§5.8)
constexpr double kCautionTauH = 30 * 24;  // 30-day decay time constant

// A delivery landed: observe order-to-delivery hours on the buyer tank.
void onDelivery(const World& world, State& state, uint32_t buyer_tank, double observed_h);

// A pickup finished loading from a seller product tank: observe the hours
// since the previous pickup.
void onPickup(const World& world, State& state, uint32_t seller_tank, uint64_t now_tick);

// The tank ran dry and stopped its process (§5.3 → §5.8 caution bump).
void onDryFeed(const World& world, State& state, uint32_t feed_tank);

// Per-tick decay of caution toward 1 (§5.8). Call every tick; no-op when
// adaptation is off.
void stepAdaptation(const World& world, State& state);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_ADAPTATION_H
