// Chain Reaction — §5.7 dispatch and transport. Dispatch assigns open orders
// (most urgent first) the idle vehicle of the right class that can reach the
// pickup soonest. Transport advances the vehicle state machine
// Idle → ToPickup → QueueLoad → Loading → ToDropoff → QueueUnload →
// Unloading → Idle, moves vehicles along route polylines, serves bays first
// come first served, and closes orders on unload completion. A vehicle whose
// route is cut re-plans from its current node, or waits if no route exists.
#ifndef CRX_SIM_DISPATCH_H
#define CRX_SIM_DISPATCH_H

#include "sim/recorder.h"
#include "sim/routes.h"
#include "sim/state.h"
#include "sim/world.h"

namespace crx {
namespace sim {

// Assigns open orders to idle vehicles (§5.7). Call after procurement.
// `urgency_boost_h` is MarketParams::dispatch_urgency_boost_h: negative
// serves the most urgent order first (then the oldest); >= 0 serves first
// come first served with urgency worth a head start of that many hours.
void stepDispatch(const World& world, State& state, PathCache& paths, Recorder& rec,
                  double urgency_boost_h = -1.0);

// One transport tick: movement, bay queues, loading and unloading (§5.7).
// Delivery books price and freight into the per-site ledgers and feeds the
// buyer's lead-time estimate (§5.8).
void stepTransport(const World& world, State& state, PathCache& paths, Recorder& rec);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_DISPATCH_H
