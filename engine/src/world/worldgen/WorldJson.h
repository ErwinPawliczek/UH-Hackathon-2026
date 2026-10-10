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

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_WORLDJSON_H
