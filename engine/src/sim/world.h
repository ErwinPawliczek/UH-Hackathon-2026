// Chain Reaction — sim-side data structures (§4.3): the World is this
// country's static description, immutable during a run and shared between a
// run and its forks.
//
// M1 scope: sites, tanks, processes, units and pipelines — the plant core.
// M2 adds the route graph (nodes, edges with polyline arc lengths), per-site
// mode access and bays, the vehicle fleet and contracts; world generation
// (M3) populates the same shapes for generated worlds.
//
// The catalog layer (§4.2, engine/src/catalog) supplies process types and
// vehicle classes; a World site instantiates them with explicit design rates
// and tanks.
#ifndef CRX_SIM_WORLD_H
#define CRX_SIM_WORLD_H

#include "crx/catalog.h"
#include "crx/ids.h"

#include <array>
#include <memory>
#include <string>
#include <vector>

namespace crx {
namespace sim {

constexpr double kTickHours = 0.25;  // §5.1 fixed tick: 15 minutes

using crx::Range;

// Range is {begin, count}; this is the one-past-the-last index.
template <class R>
uint32_t rangeEnd(const R& r) {
  return r.begin + r.count;
}

// Transport-mode index into per-site node/bay arrays (road, river, sea —
// pipeline has no vehicles). UINT32_MAX node = the site has no access.
inline int modeIndex(crx::Mode mode) { return static_cast<int>(mode); }
constexpr uint32_t kNoNode = UINT32_MAX;
constexpr int kModeCount = 3;  // road, river, sea

// Route-graph node (§4.3): a position with an optional site binding (-1 for
// pure infrastructure nodes, e.g. the OVERSEAS sea node).
struct RouteNode {
  double x_km = 0, y_km = 0;
  int site = -1;
};

// Route-graph edge. length_km is the polyline arc length — never the
// Euclidean gap between endpoints (§6.4). polyline indexes the world's flat
// x,y point list so renderers can draw the true shape.
struct RouteEdge {
  uint32_t a = kNoNode, b = kNoNode;
  crx::Mode mode = crx::Mode::Road;
  double length_km = 0, speed_kmh = 0;
  Range<uint32_t> polyline;
};

struct Site {
  std::string key, name;
  int preset = -1;  // catalog site preset this instance derives from, or -1
  double x_km = 0, y_km = 0;
  Range<TankId> tanks;
  Range<ProcessId> processes;
  // §4.3: the node serving the site in each transport mode, and its
  // load/unload bays per mode (§5.7). node = kNoNode → no access.
  std::array<uint32_t, kModeCount> node{kNoNode, kNoNode, kNoNode};
  std::array<uint8_t, kModeCount> bays{0, 0, 0};
};

struct Tank {
  std::string key;       // world-unique, e.g. "STEAM_CRACKER/ETHYLENE"
  SiteId site;
  uint16_t material = 0;
  TankRole role = TankRole::Feed;
  double capacity_t = 0, target_frac = 0.7;
  double cover_days = 0;  // design cover from the spec; capacity derives from it
  // Derived at build: design draw of all on-site processes consuming from
  // this tank / design make of all on-site processes filling it (§5.2).
  double design_in_t_h = 0, design_out_t_h = 0;
  bool piped_in = false, piped_out = false;
  // §5.8 adaptation clamps are relative to the tank's initial values, which
  // are world data (immutable) — the state copies start there.
  double init_lead_time_h = 24, init_pickup_gap_h = 4;
  // §5.6 port export tanks: low-urgency buyers that only match sellers above
  // 70% full, so exports never rob the domestic chain. Set by the world
  // builder (M3 sizing for port import/export tanks).
  bool export_buy = false;
  // Initial fill as a share of capacity; negative starts at target_frac.
  double init_frac = -1.0;
  // A product tank that may overflow: when it is full its plant keeps
  // running and what will not fit is rejected (flared, dumped, left in the
  // gas) instead of holding the plant back. Off unless the world says so.
  bool reject_when_full = false;
};

struct Process {
  SiteId site;
  uint16_t type = 0;  // catalog ProcessType index
  double design_rate_t_h = 0;
  Range<UnitId> units;
  // Tank bound to each external stream, indexed by material slot (§4.3
  // "tank_of"): invalid where the stream has no tank (pseudo materials).
  std::vector<TankId> tank_of;
  uint16_t schedule = 0;  // index into World::schedules (demand/supply curve)
  // Fixed mode mix (M1: feed-mode switching is stubbed — §5.3 swing policy
  // lands in M5). share[m] = fraction of the swing unit's trains on mode m;
  // mode_trains[m] = absolute swing-train count (state init).
  std::vector<double> mode_share;
  std::vector<uint8_t> mode_trains;
};

struct Unit {
  ProcessId process;
  uint8_t slot = 0;  // UnitSlot index within the process type
  // What one train can pass, in t/h of the unit's own throughput (its
  // recipe in-sum, see unitThroughputPerBasis) — not of process basis.
  double cap_per_train_t_h = 0;
};

// Tonnes a unit passes per tonne of process basis: its recipe in-sum,
// weighted over the modes the process runs by their share of the feed (1
// when the unit has no inputs, i.e. a source). Not 1 everywhere — a
// chlor-alkali cell passes 2.156 t per tonne of chlorine, a VCM unit 1.6 —
// and not the same in every mode: a flex cracker's pygas unit passes 0.02 t
// per tonne on ethane and 0.22 on naphtha, so at 1:1:6 it sees 0.176. Unit
// capacity (sized in the world builder) and R_max (control) must use the
// same value, so both come here.
double unitThroughputPerBasis(const UnitSlot& slot, const std::vector<double>& mode_share);

struct Pipeline {
  TankId from, to;
  uint16_t material = 0;
  double cap_t_h = 0;
  // Drawn display path in World::polyline_xy (render-only); count 0 means a
  // straight line between the two sites.
  Range<uint32_t> polyline{};
};

struct World {
  uint64_t seed = 0;
  Catalog catalog;
  std::vector<Site> sites;
  std::vector<Tank> tanks;
  std::vector<Process> processes;
  std::vector<Unit> units;
  std::vector<Pipeline> pipelines;
  // Multipliers per hour of day for source supply / sink demand (§4.3).
  // M1 uses one flat schedule per process; shocks scale it further.
  std::vector<std::vector<double>> schedules;

