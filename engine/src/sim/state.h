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

// §4.4 vehicle and order status (§5.7 state machines).
enum class VehStatus : uint8_t {
  Idle = 0, ToPickup = 1, QueueLoad = 2, Loading = 3,
  ToDropoff = 4, QueueUnload = 5, Unloading = 6,
};
enum class OrdStatus : uint8_t {
  Open = 0, Assigned = 1, Loaded = 2, Delivered = 3, Cancelled = 4
};

struct TankState {
  double level_t = 0;
  double inbound_t = 0;        // en route (§5.6): reserved by open orders
  double reserved_out_t = 0;   // reserved for open orders (§5.6)
  double lead_time_h = 24;     // learned (§5.8); clamped to world initials
  double pickup_gap_h = 4;     // fixed 4 h for pipeline-fed tanks (§5.2)
  double caution = 1;          // learned multiplier (§5.8); 1 in M1
  uint64_t next_eta_tick = 0, last_pickup_tick = 0;  // §4.4, M2
};

// §4.4 vehicle state. Plain data so forks copy it: the planned node sequence
// lives here (not as a path-cache offset) because §5.7 re-planning mutates
// the plan locally. Pose (x, y, dir) is recomputed each tick from the edge
// polyline; edge_pos_km is distance travelled along the current edge from
// the route's entry end.
struct VehicleState {
  VehStatus status = VehStatus::Idle;
  uint32_t order = UINT32_MAX;   // OrderId, valid while assigned
  uint16_t cargo_material = 0;
  double cargo_t = 0;
  uint32_t at_node = UINT32_MAX;
  std::vector<uint32_t> route_nodes;  // planned nodes from the current position
  uint32_t leg = 0;                   // route_nodes index of the node we leave
  uint32_t edge = UINT32_MAX;         // current edge id, UINT32_MAX = none
  double edge_pos_km = 0;
  double x_km = 0, y_km = 0;
  double dir_x = 1, dir_y = 0;
  uint64_t queue_since_tick = 0;      // FCFS key for bays (§5.7)
  double moved_t = 0;                 // progress of the active load/unload
};

// §4.4 order: one vehicle lot, matched by the market (§5.6), dispatched
// (§5.7), and closed by its unload. eta_tick is the market's estimate at
// creation — the buyer's gap signal reads it (§5.2).
struct Order {
  uint32_t from = UINT32_MAX, to = UINT32_MAX;  // TankIds (seller, buyer)
  uint16_t material = 0;
  double qty_t = 0, price = 0, freight_usd = 0;  // price $/t at match; freight booked at delivery
  double urgency = 0;
  uint16_t cls = 0;
  uint32_t vehicle = UINT32_MAX;
  uint64_t created_tick = 0, eta_tick = 0;
  OrdStatus status = OrdStatus::Open;
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
  enum class Type : uint8_t { UnitOutage, SiteShutdown, DemandShock, SupplyShock, RouteBreak };
  Type type = Type::UnitOutage;
  uint32_t site = 0;
  uint32_t site2 = UINT32_MAX;  // route_break: the far end of the closed span
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
  // M2 logistics (§4.4).
  std::vector<VehicleState> vehicle;
  std::vector<Order> order;
  std::vector<uint8_t> edge_open;   // per edge: 1 open, 0 closed (§5.9)
  std::vector<double> price_index;  // per material, 1.0 at start (§5.6)
  uint64_t graph_version = 0;       // bumped on edge open/close: path cache
  bool adaptation = true;           // §5.8 global switch
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
