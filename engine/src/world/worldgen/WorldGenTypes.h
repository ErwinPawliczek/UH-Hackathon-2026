// Layout generator — world types (outline v0.3 §6, §4.3).
//
// The generator owns no simulation state: it produces the static World the sim
// consumes. Structs mirror §4.3 field-for-field so the spine can adopt them,
// but catalog links are kept as string keys (the Catalog structs and JSON
// loader are a parallel workstream; this file must not depend on them).
// IDs and Range are reused from crx/ids.h.
//
// Determinism contract (§1): every field of a GeneratedWorld is a pure
// function of (seed, GenParams, CatalogView). No wall clock, no unordered
// iteration, no library RNG.
#ifndef CRX_WORLDGEN_TYPES_H
#define CRX_WORLDGEN_TYPES_H

#include "crx/ids.h"

#include <cstdint>
#include <string>
#include <vector>

namespace crx {
namespace worldgen {

// Local copy of the catalog's Mode enum (§4.2). Field-compatible; mapped 1:1
// when the catalog workstream's types merge.
enum class Mode : uint8_t { Road = 0, River = 1, Sea = 2, Pipeline = 3 };

// TankRole (§4.2).
enum class TankRole : uint8_t { Feed = 0, Product = 1, Internal = 2, Both = 3 };

// The small parameter set §6 fixes. Defaults describe the reference world.
struct GenParams {
  double map_w_km = 240.0;            // map extent, x
  double map_h_km = 400.0;            // map extent, y
  int    n_cities = 5;                // demand centres with rank-size populations
  double demand_scale = 1.0;          // scales every end demand
  double target_utilisation = 0.88;   // design rate = required / count / utilisation
  double cover_multiplier = 1.0;      // scales every tank's cover days
  double top_population_m = 4.0;      // largest city, millions of people
  double rank_size_exponent = 1.0;    // Zipf exponent: pop_i = top / i^z
  double city_min_spacing_km = 55.0;
  double cracker_cluster_km = 25.0;   // derivative plants sit within this of a cracker
  double sea_leg_days = 18.0;         // OVERSEAS is a fixed ship-days out (~11,000 km)
  double ship_speed_kmh = 26.0;       // SHIP_TANK reference speed for the overseas leg
  int    max_gate_attempts = 16;      // feasibility gate: reject → reseed, this many tries
};

struct WNode {
  float x_km = 0.f, y_km = 0.f;
};

// Edge length is the polyline arc length, never the Euclidean gap (§6.4).
struct WEdge {
  NodeId a, b;
  Mode mode = Mode::Road;
  float length_km = 0.f, speed_kmh = 0.f;
  Range<uint32_t> polyline;  // xy pairs in GeneratedWorld::polyline_xy
};

struct WSite {
  std::string name;
  std::string preset;   // preset key, e.g. "REFINERY"
  std::string variant;  // preset-specific flavour, e.g. cracker "gas"|"flex"
  float x_km = 0.f, y_km = 0.f;
  uint16_t region = 0;
  NodeId node[3];       // road, river, sea; invalid if no access
  uint8_t bays[3] = {0, 0, 0};
  int city = -1;        // for city sinks: index into the city list
  Range<TankId> tanks;
  Range<ProcessId> processes;
};

struct WTank {
  SiteId site;
  std::string material;  // material key
  TankRole role = TankRole::Feed;
  double capacity_t = 0.0, target_frac = 0.0;
  double design_in_t_h = 0.0, design_out_t_h = 0.0;
  bool piped_in = false, piped_out = false;
};

struct WProcess {
  SiteId site;
  std::string type;  // process type key, e.g. "NGL_RECOVERY"
  double design_rate_t_h = 0.0;  // t/h of the process basis
  Range<UnitId> units;
  std::vector<TankId> tank_of;   // one per external stream of the net recipe
  uint16_t schedule = 0;         // index into schedules; demand or supply curve
  // Fixed swing-train mix over the type's modes (§5.3 M1 policy): fraction of
  // the swing unit's trains per mode, in the type's mode order. Sums to 1;
  // empty for single-mode types.
  std::vector<double> mode_share;
};

struct WUnit {
  ProcessId process;
  uint8_t slot = 0;
  double cap_per_train_t_h = 0.0;
};

struct WPipeline {
  TankId from, to;
  double cap_t_h = 0.0;
  float length_km = 0.f;
  Range<uint32_t> polyline;  // straight field→plant / cluster links (§6.4)
};

struct WVehicleSpec {
  std::string cls;  // vehicle class key, e.g. "TRUCK_TANK"
  NodeId home;
};

// One directed material movement, retained on the world for the constraint
// suites and demo tooling: piped=true is a straight site-to-site pipeline,
// otherwise a contracted vehicle flow (the fleet carries the class).
// kOverseasSite in from/to marks the external market leg.
struct WFlowRecord {
  std::string material;
  int from_site = -1, to_site = -1;
  double t_d = 0.0;
  bool piped = false;
};

struct WContract {
  TankId buyer, seller;  // preferred supplier (§4.3)
};

struct GeneratedWorld {
  uint64_t seed = 0;
  GenParams params;

  NodeId overseas_node;  // the OVERSEAS berth in the sea subgraph (imports)

  // Terrain frame (§6.1): which map edge is sea, and the river feature
  // polyline (x,y pairs). Serialized so a frozen world file rebuilds the
  // exact height field the web renderer classifies land/water with.
  int sea_edge = 0;             // 0 north (y=h), 1 south (y=0), 2 east (x=w), 3 west (x=0)
  std::vector<float> river_xy;  // highlands → sea mouth, x,y pairs

  std::vector<WNode> nodes;
  std::vector<WEdge> edges;
  std::vector<float> polyline_xy;
  std::vector<WSite> sites;
  std::vector<WTank> tanks;
  std::vector<WProcess> processes;
  std::vector<WUnit> units;
  std::vector<WPipeline> pipelines;
  std::vector<WVehicleSpec> fleet;
  std::vector<WFlowRecord> flows;  // in-memory only; not serialized
  std::vector<WContract> contracts;
  std::vector<std::vector<float>> schedules;  // 24 hourly t/h values per curve

  // Counters the reference world is measured by (§6): sites, tanks, processes,
  // vehicles, pipelines. Derived accessors keep the tests honest.
  size_t nSites() const { return sites.size(); }
  size_t nTanks() const { return tanks.size(); }
  size_t nProcesses() const { return processes.size(); }
  size_t nVehicles() const { return fleet.size(); }
  size_t nPipelines() const { return pipelines.size(); }
};

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_TYPES_H
