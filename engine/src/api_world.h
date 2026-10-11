// Chain Reaction — render-side description of a World for the client (§7.3):
// the terrain height grid and the static world JSON. Split out of api.cpp so
// tests can build both from a World without going through the C ABI.
#ifndef CRX_API_WORLD_H
#define CRX_API_WORLD_H

#include "sim/world.h"

#include <cstdint>
#include <string>
#include <vector>

namespace crx {

// Row-major heights in metres, rows × cols, sampled at (col, row) × cell_km.
// Sea level is 0: the client draws water wherever a sample is below it.
struct TerrainGrid {
  uint32_t cols = 0, rows = 0;
  double cell_km = 10.0;
  std::vector<float> height;
};

// Seeded island terrain for worlds without a water mask (the six-site world).
void buildSeedTerrain(uint64_t seed, TerrainGrid& out);

// Terrain from the world's water mask: below sea level exactly inside the
// mask's water cells, zero on the shoreline, gentle seeded relief on land.
// The grid is twice as fine as the mask so every mask cell has an interior
// sample and bilinear sampling reproduces the mask's outline.
void buildMaskTerrain(const sim::World& world, TerrainGrid& out);

// Mask terrain when the world carries a mask, seeded terrain otherwise.
void buildTerrain(const sim::World& world, TerrainGrid& out);

// The §7.3 world document in the client's schema (web/src/engine/world.ts).
// edge_route receives the client route index per world edge.
std::string buildWorldJson(const sim::World& world, const TerrainGrid& terrain,
                           std::vector<uint32_t>& edge_route);

}  // namespace crx

#endif  // CRX_API_WORLD_H
