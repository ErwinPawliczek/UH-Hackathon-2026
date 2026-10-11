// Chain Reaction — §5.6 procurement and market implementation.
#include "sim/procurement.h"

#include <algorithm>
#include <cmath>

namespace crx {
namespace sim {

void refreshEtas(const World& world, State& state) {
  for (size_t t = 0; t < world.tanks.size(); ++t) state.tank[t].next_eta_tick = 0;
  for (const Order& o : state.order) {
    if (o.status != OrdStatus::Open && o.status != OrdStatus::Assigned &&
        o.status != OrdStatus::Loaded)
      continue;
    TankState& ts = state.tank[o.to];
    if (ts.next_eta_tick == 0 || o.eta_tick < ts.next_eta_tick) ts.next_eta_tick = o.eta_tick;
  }
}

// Where each class's vehicles are right now. A class is a candidate for a
// seller only when one of its vehicles can reach that seller's node — no
// vehicles, or none on the same stretch of network, and the order would
// wait forever.
std::vector<std::vector<uint32_t>> classNodes(const World& world, const State& state) {
  std::vector<std::vector<uint32_t>> class_nodes(world.catalog.vehicle_classes.size());
  for (size_t v = 0; v < world.fleet.size() && v < state.vehicle.size(); ++v) {
    const uint32_t at = state.vehicle[v].at_node;
    if (at == kNoNode) continue;
    std::vector<uint32_t>& nodes = class_nodes[world.fleet[v].cls];
    if (std::find(nodes.begin(), nodes.end(), at) == nodes.end()) nodes.push_back(at);
  }
  return class_nodes;
}

Quote quoteLot(const World& world, const State& state, const PathCache& paths,
               const MarketParams& params, const std::vector<std::vector<uint32_t>>& class_nodes,
               uint32_t buyer_tank, uint32_t seller_tank, size_t cls, double want,
               double urgency, int contract_seller, bool explain) {
  Quote q;
  const Catalog& catalog = world.catalog;
  const Tank& buyer = world.tanks[buyer_tank];
  const Tank& seller = world.tanks[seller_tank];
  const Material& mat = catalog.materials[buyer.material];
  const VehicleClass& vc = catalog.vehicle_classes[cls];
  if (static_cast<int>(vc.mode) >= kModeCount) return q;  // pipeline: no vehicles
  if (!(mat.modes & (1u << static_cast<uint8_t>(vc.mode)))) return q;
  if (vc.carries != mat.phase) return q;
  if (vc.capacity_t <= 0.0 || vc.speed_kmh <= 0.0) return q;
  if (state.tradeBlocked(seller.site.v, buyer.site.v)) return q;  // one side refuses the other
  const bool no_vehicles = class_nodes[cls].empty();  // the world has no such vehicle
  if (no_vehicles && !explain) return q;

  // One lot = one vehicle load, clamped to what is wanted.
  const TankState& seller_ts = state.tank[seller_tank];
  q.lot_t = std::min(vc.capacity_t, want);
  const bool seller_short = seller_ts.level_t - seller_ts.reserved_out_t < q.lot_t - 1e-9;
  if (seller_short && !explain) return q;

  // Port export rule (§5.6): patient buyers only tap sellers above the fill
  // line, so exports never rob the domestic chain.
  q.seller_fill = seller.capacity_t > 0 ? seller_ts.level_t / seller.capacity_t : 0.0;
  const bool export_fill = buyer.export_buy && q.seller_fill < params.export_seller_fill;
  if (export_fill && !explain) return q;

  // Route in the class's mode between the two sites' mode nodes.
  const Site& seller_site = world.sites[seller.site.v];
  const Site& buyer_site = world.sites[buyer.site.v];
  const uint32_t from = seller_site.node[modeIndex(vc.mode)];
  const uint32_t to = buyer_site.node[modeIndex(vc.mode)];
  if (from == kNoNode || to == kNoNode) return q;
  q.eta_h = travelHours(world, paths, vc.mode, from, to);
  q.km = travelKm(world, paths, vc.mode, from, to);
  if (!std::isfinite(q.eta_h) || !std::isfinite(q.km)) return q;
  q.possible = true;

  bool unreachable = true;
  for (const uint32_t at : class_nodes[cls])
    if (std::isfinite(travelHours(world, paths, vc.mode, at, from))) {
      unreachable = false;
      break;
    }
  q.blocked = no_vehicles    ? Quote::Block::NoVehicles
              : seller_short ? Quote::Block::SellerShort
              : export_fill  ? Quote::Block::ExportFill
              : unreachable  ? Quote::Block::Unreachable
                             : Quote::Block::None;
  if (q.blocked != Quote::Block::None && !explain) return q;

  // §5.6 price formation and cost, all per tonne.
  const double base = mat.base_price;
  q.ask = base * (1.0 + params.beta * (1.0 - 2.0 * q.seller_fill));
  // The seller's own markup (set_price) on top of the rule.
  const double markup = state.site_markup[seller.site.v];
  if (markup != 0.0) q.ask *= 1.0 + markup;
  q.bid = base * (1.0 + params.beta * urgency);
  q.switch_cost =
      (static_cast<int>(seller_tank) == contract_seller) ? 0.0 : params.switch_cost_frac * base;
  q.cost = q.ask + vc.freight * q.km + urgency * params.value_of_time_usd_t_h * q.eta_h +
           q.switch_cost;
  return q;
}

PathCache allOpenPaths(const World& world) {
  State open;  // only the edge flags matter to the path builder
  open.edge_open.assign(world.edges.size(), 1);
  PathCache cache;
  refreshPaths(world, open, cache);
  return cache;
}

Quote routeClosedQuote(const World& world, const State& state, const PathCache& open_paths,
                       const MarketParams& params,
                       const std::vector<std::vector<uint32_t>>& class_nodes, uint32_t buyer_tank,
                       uint32_t seller_tank, size_t cls, double want, double urgency,
                       int contract_seller) {
  Quote q = quoteLot(world, state, open_paths, params, class_nodes, buyer_tank, seller_tank, cls,
                     want, urgency, contract_seller, true);
  // The closed route is the reason only when it is the only one; a seller
  // that is also short, say, keeps saying so.
  if (q.possible && q.blocked == Quote::Block::None) q.blocked = Quote::Block::RouteClosed;
  return q;
}

const char* blockWord(Quote::Block block) {
  switch (block) {
    case Quote::Block::NoVehicles: return "no_vehicles";
    case Quote::Block::SellerShort: return "seller_short";
    case Quote::Block::ExportFill: return "export_fill";
    case Quote::Block::Unreachable: return "unreachable";
    case Quote::Block::RouteClosed: return "route_closed";
    case Quote::Block::None: break;
  }
  return nullptr;
}

std::string blockSentence(Quote::Block block, crx::Mode mode) {
  switch (block) {
    case Quote::Block::NoVehicles: return "there are no vehicles of that class";
    case Quote::Block::SellerShort: return "the seller does not have that much free stock";
    case Quote::Block::ExportFill: return "the seller is below its export fill line";
    case Quote::Block::Unreachable: return "no vehicle of that class can reach the seller";
    case Quote::Block::RouteClosed:
      return std::string("the ") +
             (mode == crx::Mode::River ? "river lane" : mode == crx::Mode::Sea ? "sea lane" : "road") +
             " to this site is closed";
    case Quote::Block::None: break;
  }
  return {};
}

uint32_t bookLot(const World& world, State& state, uint32_t buyer_tank, uint32_t seller_tank,
                 size_t cls, double lot_t, double price, double freight_usd, double eta_h,
                 double km, double urgency) {
  const Tank& buyer = world.tanks[buyer_tank];
  const Material& mat = world.catalog.materials[buyer.material];
  Order o;
  o.from = seller_tank;
  o.to = buyer_tank;
  o.material = buyer.material;
  o.qty_t = lot_t;
  o.price = price;
  o.freight_usd = freight_usd;
  o.km = km;
  o.urgency = urgency;
  o.cls = static_cast<uint16_t>(cls);
  o.vehicle = UINT32_MAX;  // dispatch assigns (§5.7)
  o.created_tick = state.tick;
  o.eta_tick = state.tick + static_cast<uint64_t>(std::ceil(eta_h / kTickHours));
  o.status = OrdStatus::Open;
  state.order.push_back(o);
  state.tank[seller_tank].reserved_out_t += lot_t;
  state.tank[buyer_tank].inbound_t += lot_t;
  // Realized trades pull the index toward price ÷ base (§5.6 index).
  double& idx = state.price_index[buyer.material];
  idx = std::clamp(idx + 0.1 * (price / mat.base_price - idx), 0.25, 4.0);
  return static_cast<uint32_t>(state.order.size() - 1);
}

void stepProcurement(const World& world, State& state, const PathCache& paths,
                     const std::vector<TankSignals>& signals, const MarketParams& params,
                     ProcurementStats& out, Recorder& rec) {
  const Catalog& catalog = world.catalog;
  const std::vector<std::vector<uint32_t>> class_nodes = classNodes(world, state);

  // Collect buy-side requests: externally fed tanks with a consumer draw and
  // positive urgency (§5.6). Export tanks (§5.6 port rule) order at a fixed
  // low urgency and only match sellers above the 70% fill line.
  struct Request {
    uint32_t tank;
    double urgency, want;
  };
  std::vector<Request> requests;
  for (size_t t = 0; t < world.tanks.size(); ++t) {
    const Tank& tk = world.tanks[t];
    const TankState& ts = state.tank[t];
    if (tk.piped_in || tk.design_out_t_h <= 0.0) continue;
    if (tk.role != TankRole::Feed && tk.role != TankRole::Both) continue;

    const double u = tk.export_buy ? params.export_urgency : signals[t].u;
    if (u <= 0.0) continue;
    const double target = tk.target_frac * tk.capacity_t;
    const double want = target - (ts.level_t + ts.inbound_t);
    if (want <= 0.0) continue;
    requests.push_back({static_cast<uint32_t>(t), u, want});
  }
  // Most urgent first; ties break to the lower tank id (deterministic).
  std::sort(requests.begin(), requests.end(), [](const Request& a, const Request& b) {
    if (a.urgency != b.urgency) return a.urgency > b.urgency;
    return a.tank < b.tank;
  });

  for (const Request& req : requests) {
    const Tank& buyer = world.tanks[req.tank];

    // The contract partner, if any (§5.6: zero switch cost there).
    int contract_seller = -1;
    for (size_t c = 0; c < world.contracts.size(); ++c)
      if (world.contracts[c].buyer.v == req.tank) contract_seller = world.contracts[c].seller.v;

    double want = req.want;
    for (uint32_t lot = 0; lot < params.max_lots_per_tank && want > 1e-6; ++lot) {
      // Scan (seller, class) candidates; the cheapest wins (ties → lowest
      // seller id, then class id: the scan order is by tank id, and only a
      // strictly lower cost replaces the incumbent).
      struct Candidate {
        uint32_t seller_tank, cls;
        double cost, price, freight_usd, eta_h, km;
      };
      Candidate best{};
      bool found = false;

      for (size_t s = 0; s < world.tanks.size(); ++s) {
        const Tank& seller = world.tanks[s];
        if (seller.site == buyer.site) continue;  // on-site stock needs no vehicle
        if (seller.material != buyer.material) continue;
        if (seller.role != TankRole::Product && seller.role != TankRole::Both) continue;

        for (size_t cls = 0; cls < catalog.vehicle_classes.size(); ++cls) {
          const Quote q = quoteLot(world, state, paths, params, class_nodes, req.tank,
                                   static_cast<uint32_t>(s), cls, want, req.urgency,
                                   contract_seller, false);
          if (!q.bookable()) continue;
          if (!found || q.cost < best.cost) {
            best = {static_cast<uint32_t>(s), static_cast<uint32_t>(cls), q.cost,
                    (q.ask + q.bid) / 2.0,
                    q.lot_t * catalog.vehicle_classes[cls].freight * q.km, q.eta_h, q.km};
            found = true;
          }
        }
      }

      if (!found) {
        // A lot with no candidate stays open and pushes the material's
        // price index up (§5.6).
        out.lots_unmatched += 1;
        double& idx = state.price_index[buyer.material];
        idx = std::clamp(idx * 1.01, 0.25, 4.0);
        break;  // identical candidates face the next, smaller lot — retry hourly
      }

      // Book the order: cheapest candidate wins; reserve the seller's stock
      // and raise the buyer's inbound (§5.6).
      const double lot_t = std::min(catalog.vehicle_classes[best.cls].capacity_t, want);
      // Minimum lot (MarketParams): too small a lot waits for a later hour.
      // Not a failed match, so neither the count nor the price index moves.
      if (params.min_lot_cap_frac > 0.0 && params.min_lot_target_frac > 0.0) {
        const double min_lot =
            std::min(params.min_lot_cap_frac * catalog.vehicle_classes[best.cls].capacity_t,
                     params.min_lot_target_frac * buyer.target_frac * buyer.capacity_t);
        if (lot_t < min_lot - 1e-9) break;
      }
      bookLot(world, state, req.tank, best.seller_tank, best.cls, lot_t, best.price,
              best.freight_usd, best.eta_h, best.km, req.urgency);

      out.orders_created += 1;
      out.tons_ordered += lot_t;
      want -= lot_t;
    }
  }

  refreshEtas(world, state);
  (void)rec;  // matching is silent; dispatch and delivery log (§7.2)
}

}  // namespace sim
}  // namespace crx
