// Chain Reaction — §5.4 production: consume and make per mode mix, whole-
// process rationing, energy booking.
#ifndef CRX_SIM_PRODUCTION_H
#define CRX_SIM_PRODUCTION_H

#include "sim/control.h"
#include "sim/recorder.h"
#include "sim/state.h"
#include "sim/world.h"

#include <vector>

namespace crx {
namespace sim {

struct ProductionResult {
  double scale = 1;       // achieved ÷ commanded this tick (1 = no rationing)
  double heat_gj = 0;     // booked per unit recipe (§5.4)
  double power_mwh = 0;
  double purchased_gj = 0;    // heat net of the FUEL_GAS credit
  double fuel_gas_t = 0;      // pseudo output credited against heat
  double real_in_t = 0;       // tank draws (served)
  double real_out_t = 0;      // tank fills
  double pseudo_out_t = 0;    // LOSS + FUEL_GAS (books as system loss)
  double pseudo_in_t = 0;     // e.g. WATER (books as system supply)
};

// §5.4 — one tick of production for every process, in index order. Applies
// net-recipe deltas × rate × mode share × dt to the bound tanks; if any tank
// cannot supply or accept its share the whole process scales down for the
// tick so nothing goes negative or overflows. Updates the accounting
// accumulators (sinks/sources/loss) and the per-site ledger, and logs
// sink stockouts (§7.2).
void stepProduction(const World& world, State& state, const std::vector<ControlDecision>& control,
                    std::vector<ProductionResult>& out, Recorder& rec);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_PRODUCTION_H
