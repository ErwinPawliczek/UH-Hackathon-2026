// Feasibility gate (§6.7): reachability, travel-time sanity, and utilisation
// limits, evaluated on an assembled world. The warm-up steady-state check is
// a pluggable hook — the sim systems land separately.
#ifndef CRX_WORLDGEN_FEASIBILITY_H
#define CRX_WORLDGEN_FEASIBILITY_H

#include "world/worldgen/CatalogView.h"
#include "world/worldgen/WorldGenTypes.h"

#include <string>
#include <vector>

namespace crx {
namespace worldgen {

// Returns a list of human-readable violations; empty = world passes the gate.
std::vector<std::string> checkFeasibility(const GeneratedWorld& world,
                                          const CatalogView& catalog);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_FEASIBILITY_H
