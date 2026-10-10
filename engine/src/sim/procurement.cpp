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

void stepProcurement(const World& world, State& state, const PathCache& paths,
                     const std::vector<TankSignals>& signals, const MarketParams& params,
                     ProcurementStats& out, Recorder& rec) {
  const Catalog& catalog = world.catalog;

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
    const Material& mat = catalog.materials[buyer.material];

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
        double cost, price, freight_usd, eta_h;
      };
      Candidate best{};
      bool found = false;

      for (size_t s = 0; s < world.tanks.size(); ++s) {
        const Tank& seller = world.tanks[s];
        if (seller.site == buyer.site) continue;  // on-site stock needs no vehicle
        if (seller.material != buyer.material) continue;
        if (seller.role != TankRole::Product && seller.role != TankRole::Both) continue;

        const TankState& seller_ts = state.tank[s];

        for (size_t cls = 0; cls < catalog.vehicle_classes.size(); ++cls) {
          const VehicleClass& vc = catalog.vehicle_classes[cls];
          if (static_cast<int>(vc.mode) >= kModeCount) continue;  // pipeline: no vehicles
          if (!(mat.modes & (1u << static_cast<uint8_t>(vc.mode)))) continue;
          if (vc.carries != mat.phase) continue;
          if (vc.capacity_t <= 0.0 || vc.speed_kmh <= 0.0) continue;

          // One lot = one vehicle load, clamped to what is wanted.
          const double lot_t = std::min(vc.capacity_t, want);
          if (seller_ts.level_t - seller_ts.reserved_out_t < lot_t - 1e-9) continue;

          // Port export rule (§5.6): patient buyers only tap sellers above
          // the fill line, so exports never rob the domestic chain.
          const double seller_fill =
              seller.capacity_t > 0 ? seller_ts.level_t / seller.capacity_t : 0.0;
          if (buyer.export_buy && seller_fill < params.export_seller_fill) continue;

          // Route in the class's mode between the two sites' mode nodes.
          const Site& seller_site = world.sites[seller.site.v];
          const Site& buyer_site = world.sites[buyer.site.v];
          const uint32_t from = seller_site.node[modeIndex(vc.mode)];
          const uint32_t to = buyer_site.node[modeIndex(vc.mode)];
          if (from == kNoNode || to == kNoNode) continue;
          const double eta_h = travelHours(world, paths, vc.mode, from, to);
          const double km = travelKm(world, paths, vc.mode, from, to);
          if (!std::isfinite(eta_h) || !std::isfinite(km)) continue;

          // §5.6 price formation and cost, all per tonne.
          const double base = mat.base_price;
          const double ask = base * (1.0 + params.beta * (1.0 - 2.0 * seller_fill));
          const double bid = base * (1.0 + params.beta * req.urgency);
          const double switch_cost =
              (static_cast<int>(s) == contract_seller) ? 0.0 : params.switch_cost_frac * base;
          const double cost = ask + vc.freight * km +
                              req.urgency * params.value_of_time_usd_t_h * eta_h + switch_cost;

          if (!found || cost < best.cost) {
            best = {static_cast<uint32_t>(s), static_cast<uint32_t>(cls), cost, (ask + bid) / 2.0,
                    lot_t * vc.freight * km, eta_h};
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
      Order o;
      o.from = best.seller_tank;
      o.to = req.tank;
      o.material = buyer.material;
      o.qty_t = lot_t;
      o.price = best.price;
      o.freight_usd = best.freight_usd;
      o.urgency = req.urgency;
      o.cls = static_cast<uint16_t>(best.cls);
      o.vehicle = UINT32_MAX;  // dispatch assigns (§5.7)
      o.created_tick = state.tick;
      o.eta_tick = state.tick + static_cast<uint64_t>(std::ceil(best.eta_h / kTickHours));
      o.status = OrdStatus::Open;
      state.order.push_back(o);
      state.tank[best.seller_tank].reserved_out_t += lot_t;
      state.tank[req.tank].inbound_t += lot_t;
      // Realized trades pull the index toward price ÷ base (§5.6 index).
      double& idx = state.price_index[buyer.material];
      idx = std::clamp(idx + 0.1 * (best.price / mat.base_price - idx), 0.25, 4.0);

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
