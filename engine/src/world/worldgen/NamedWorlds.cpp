// Named world presets. The default world is FROZEN on disk (engine/data/
// catalog/gulf-basin.json) — the seed here is provenance (the generator seed
// the frozen layout came from), not a runtime input.
#include "world/worldgen/WorldGen.h"

namespace crx {
namespace worldgen {

const std::vector<NamedWorld>& namedWorlds() {
  static const std::vector<NamedWorld> kWorlds = {
      {"gulf-basin", 709, "Frozen gulf coast showcase: two crackers, heavy barge traffic"},
  };
  return kWorlds;
}

const NamedWorld* findNamedWorld(const std::string& name) {
  for (const NamedWorld& w : namedWorlds())
    if (name == w.name) return &w;
  return nullptr;
}

}  // namespace worldgen
}  // namespace crx
