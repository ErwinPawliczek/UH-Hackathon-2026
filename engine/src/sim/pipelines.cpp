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

    const double flow =
        std::min(wanted, std::min(from.level_t / dt, std::max(0.0, dst.capacity_t - to.level_t) / dt));

    from.level_t = std::max(0.0, from.level_t - flow * dt);
    to.level_t = std::min(dst.capacity_t, to.level_t + flow * dt);
    state.pipe_flow_t_h[i] = flow;
  }
}

}  // namespace sim
}  // namespace crx
