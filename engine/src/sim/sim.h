// Chain Reaction — M1 sim integration (§5.1): owns the World, State and
// Recorder, and runs one tick as systems 2–10 in the fixed order:
//
//   1. events     apply due scheduled events, expire finished, random draws
//   2. signals    f/u/h for every tank
//   3. control    R_max, governor, ramp, status machine
//   4. pipelines  instantaneous point-to-point movement
//   5. production consume/make with rationing, accounting, logging
//   6. recorder   hourly history, state hash support
//
// The class is plain data at heart: copying it forks the run (determinism
// rule 2), and hashState() fingerprints it (rule 6). World is held by shared
// pointer because forks share it.
#ifndef CRX_SIM_SIM_H
#define CRX_SIM_SIM_H

#include "sim/control.h"
#include "sim/adaptation.h"
#include "sim/dispatch.h"
#include "sim/events.h"
#include "sim/genworld.h"
#include "sim/pipelines.h"
#include "sim/production.h"
#include "sim/procurement.h"
#include "sim/recorder.h"
#include "sim/routes.h"
#include "sim/signals.h"
#include "sim/state.h"
#include "sim/world.h"
#include "world/worldgen/WorldGen.h"

#include <memory>
#include <string>
#include <vector>

namespace crx {
namespace sim {

constexpr uint32_t kKpiCount = 8;  // §5.10 KPI vector

class Sim {
 public:
  // Builds the six-site world (sixsite.h) around the catalog and initialises
  // state. The explicit-compatibility path: the default session world is
  // generated (createGenerated). Returns nullptr with `error` set on failure.
  static std::unique_ptr<Sim> create(uint64_t seed, std::string& error);

  // Builds the generated world (worldgen §6) for a seed — the default
  // session world. Validates the seed through the real-Sim warm-up gate
  // (28 simulated days to steady state) before accepting it.
  static std::unique_ptr<Sim> createGenerated(uint64_t seed, std::string& error);
  static std::unique_ptr<Sim> createGenerated(uint64_t seed, const worldgen::GenParams& params,
                                              std::string& error);

  // Wraps an already-built World and initialises state. Used by both create
  // paths and by the warm-up gate (which bridges a generated world itself).
  static std::unique_ptr<Sim> fromWorld(std::shared_ptr<const World> world, std::string& error);

  // Loads the frozen default world (gulf-basin.json from the engine data dir)
  // and initialises state — the sixsite pattern for the showcase world.
  static std::unique_ptr<Sim> createFrozen(std::string& error);

  // Config JSON: {"seed": N, "adaptation": b, "world": "default"|"sixsite",
  // "preset": "<named world>", "gen": {…overrides…}}. The default world (no
  // keys, or world "default" with no seed) is the FROZEN gulf-basin file — no
  // generation at runtime. "preset" also loads the frozen world (--seed never
  // applies to a preset); a seed-only config builds a generated world, which
  // is the development path for arbitrary seeds (unsupported for demos by
  // design); "world":"sixsite" keeps the M1 test world reachable; "gen"
  // overrides generation parameters. Unknown keys are rejected so typos do
  // not silently default.
  static std::unique_ptr<Sim> createFromConfig(const char* config_json, std::string& error);

  // Deep copy: World shared, State and Recorder copied. Forks the run.
  Sim(const Sim&) = default;
  Sim& operator=(const Sim&) = delete;

  // Advances `ticks` fixed 0.25 h ticks.
  void step(uint32_t ticks);

  // §7.2 command: {"type":"event",...}, {"type":"set","key":"random_failures",
  // "value":true} or {"type":"rate_override","site":...,"process":...,
  // "rate_t_h":x}. Returns {"ok":true|false,...} JSON.
  std::string command(const std::string& json);

  const World& world() const { return *world_; }
  const State& state() const { return state_; }
  State& state() { return state_; }
  const Recorder& recorder() const { return rec_; }
  Recorder& recorder() { return rec_; }
  uint64_t stateHash() const { return hashState(*world_, state_); }

  // KPI vector (§5.10): service level, unmet t, unmet $, production index,
  // shutdown hours, stockouts, freight $, energy $.
  void computeKpis(std::vector<double>& out) const;

  std::vector<TankSignals> signals;  // last computed, snapshot-visible

 private:
  Sim() = default;
  std::shared_ptr<const World> world_;
  State state_;
  Recorder rec_;
  // Derived data (determinism rule 3): rebuilt from World + edge_open, so
  // forks may copy or rebuild it — the hash excludes it.
  PathCache paths_;
  MarketParams market_params_;
};

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_SIM_H
