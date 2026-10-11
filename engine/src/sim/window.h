// Chain Reaction — accounting for a window of a run.
//
// Steps a run forward and reports what happened in exactly that stretch:
// money and service for the window only (not since tick 0), each customer's
// demand against what it was served and the first tick it ran short, and
// each plant's hours down and the first tick it stopped. The impact forecast
// runs two futures through this and subtracts them.
#ifndef CRX_SIM_WINDOW_H
#define CRX_SIM_WINDOW_H

#include "sim/sim.h"

#include <cstdint>
#include <string>
#include <vector>

namespace crx {
namespace sim {

struct WindowCustomer {
  uint32_t process = 0;         // a boundary sink
  double demand_t = 0, served_t = 0;
  uint64_t first_dry_tick = 0;  // first tick in the window it could not serve demand; 0 = never
  bool dry_at_start = false;    // already short when the window opened
};

struct WindowPlant {
  uint32_t process = 0;          // neither source nor sink
  double down_h = 0;             // hours in Shutdown or Restarting
  uint64_t first_down_tick = 0;  // first tick in the window it was down; 0 = never
  bool down_at_start = false;
};

struct WindowReport {
  uint64_t from_tick = 0, to_tick = 0;
  double service = 1;  // 1 - unmet / demand over the window
  double demand_t = 0, unmet_t = 0, unmet_usd = 0;
  double freight_usd = 0, energy_usd = 0, shutdown_h = 0;
  // Stock on hand (tanks and cargo aboard vehicles) at catalog base prices,
  // when the window opened and when it closed. Unpriced site-internal
  // materials count as zero.
  double inventory_usd_start = 0, inventory_usd_end = 0;
  // Product thrown away at tanks that reject when full, in the window.
  double rejected_t = 0, rejected_usd = 0;
  std::vector<WindowCustomer> customers;
  std::vector<WindowPlant> plants;
};

// Value of everything in tanks and aboard vehicles at catalog base prices.
double inventoryUsd(const World& world, const State& state);

// Advances `sim` by `ticks` and accounts for the window it just ran.
WindowReport runWindow(Sim& sim, uint32_t ticks);

// The report as one JSON document, with site and process names resolved.
std::string windowJson(const World& world, const WindowReport& report);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_WINDOW_H
