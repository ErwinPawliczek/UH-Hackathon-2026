// Chain Reaction — the hand-written six-site M1 world (§13).
#ifndef CRX_SIM_SIXSITE_H
#define CRX_SIM_SIXSITE_H

#include "sim/world.h"

#include <string>

namespace crx {
namespace sim {

// Loads the §3 catalog from the data directory baked in at build time
// (CRX_DATA_DIR), builds the six-site world around it and validates the
// result. Returns false with `error` set on any failure.
bool buildSixSiteWorld(uint64_t seed, World& out, std::string& error);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_SIXSITE_H
