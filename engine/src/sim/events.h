// Chain Reaction — §5.9 events: outages, site shutdowns, demand and supply
// shocks. Commands queue EventDefs into State::pending; they apply at the
// start of their start_tick and expire at end_tick.
#ifndef CRX_SIM_EVENTS_H
#define CRX_SIM_EVENTS_H

#include "sim/recorder.h"
#include "sim/state.h"
#include "sim/world.h"

#include <string>

namespace crx {
namespace sim {

// Parses one event command body (§7.2): {"type","site","unit","trains",
// "duration_h","multiplier"}. `site` is a world site index or key, `unit` a
// catalog unit key within that site. Returns false with `error` set for
// malformed bodies (unknown event type, non-numeric fields, negative
// duration); unresolved site/unit keys stay queued and are skipped at apply
// time so the API stays tolerant of stale names (§7.2 note).
bool queueEvent(const World& world, const std::string& body, State& state, std::string& error);

// Start-of-tick event pass: applies due pending events, expires finished
// ones, and runs the optional random-failure draw (§5.9).
void stepEvents(const World& world, State& state, Recorder& rec);

// Product of multipliers of active shocks at a site (1.0 when none). Demand
// shocks scale sink demand, supply shocks source supply (§5.9).
double shockFactor(const State& state, uint32_t site, EventDef::Type kind);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_EVENTS_H
