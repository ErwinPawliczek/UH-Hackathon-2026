// Named seed presets for demos (§6.7). Every entry's seed has been validated
// through the feasibility gate AND the real-Sim warm-up (28 simulated days to
// steady state without starvation or an emptied tank); the world a seed
// builds is a pure function of the seed, so the presets are stable.
#include "world/worldgen/WorldGen.h"

namespace crx {
namespace worldgen {

const std::vector<NamedWorld>& namedWorlds() {
  static const std::vector<NamedWorld> kWorlds = {
      {"gulf-basin", 709, "Balanced gulf coast: two crackers, heavy barge traffic"},
      {"estuary-delta", 1729, "Tight tank cover — one outage ripples within days"},
      {"highland-corridor", 4177, "Inland plants, long pipelines, truck-heavy pellets"},
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
