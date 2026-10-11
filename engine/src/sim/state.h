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
  // Product that did not fit and was thrown away, cumulative (only ever
  // non-zero for a tank the world marks reject_when_full).
  double rejected_t = 0;
  // Rolling average of the price paid per tonne on this tank's booked lots
  // (0 = nothing booked yet, read as the base price). Kept only in worlds
  // with demand elasticity; hashed only when non-zero.
  double paid_avg = 0;
  // The same for lots sold from this tank (kept with margin control only).
  double sold_avg = 0;
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
  // Bookkeeping for the economy view, outside the state hash: the route
  // length the lot was priced on and the tick it was delivered (0 = not yet).
  double km = 0;
  uint64_t delivered_tick = 0;
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
  uint32_t edge = UINT32_MAX;   // route_break by edge: the one route edge closed
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
  std::string player, player_name;  // set when a named player's command caused it
};

// §4.4 ledger, one per site.
struct Ledger {
  double produced_t = 0, consumed_t = 0, unmet_t = 0;
  double revenue = 0, feed_cost = 0, freight = 0, energy_cost = 0;
};

// Per-process running totals since tick 0. Derived from quantities the hash
// already covers, so they stay out of the state hash; they exist so a window
// of a run (forecasts, per-customer service) is a plain subtraction.
struct ProcTotals {
  double demand_t = 0;  // sinks: tonnes asked for
  double served_t = 0;  // sinks: tonnes actually drawn
  double down_h = 0;    // plants: hours in Shutdown or Restarting
  double priced_out_t = 0;  // sinks: tonnes not wanted at the price paid
};

// Per-site trade the ledger does not carry: tonnes sold by vehicle, and the
// pipeline flows between sites valued at the base price (a pipeline books no
// order). Read by the scores view only, so it stays out of the state hash.
struct SiteTrade {
  double sold_t = 0;
  double pipe_revenue = 0;
  double pipe_feed_cost = 0;
  // For the before/after summary: hours the site was stopped (a process shut
  // down or restarting, or nothing at the site running at all), and the
  // customer sales it lost, at base prices.
  double stopped_h = 0;
  double unmet_usd = 0;
  // Demand the site's customers gave up because of the price they pay
  // (base demand less what they want at that price), tonnes and base-price
  // dollars. Zero without demand elasticity.
  double priced_out_t = 0, priced_out_usd = 0;
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
  std::vector<ProcTotals> proc_totals; // per process, cumulative (not hashed)
  // A site's own markup on its asking price (set_price): ask = rule x (1 +
  // markup). Zero unless a player set it; hashed only where non-zero.
  std::vector<double> site_markup;
  // The share of design a site was told to run at (site_rate), 1 = no cap.
  // The cap itself lives in rate_override; this is kept for the scores view.
  std::vector<double> site_rate_share;
  std::vector<SiteTrade> site_trade;   // per site, cumulative (not hashed)
  std::vector<double> pipe_moved_t;    // per pipeline, cumulative tonnes (not hashed)
  // Per material: tonnes and dollars of every lot booked since tick 0, at
  // the price booked (summary view; not hashed).
  std::vector<double> mat_bought_t, mat_bought_usd;
  // Demand elasticity (from the world's market block; the same in every
  // fork): a customer wants base x (price paid / base price)^-elasticity,
  // held within [demand_min, demand_max] of base. 0 = demand ignores price.
  double demand_elasticity = 0, demand_min = 0.6, demand_max = 1.2;
  std::vector<double> demand_factor;   // per process: wanted / base this tick (1 for non-sinks)
  double cum_priced_out_t = 0, cum_priced_out_usd = 0;  // not hashed: follow from hashed state
  // Margin control (market.h; from the world's market block). The vectors
  // carry over from hour to hour, so they are state: hashed where non-zero.
  bool margin_control = false;
  std::vector<double> cost_delta, ask_floor;      // per tank
  std::vector<double> margin_signal, proc_margin; // per process
  // Per process, $ per tonne of basis at today's prices (market view; derived).
  std::vector<double> proc_revenue, proc_feed_cost, proc_energy;
  // trade_block: pairs that do not trade, as seller site << 32 | buyer site,
  // kept sorted. Empty unless a player set one; hashed only when not empty.
  std::vector<uint64_t> trade_blocks;
  // Network-wide scenarios, as the tick they end at (0 = not running; hashed
  // only when running). A hurricane slows every road vehicle to a quarter
  // speed; a water restriction lets no barge or ship set off.
  uint64_t hurricane_until = 0;
  uint64_t water_stop_until = 0;

  bool tradeBlocked(uint32_t seller_site, uint32_t buyer_site) const {
    if (trade_blocks.empty()) return false;
    const uint64_t key = (static_cast<uint64_t>(seller_site) << 32) | buyer_site;
    for (const uint64_t b : trade_blocks)
      if (b == key) return true;
    return false;
  }

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
