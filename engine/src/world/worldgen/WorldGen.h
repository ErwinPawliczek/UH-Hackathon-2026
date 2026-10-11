// Top-level world generation (§6): template placement → routes → sizing →
// assembly, wrapped in the feasibility gate. Deterministic from (seed,
// params, catalog): the gate may reseed (seed + attempt) but the result is a
// pure function of those three.
#ifndef CRX_WORLDGEN_WORLDGEN_H
#define CRX_WORLDGEN_WORLDGEN_H

#include "world/worldgen/CatalogView.h"
#include "world/worldgen/Layout.h"
#include "world/worldgen/Routes.h"
#include "world/worldgen/Sizing.h"
#include "world/worldgen/WorldGenTypes.h"

#include <string>
#include <vector>

namespace crx {
namespace worldgen {

struct GenResult {
  GeneratedWorld world;
  std::vector<std::string> gate_errors;  // empty iff ok
  bool ok = false;
};

// Named seed presets for demos (§6.7): seeds validated through the warm-up
// gate to steady state, exposed at session creation by name. Same seed always
// yields a byte-identical world.
struct NamedWorld {
  const char* name;        // preset name, e.g. "gulf-basin"
  uint64_t seed;           // generator seed that builds the world
  const char* description; // one-line demo note
};

// The curated list, in presentation order.
const std::vector<NamedWorld>& namedWorlds();
// Case-sensitive lookup by name; nullptr when unknown.
const NamedWorld* findNamedWorld(const std::string& name);

// Pluggable warm-up steady-state check (§6.7): the sim systems that would
// verify a warm-up settle land separately; the hook stays empty for now.
using WarmupHook = std::vector<std::string> (*)(const GeneratedWorld&, const CatalogView&);

GenResult generateWorld(uint64_t seed, const GenParams& params, const CatalogView& catalog,
                        WarmupHook warmup = nullptr);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_WORLDGEN_H
