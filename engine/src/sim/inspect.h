// Chain Reaction — read-only views of live state for hosts.
//
// Answers a host asks about one thing in the run that the per-frame snapshot
// does not carry: where a vehicle is going and what it holds. Nothing here
// changes state.
#ifndef CRX_SIM_INSPECT_H
#define CRX_SIM_INSPECT_H

#include "sim/state.h"
#include "sim/world.h"

#include <cstdint>
#include <string>

namespace crx {
namespace sim {

// Status names used in host JSON, in VehStatus order.
const char* vehicleStatusName(VehStatus status);

// One vehicle as JSON: class, status, cargo, the order it is serving with
// both ends named, the site it stands at, where its current leg ends, and
// the path from where it is now to that end along the route polylines.
// Returns an empty string when `index` is not a vehicle.
std::string vehicleJson(const World& world, const State& state, uint32_t index);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_INSPECT_H
