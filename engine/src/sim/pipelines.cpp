// Chain Reaction — §5.5 pipeline flow.
#include "sim/pipelines.h"

#include <algorithm>

namespace crx {
namespace sim {

namespace {
constexpr double kPullHours = 4.0;  // §5.5 fixed pull window
}

void stepPipelines(const World& world, State& state) {
  const double dt = kTickHours;
  state.pipe_flow_t_h.resize(world.pipelines.size(), 0.0);

  for (size_t i = 0; i < world.pipelines.size(); ++i) {
    const Pipeline& pipe = world.pipelines[i];
    const Tank& dst = world.tanks[pipe.to.v];
    TankState& from = state.tank[pipe.from.v];
    TankState& to = state.tank[pipe.to.v];

    // §5.5 formula: keep the destination able to serve its design draw and
    // pulling its level back toward target on a 4 h window.
    double wanted = dst.design_out_t_h + (dst.target_frac * dst.capacity_t - to.level_t) / kPullHours;
    wanted = std::clamp(wanted, 0.0, pipe.cap_t_h);

    if (state.tradeBlocked(world.tanks[pipe.from.v].site.v, dst.site.v)) wanted = 0.0;

    const double flow =
        std::min(wanted, std::min(from.level_t / dt, std::max(0.0, dst.capacity_t - to.level_t) / dt));

    from.level_t = std::max(0.0, from.level_t - flow * dt);
    to.level_t = std::min(dst.capacity_t, to.level_t + flow * dt);
    state.pipe_flow_t_h[i] = flow;
    state.pipe_moved_t[i] += flow * dt;
    // A pipeline between two sites is a sale all the same; it books no
    // order, so the scores view values it here at the base price.
    const uint32_t seller = world.tanks[pipe.from.v].site.v;
    if (flow > 0.0 && seller != dst.site.v) {
      const double usd = flow * dt * world.catalog.materials[dst.material].base_price;
      state.site_trade[seller].sold_t += flow * dt;
      state.site_trade[seller].pipe_revenue += usd;
      state.site_trade[dst.site.v].pipe_feed_cost += usd;
    }
  }
}

}  // namespace sim
}  // namespace crx
