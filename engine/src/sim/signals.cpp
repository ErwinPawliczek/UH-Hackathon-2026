// Chain Reaction — §5.2 tank signal computation.
#include "sim/signals.h"

#include "crx/scurve.h"

#include <algorithm>

namespace crx {
namespace sim {

void computeSignals(const World& world, const State& state, std::vector<TankSignals>& out) {
  out.resize(world.tanks.size());
  for (size_t i = 0; i < world.tanks.size(); ++i) {
    const Tank& tk = world.tanks[i];
    const TankState& ts = state.tank[i];
    TankSignals& sg = out[i];

    const double d_out = tk.design_out_t_h;
    if (d_out > 0.0) {
      const double cover_h = std::max(0.0, ts.level_t) / d_out;
      const double room_h = std::max(0.0, ts.level_t + ts.inbound_t) / d_out;
      sg.f = scurve(cover_h / ts.pickup_gap_h, 0.25, 1.25);
      sg.u = 1.0 - scurve(room_h / (ts.lead_time_h * ts.caution), 1.0, 2.5);
    } else {
      sg.f = 1.0;  // no consumer: never ration (§5.2)
      sg.u = 0.0;
    }

    const double d_in = tk.design_in_t_h;
    if (d_in > 0.0) {
      const double room_h = std::max(0.0, tk.capacity_t - ts.level_t) / d_in;
      sg.h = scurve(room_h / ts.pickup_gap_h, 0.10, 1.00);
    } else {
      sg.h = 1.0;  // no producer: never blocks on room (§5.2)
    }
  }
}

}  // namespace sim
}  // namespace crx