  // M2 route graph (§4.3): polyline nodes and edges with arc lengths, one
  // flat x,y point list shared by edge polylines. Runtime fleet (resolved
  // catalog class + home site) and contracts (resolved tank pairs) feed
  // procurement and dispatch (§5.6–5.7). Worldgen populates the same shapes
  // for generated worlds, including river and sea modes.
  std::vector<RouteNode> nodes;
  std::vector<RouteEdge> edges;
  std::vector<double> polyline_xy;
  struct FleetEntry {
    uint16_t cls = 0;
    SiteId home{};
  };
  std::vector<FleetEntry> fleet;
  struct Contract {
    TankId buyer{}, seller{};
  };
  std::vector<Contract> contracts;

  // Named hand-built worlds: the name the API reports, the map extent, and
  // render-only map data the simulation step never reads — a water mask on
  // a square grid (the API turns it into the terrain the client draws).
  std::string name = "sixsite";
  double w_km = 600, h_km = 400;
  double water_cell_km = 0;  // 0 = no mask: the API renders seeded terrain
  uint32_t water_cols = 0, water_rows = 0;
  std::vector<uint8_t> water;  // rows x cols, row-major, 1 = water

  // Per-world market settings (§5.6, procurement.h MarketParams): a world
  // file may override any of them; negative leaves the engine default.
  struct Market {
    double value_of_time_usd_t_h = -1, switch_cost_frac = -1, beta = -1;
    double min_lot_cap_frac = -1, min_lot_target_frac = -1;
    double max_lots_per_tank = -1;
    double dispatch_urgency_boost_h = -1;
  };
  Market market;

  // Named worlds may open already running: every process starts at its design
  // rate instead of ramping up from a cold stop over the first day.
  bool warm_start = false;

  int findSite(const std::string& key) const;
  int findTank(const std::string& key) const;
};

// Hand-written world specs (M1): sites instantiate catalog process types
// with explicit design rates and tanks. Tank capacity derives from
// cover_days × 24 h × the dominant design flow (§4.3).
struct TankSpec {
  const char* material;
  TankRole role;
  double cover_days;
  double target_frac;
  double init_frac = -1.0;  // initial fill share of capacity; negative = target_frac
  // §5.8 starting points for the learned lead time and pickup gap; zero or
  // negative keeps the defaults (24 h and 4 h).
  double lead_time_h = -1.0, pickup_gap_h = -1.0;
  bool reject_when_full = false;  // product tanks only: see Tank
};

struct ProcSpec {
  const char* type;
  double design_t_h;
  std::vector<uint8_t> trains_by_mode;  // swing-train counts per catalog mode
};

struct SiteSpec {
  const char* key;
  const char* name;
  double x_km, y_km;
  std::vector<ProcSpec> procs;
  std::vector<TankSpec> tanks;
  const char* preset = nullptr;  // catalog site preset key (Site::preset), optional
  // Bays per mode (road, river, sea); negative takes the WorldSpec default.
  std::array<int, kModeCount> bays{-1, -1, -1};
};

struct PipeSpec {
  const char* material;
  const char* from;  // tank key "SITE/MATERIAL"
  const char* to;
  double cap_t_h;
  // Drawn display path as flat x,y km pairs (Pipeline::polyline); empty
  // leaves the pipeline a straight line between its two sites.
  std::vector<double> points_xy = {};
};

// M2 logistics specs. Roads connect two sites' road nodes with a straight
// polyline (arc length = segment length; worldgen wiggles its own). Fleet
// entries place one vehicle of a catalog class at a site. Contracts bind a
// buyer tank to its preferred seller tank (§5.6 switch-cost rule).
struct RoadSpec {
  const char* from;  // site key
  const char* to;
  double speed_kmh;
};

struct FleetSpec {
  const char* vehicle_class;  // catalog vehicle class key
  const char* home_site;
};

struct ContractSpec {
  const char* buyer;   // tank key
  const char* seller;  // tank key
};

struct WorldSpec {
  std::vector<SiteSpec> sites;
  std::vector<PipeSpec> pipes;
  std::vector<RoadSpec> roads;
  std::vector<FleetSpec> fleet;
  std::vector<ContractSpec> contracts;
  unsigned road_bays = 2;    // §5.7 bays per site per mode; roads only in M1
  unsigned river_bays = 0;   // (generated worlds set their own per mode)
  unsigned sea_bays = 0;
  // Traded materials deliberately produced but unconsumed in M1 (they
  // accumulate in long-cover tanks) — exempt from the closure check.
  std::vector<const char*> stranded_materials;
};

// Builds the world around a catalog: resolves ids, binds external streams to
// tanks, and derives per-tank design draws/makes and per-unit train
// capacities. Returns false with `error` set if the spec references anything
// the catalog does not define.
bool buildWorld(const Catalog& catalog, uint64_t seed, const WorldSpec& spec, World& out,
                std::string& error);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_WORLD_H
