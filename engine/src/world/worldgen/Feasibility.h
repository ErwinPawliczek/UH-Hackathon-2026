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

// The M3 default-world structural guarantees (preset presence, supplier
// counts, outlets, route non-overlap, tank cover, mode usage), checked
// separately so the doctest suites can assert each family's error strings.
std::vector<std::string> checkConstraints(const GeneratedWorld& world,
                                          const CatalogView& catalog);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_FEASIBILITY_H
