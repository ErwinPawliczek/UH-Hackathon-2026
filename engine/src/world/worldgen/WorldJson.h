// World JSON serialization — the deterministic artifact the tests diff and
// the sim/server consume. Field layout follows outline §4.3; every dump for a
// given (seed, params, catalog) is byte-identical.
#ifndef CRX_WORLDGEN_WORLDJSON_H
#define CRX_WORLDGEN_WORLDJSON_H

#include "world/worldgen/WorldGenTypes.h"

#include <nlohmann/json.hpp>

namespace crx {
namespace worldgen {

nlohmann::json toWorldJson(const GeneratedWorld& world);

// Parse a world file back into GeneratedWorld. Symmetric with toWorldJson;
// on failure returns false with a human-readable reason in `error`. Used by
// the frozen default world loader — a malformed file must fail cleanly, never
// dereference garbage.
bool fromWorldJson(const std::string& text, GeneratedWorld& world, std::string& error);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_WORLDJSON_H
