// Chain Reaction — §5.6 procurement and market. Hourly: every buy-side tank
// (externally fed, no pipeline, with a consumer draw) runs a reorder policy —
// when its urgency is positive it asks for enough to bring stock on hand
// plus inbound up to its target fill, cut into lots of one vehicle load. The
// market matches lots to sellers, most urgent first, on the §5.6 cost
// formula; the cheapest candidate wins and becomes an Order, the seller's
// stock is reserved and the buyer's inbound rises. A lot with no candidate
// stays unmatched and pushes the material's price index up.
#ifndef CRX_SIM_PROCUREMENT_H
#define CRX_SIM_PROCUREMENT_H

#include "sim/recorder.h"
#include "sim/routes.h"
#include "sim/signals.h"
#include "sim/state.h"
#include "sim/world.h"

#include <cstdint>
#include <string>
#include <vector>

namespace crx {
namespace sim {

// §5.6 market constants.
struct MarketParams {
  double value_of_time_usd_t_h = 0.5;  // V: $ per tonne-hour of ETA
  double switch_cost_frac = 0.05;      // non-contract seller surcharge
  double beta = 0.5;                   // price-spread factor
  double export_seller_fill = 0.7;     // port export tanks buy only above this
  double export_urgency = 0.1;         // fixed low urgency for export tanks
  uint32_t max_lots_per_tank = 64;     // bounds one run's matching loop
  // Minimum lot: a buyer places nothing this hour when the lot it could
  // place is smaller than both fractions allow — min(cap_frac x the chosen
  // class's capacity, target_frac x the buyer tank's target stock). Stops
  // a tank with a long learned lead time from ordering an hour's draw at a
  // time. Off unless both are > 0.
  double min_lot_cap_frac = 0.0;
  double min_lot_target_frac = 0.0;
  // Dispatch queue order (§5.7). Negative: open orders go most urgent
  // first, then oldest — an order placed at low urgency can wait forever
  // behind fresher, more urgent ones while its class is busy. >= 0: first
  // come first served, with urgency worth a head start of at most this
  // many hours (sort key = created − urgency x boost).
  double dispatch_urgency_boost_h = -1.0;

  // --- Market behaviour, all off unless the world file switches it on. ---
  // Price-aware buying: a buyer compares the best ask it is offered with the
  // material's base price. Cheap (ratio <= price_cheap_ratio): it orders
  // while its cover is still long (up to price_cheap_cover lead times) and
  // fills to price_cheap_fill of the tank. Dear (>= price_dear_ratio): it
  // waits until cover is down to price_dear_cover lead times and fills only
  // to price_dear_fill. Smooth in between; at par, and whenever cover is
  // under one lead time, it buys exactly as without the switch.
  bool price_aware_buying = false;
  double price_cheap_ratio = 0.9, price_dear_ratio = 1.1;
  double price_cheap_fill = 0.9, price_dear_fill = 0.5;
  double price_cheap_cover = 4.0, price_dear_cover = 1.5;
  // Demand elasticity (see State::demand_elasticity): customers want less
  // when what they pay is above the base price, more when below.
  double demand_elasticity = 0.0, demand_min_frac = 0.6, demand_max_frac = 1.2;
  double paid_avg_weight = 0.2;  // weight of each new lot in the rolling price paid
  // Margin control and cost pass-through (market.h).
  bool margin_control = false;
};

// One way of filling a lot: a seller tank and a vehicle class, priced as the
// market prices it (§5.6). Procurement books the cheapest bookable quote; the
// sourcing view (inspect.h) lists them all, including the ones that cannot
// be booked right now and why.
struct Quote {
  // RouteClosed is never set by quoteLot: a host view sets it on a quote
  // that would be possible with every edge open (routeClosedQuote below).
  enum class Block : uint8_t { None, NoVehicles, SellerShort, ExportFill, Unreachable, RouteClosed };
  // The material may travel in the class's mode, the class carries its
  // phase, and both sites are on that network with a way between them.
  bool possible = false;
  Block blocked = Block::None;  // why it cannot be booked this hour
  double lot_t = 0;             // one vehicle load, clamped to what is wanted
  double seller_fill = 0;       // seller level / capacity
  double eta_h = 0, km = 0;     // seller's node to buyer's node in the mode
  double ask = 0, bid = 0;      // $/t
  double switch_cost = 0;       // $/t, zero for the contract partner
  double cost = 0;              // $/t landed: ask + freight + time + switch
  bool bookable() const { return possible && blocked == Block::None; }
};

// Nodes where each vehicle class has a vehicle right now (one list per
// catalog class): a class with no list has no vehicles in this world.
std::vector<std::vector<uint32_t>> classNodes(const World& world, const State& state);

// Prices one (seller tank, class) for a buyer tank wanting `want` tonnes at
// `urgency`. With `explain` false it stops at the first reason the lot
// cannot be booked (the hourly pass only needs bookable quotes); with it
// true every possible quote is fully priced and carries its reason.
Quote quoteLot(const World& world, const State& state, const PathCache& paths,
               const MarketParams& params, const std::vector<std::vector<uint32_t>>& class_nodes,
               uint32_t buyer_tank, uint32_t seller_tank, size_t cls, double want,
               double urgency, int contract_seller, bool explain);

// The paths this world would have with every edge open: what "normally
// possible" means when a closure has cut a site off.
PathCache allOpenPaths(const World& world);

// For a lot that quoteLot finds impossible on today's paths: the same lot
// priced on the all-open network. When that is possible and nothing else is
// in the way, the quote comes back blocked as RouteClosed (distance, time
// and prices are the normal route's); `possible` stays false when the class
// could never carry it between the two sites.
Quote routeClosedQuote(const World& world, const State& state, const PathCache& open_paths,
                       const MarketParams& params,
                       const std::vector<std::vector<uint32_t>>& class_nodes, uint32_t buyer_tank,
                       uint32_t seller_tank, size_t cls, double want, double urgency,
                       int contract_seller);

// The host-facing word and sentence for each reason a lot cannot be booked
// (nullptr for Block::None). The sentence for a closed route names the mode.
const char* blockWord(Quote::Block block);
std::string blockSentence(Quote::Block block, crx::Mode mode);

// Books one lot from a bookable quote exactly as the hourly pass does: the
// order joins the dispatch queue, the seller's stock is reserved, the buyer's
// inbound rises and the trade moves the price index. Returns the order id.
uint32_t bookLot(const World& world, State& state, uint32_t buyer_tank, uint32_t seller_tank,
                 size_t cls, double lot_t, double price, double freight_usd, double eta_h,
                 double km, double urgency);

struct ProcurementStats {
  uint32_t orders_created = 0;
  uint32_t lots_unmatched = 0;
  double tons_ordered = 0;
};

// One procurement pass (call hourly, tick % 4 == 0). Refreshes buyer ETA
// bookkeeping (next_eta_tick), matches lots, updates the price index.
void stepProcurement(const World& world, State& state, const PathCache& paths,
                     const std::vector<TankSignals>& signals, const MarketParams& params,
                     ProcurementStats& out, Recorder& rec);

// Re-derives every tank's next_eta_tick from its open inbound orders.
void refreshEtas(const World& world, State& state);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_PROCUREMENT_H
