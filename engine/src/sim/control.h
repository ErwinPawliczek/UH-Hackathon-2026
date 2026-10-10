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

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_CONTROL_H
