// Chain Reaction — §5.5 pipelines: instantaneous point-to-point flow.
#ifndef CRX_SIM_PIPELINES_H
#define CRX_SIM_PIPELINES_H

#include "sim/state.h"
#include "sim/world.h"

namespace crx {
namespace sim {

// §5.5 — one tick of pipeline movement, in index order. Desired flow is the
// destination's design draw plus a 4 h pull toward its target level,
// clamped to pipe capacity; the realised flow is additionally limited by
// stock at the source and room at the destination. Writes state.pipe_flow
// (t/h) and moves the material.
void stepPipelines(const World& world, State& state);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_PIPELINES_H
