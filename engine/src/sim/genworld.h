// Bridge from a generated world (worldgen::GeneratedWorld) to the sim's
// World (§4.3). The generator produces the same entity kinds the hand-written
// specs do; this mapper resolves catalog ids and rebuilds the derived data —
// per-tank design draws/makes, per-unit train capacities, swing-train mode
// mixes — with exactly the semantics buildWorld() uses for specs, so generated
// and hand-written worlds behave identically in the sim.
//
// Schedules need one semantic conversion: the generator stores absolute t/h
// curves per process, the sim multiplies design_rate × schedule[h]. The
// bridge normalises each curve by its process's design rate (mean ≈ 1).
#ifndef CRX_SIM_GENWORLD_H
#define CRX_SIM_GENWORLD_H

#include "sim/world.h"
#include "world/worldgen/WorldGen.h"

#include <string>

namespace crx {
namespace sim {

// Maps a generated world into the sim's World shape. Returns false with
// `error` set if the generated data references anything the catalog does not
// define (unknown material, process type, vehicle class or preset).
bool buildGeneratedWorld(const Catalog& catalog, const worldgen::GeneratedWorld& gen, World& out,
                         std::string& error);

// Real-Sim warm-up gate (§6.7): bridges the generated world into the engine
// sim and runs 28 simulated days — a 21-day ramp-up, then a 7-day watched
// tail — accepting the seed only if no process starves and no tank runs dry
// during the tail. Passed to generateWorld() at session creation, so a demo
// seed can never build a world that cannot hold steady state.
std::vector<std::string> realSimWarmup(const worldgen::GeneratedWorld& gen,
                                       const worldgen::CatalogView& view);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_GENWORLD_H
