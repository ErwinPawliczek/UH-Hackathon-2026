// PetroGrid engine — plant economics for the market rules (margin_control).
#ifndef CRX_SIM_MARKET_H
#define CRX_SIM_MARKET_H

#include "sim/state.h"
#include "sim/world.h"

namespace crx {
namespace sim {

// Energy prices used by production's energy booking and by plant margins.
constexpr double kMarketHeatUsdGJ = 8.0;
constexpr double kMarketPowerUsdMWh = 80.0;
// The margin signal is 1 while a unit keeps this share of its base-price
// margin, and falls to 0 as the margin goes to nothing.
constexpr double kMarginFullShare = 0.5;

// Recomputes, for every plant, what a tonne of basis costs to make at the
// prices its feeds cost now and what its products fetch, and from that:
//   State::cost_delta[tank]    how much dearer (as a share of the base price)
//                              the plant's products have become to make;
//   State::ask_floor[tank]     feed and energy cost per tonne of the product;
//   State::margin_signal[proc] 1 while the margin is healthy, falling to 0 as
//                              it goes to nothing (control turns the plant
//                              down to its minimum rate, never below);
//   State::proc_margin[proc]   margin as a share of base product value.
// A feed that arrives by pipeline or from another unit on site costs what
// its maker's product costs (with that site's markup on a pipeline), so a
// price rise moves down the chain a stage at a time. Does nothing unless the
// world switched margin_control on.
void stepMarket(const World& world, State& state);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_MARKET_H
