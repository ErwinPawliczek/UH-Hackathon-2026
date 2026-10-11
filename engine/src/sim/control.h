// Chain Reaction — §5.3 operating control: rate targets and status.
#ifndef CRX_SIM_CONTROL_H
#define CRX_SIM_CONTROL_H

#include "sim/recorder.h"
#include "sim/signals.h"
#include "sim/state.h"
#include "sim/world.h"

#include <vector>

namespace crx {
namespace sim {

// One row per process, index-parallel to world.processes.
struct ControlDecision {
  double rate_t_h = 0;   // new control rate (§5.3)
  ProcStatus status = ProcStatus::Running;
  double r_max = 0;      // capacity this tick with trains down
  double governor = 1;   // min(f of feeds, h of products), 1 when unbounded
  double target = 0;     // R_max × governor before ramping
};

// §5.3 — one tick of control for every process, in index order. Rates ramp
// toward their targets at ramp_per_h of design (§5.1 rule 8). Boundary
// sources/sinks take their one-sided paths (§5.4). `out` is resized to
// process count; state.proc is updated in place; status transitions log
// through the recorder (§7.2).
void stepControl(const World& world, State& state, const std::vector<TankSignals>& signals,
                 Recorder& rec, std::vector<ControlDecision>& out);

// What holds one process back right now, from the same signals control
// uses: the lowest of its feed tanks' f, its product tanks' h, and (with
// margin control) the margin signal mapped onto turndown..1. `kind` is 0 for
// nothing (governor about 1), 1 feed, 2 room, 3 margin; `tank` is the tank
// behind a feed or room limit, -1 otherwise.
struct GovernorInfo {
  double governor = 1.0;
  int kind = 0;
  int tank = -1;
};
GovernorInfo governorOf(const World& world, const State& state,
                        const std::vector<TankSignals>& signals, size_t process);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_CONTROL_H
