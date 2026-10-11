// Frame, natural features and rule-based siting (§6.1–6.3).
//
// The template fixes WHERE kinds of things go: sea on one map edge, basins and
// a river by seed, cities with rank-size populations, refineries and crackers
// at ports, gas plants at the gas basin, derivatives within 25 km of a
// cracker, chlor-alkali next to vinyls, sinks in cities. Placement is by rule,
// never search: sampled positions with deterministic relaxation on conflict.
#ifndef CRX_WORLDGEN_LAYOUT_H
#define CRX_WORLDGEN_LAYOUT_H

#include "world/worldgen/Geo.h"
#include "world/worldgen/WorldGenTypes.h"

#include <string>
#include <vector>

namespace crx {
namespace worldgen {

struct Frame {
  double w_km = 0.0, h_km = 0.0;
  int sea_edge = 0;  // 0 north (y=h), 1 south (y=0), 2 east (x=w), 3 west (x=0)
  Vec2 overseas;     // sea node 18 ship-days out
  double sea_leg_km = 0.0;

  Vec2 coastPoint(double u) const;  // u along the coast edge, 0..1
  double distToCoast(Vec2 p) const;
  bool onLand(Vec2 p, double margin_km = 0.0) const;
};

struct City {
  Vec2 pos;
  double pop_m = 0.0;  // millions
  std::string name;
};

struct Features {
  Vec2 oil_basin, gas_basin, salt_deposit;
  std::vector<Vec2> river;         // highlands → sea mouth, polyline vertices
  double port_u[2] = {0.25, 0.7};  // coast fraction of the two ports
  std::vector<City> cities;
};

// One site before routing/sizing: a preset pinned to a position.
struct SiteSlot {
  std::string preset, name, variant;
  Vec2 pos;
  int city = -1;  // city sinks carry their city index
  // Seed-drawn per-site weights (§6.5 "random details"): capacity_weight
  // tilts this site's share of its family's design load and nudges supplier
  // preference; cover_weight tilts its tank cover days. Both in [0.85, 1.15],
  // mean 1 — capacities and covers vary by seed while the family totals hold.
  double capacity_weight = 1.0;
  double cover_weight = 1.0;
};

Frame makeFrame(const GenParams& params, Rng& rng);
Features makeFeatures(const GenParams& params, Rng& rng, const Frame& frame);
std::vector<SiteSlot> placeSites(const GenParams& params, Rng& rng, const Features& features,
                                 const Frame& frame);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_LAYOUT_H
