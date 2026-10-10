// Chain Reaction — mutable simulation state (§4.4) and the M1 event model
// (§5.9). Plain data throughout: copying a State forks the run, and hashing
// it fingerprints the run (determinism rules 4 and 6).
//
// M1 additions beyond the §4.4 sketch, all documented against it: the
// `active` event list (scheduled events still inside their window), the
// accounting accumulators that make §12 test 2 (mass conservation) a plain
// subtraction, the per-site ledger, and `random_failures`.
#ifndef CRX_SIM_STATE_H
#define CRX_SIM_STATE_H

#include "crx/rng.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace crx {
namespace sim {

// §4.4 / §7.3 process status byte.
enum class ProcStatus : uint8_t { Running = 0, HoldMin = 1, Shutdown = 2, Restarting = 3 };

struct TankState {
  double level_t = 0;
  double inbound_t = 0;        // en route (M2); 0 until vehicles exist
  double reserved_out_t = 0;   // reserved for open orders (M2); 0 in M1
  double lead_time_h = 24;     // learned (§5.8); static in M1
  double pickup_gap_h = 4;     // fixed 4 h for pipeline-fed tanks (§5.2)
  double caution = 1;          // learned multiplier (§5.8); 1 in M1
  uint64_t next_eta_tick = 0, last_pickup_tick = 0;
};

struct ProcState {
  double rate_t_h = 0;
  ProcStatus status = ProcStatus::Running;
  uint32_t timer = 0;               // Restarting countdown, in ticks
  std::array<uint8_t, 4> trains_by_mode{};  // swing trains per mode (M1: fixed)
  uint32_t switch_timer = 0;        // §5.3 mode-switch timer (M1: unused)
};

struct UnitState {
  uint8_t trains_down = 0;
  uint64_t back_at_tick = 0;  // tick the repair completes; 0 = nothing down
};

// §5.9 events, queued by crx_command into `pending` and applied at the start
// of the next tick by the events system.
struct EventDef {
  enum class Type : uint8_t { UnitOutage, SiteShutdown, DemandShock, SupplyShock };
  Type type = Type::UnitOutage;
  uint32_t site = 0;
  int32_t unit = -1;      // world unit index; unit-level events only
  uint32_t trains = 0;    // unit_outage
  double multiplier = 1;  // demand/supply shocks
  uint64_t start_tick = 0, end_tick = 0;
  bool applied = false;   // outage effects applied once (§5.9)
};

// §7.2 log entry (recorder owns the sequence numbers).
struct LogEntry {
  uint64_t seq = 0, tick = 0;
  std::string type, site, unit, text;
};

// §4.4 ledger, one per site.
struct Ledger {
  double produced_t = 0, consumed_t = 0, unmet_t = 0;
  double revenue = 0, feed_cost = 0, freight = 0, energy_cost = 0;
};

struct State {
  uint64_t tick = 0;
  Rng rng;
  std::vector<TankState> tank;
  std::vector<ProcState> proc;
  std::vector<UnitState> unit;
  std::vector<EventDef> pending;  // §4.4: applied at their start_tick
  std::vector<EventDef> active;   // M1 addition: inside their window
  std::vector<double> pipe_flow_t_h;
  std::vector<Ledger> ledger;          // per site
  std::vector<uint8_t> sink_starved;   // per process: edge state for stockouts
  std::vector<double> rate_override;   // per process: §7.2 R_max cap, <0 = none

  // Accounting accumulators (§5.4, §5.10). Real material only: pseudo
  // streams (FUEL_GAS, LOSS, WATER, AIR_O2) never enter tanks, so their
  // tonnage books as loss (out) or supply (in) the tick it is transformed.
  double cum_supplied_t = 0;   // boundary-source production into tanks
  double cum_consumed_t = 0;   // boundary-sink consumption out of tanks
  double cum_loss_t = 0;       // pseudo output tonnage
  double cum_demand_t = 0;     // sink demand (served + unmet)
  double cum_unmet_t = 0;
  double cum_unmet_usd = 0;
  double cum_shutdown_h = 0;
  double stockouts = 0;
  double cum_freight_usd = 0;  // 0 until M2 vehicles
  double cum_energy_usd = 0;
  double last_production_index = 1;  // made ÷ design, last tick
  bool random_failures = false;      // §5.9 optional draws (config)
};

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_STATE_H
