// Chain Reaction — §5.2 tank signals: f (feed), u (upstream), h (product
// room). Three smooth curves per tank per tick; the control system governs
// every process rate with them.
#ifndef CRX_SIM_SIGNALS_H
#define CRX_SIM_SIGNALS_H

#include "sim/state.h"
#include "sim/world.h"

#include <vector>

namespace crx {
namespace sim {

// The S-curve ranges of the three tank signals (§5.2): x below `lo` gives 0,
// above `hi` gives 1. Feed and room are in pickup gaps, urgency in lead times.
constexpr double kFeedLo = 0.25, kFeedHi = 1.25;
constexpr double kRoomLo = 0.10, kRoomHi = 1.00;
constexpr double kUrgencyLo = 1.0, kUrgencyHi = 2.5;

struct TankSignals {
  double f = 1, u = 0, h = 1;
};

// §5.2 — all tanks, index-parallel to world.tanks. Fixed 4 h gap/pickup_gap
// for internal and pipeline-fed tanks (M1: every tank); lead_time_h and
// caution come from TankState. Tanks with no consumer draw keep f = 1; tanks
// with no producer keep h = 1 (§5.2 zero-rate guards).
void computeSignals(const World& world, const State& state, std::vector<TankSignals>& out);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_SIGNALS_H
