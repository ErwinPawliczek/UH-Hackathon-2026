// Chain Reaction — sim-side data structures (§4.3): the World is this
// country's static description, immutable during a run and shared between a
// run and its forks.
//
// M1 scope: sites, tanks, processes, units and pipelines — the plant core.
// The route graph (nodes, edges, vehicles, orders) arrives with M2
// logistics; world generation (M3) will populate the same shapes.
//
// The catalog layer (§4.2, engine/src/catalog) supplies process types; a
// World site instantiates them with explicit design rates and tanks.
#ifndef CRX_SIM_WORLD_H
#define CRX_SIM_WORLD_H

#include "crx/catalog.h"
#include "crx/ids.h"

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

struct Site {
  std::string key, name;
  int preset = -1;  // catalog site preset this instance derives from, or -1
  double x_km = 0, y_km = 0;
  Range<TankId> tanks;
  Range<ProcessId> processes;
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
  double cap_per_train_t_h = 0;
};

struct Pipeline {
  TankId from, to;
  uint16_t material = 0;
  double cap_t_h = 0;
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
};

struct PipeSpec {
  const char* material;
  const char* from;  // tank key "SITE/MATERIAL"
  const char* to;
  double cap_t_h;
};

struct WorldSpec {
  std::vector<SiteSpec> sites;
  std::vector<PipeSpec> pipes;
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
