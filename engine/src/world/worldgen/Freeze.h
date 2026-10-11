// Freeze the default demo world: cut seed 709's generated layout to the
// showcase site set, hand-balance every rate FORWARD from the sources
// (consumers sized to supplier output, surplus to port export), size the
// fleet per lane with 30% spare, and bend every pipeline and water route to
// a ≥4-point polyline that avoids roads and other pipelines. The output is
// written to engine/data/worlds/gulf-basin.json and is the file crx_create
// loads as the default world — no generation at runtime.
#ifndef CRX_WORLDGEN_FREEZE_H
#define CRX_WORLDGEN_FREEZE_H

#include "world/worldgen/CatalogView.h"
#include "world/worldgen/WorldGenTypes.h"

#include <string>

namespace crx {
namespace worldgen {

// Deterministic: the same seed and catalog produce a byte-identical world.
// Returns false with a reason in `error` if the generated world lacks any
// site or route the showcase needs.
bool freezeGulfBasin(uint64_t seed, const CatalogView& catalog, GeneratedWorld& out,
                     std::string& error);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_FREEZE_H
