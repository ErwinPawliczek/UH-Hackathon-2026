// Hand-drawn world loader — loads design/worlds/erwin-world-v1.json exactly
// as drawn (PR #27 + its README.md, the binding format spec): sites and
// pipelines verbatim, network strips joined per mode on shared end points
// (4 km), sites snapped to a mode when any of its points is within 12 km.
// Rail strips are ignored (no engine rail mode). Rates are assigned forward
// in supply order (sources → plants → demand), never from demand backwards;
// tanks, bays and vehicles are sized from those flows +30% spare. The drawn
// geometry is immutable: when a site or flow cannot be supplied as drawn the
// loader records the exact gap in `gaps` and keeps going.
#ifndef CRX_WORLDGEN_HANDDRAWN_H
#define CRX_WORLDGEN_HANDDRAWN_H

#include "world/worldgen/CatalogView.h"
#include "world/worldgen/WorldGen.h"

#include <string>
#include <vector>

namespace crx {
namespace worldgen {

struct HandDrawnGap {
  std::string site;     // site name, or empty for map-level items
  std::string item;     // what was attempted, e.g. "road connection"
  std::string missing;  // exactly what is missing as drawn
};

// Loads the hand-drawn layout at `jsonPath`. Returns false with `error` set on
// structural failures (unreadable file, malformed JSON, unknown preset).
// Supply gaps are NOT errors: they land in `gaps` for the caller to report.
bool loadHandDrawnWorld(const std::string& jsonPath, const CatalogView& catalog,
                        GeneratedWorld& out, std::vector<HandDrawnGap>& gaps,
                        std::string& error);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_HANDDRAWN_H
