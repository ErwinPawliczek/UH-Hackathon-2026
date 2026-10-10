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
