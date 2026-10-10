// Chain Reaction — world validation (§12 test 1 scope, world level).
#ifndef CRX_SIM_VALIDATE_H
#define CRX_SIM_VALIDATE_H

#include "sim/world.h"

#include <string>

namespace crx {
namespace sim {

// Checks a built world for structural sanity: tank capacities positive and
// targets in range, every active-mode external stream of every process bound
// to a tank, unit train capacities positive, pipeline endpoints and
// materials consistent, and material closure — every traded material with a
// tank in the world has a producer, and a consumer unless listed as
// stranded in the spec. Returns false with `error` listing all violations.
bool validateWorld(const World& world, const WorldSpec& spec, std::string& error);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_VALIDATE_H
