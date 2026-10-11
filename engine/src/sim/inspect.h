// Chain Reaction — read-only views of live state for hosts.
//
// Answers a host asks about one thing in the run that the per-frame snapshot
// does not carry: where a vehicle is going and what it holds. Nothing here
// changes state.
#ifndef CRX_SIM_INSPECT_H
#define CRX_SIM_INSPECT_H

#include "sim/recorder.h"
#include "sim/state.h"
#include "sim/world.h"

#include <cstdint>
#include <string>

namespace crx {
namespace sim {

// Status names used in host JSON, in VehStatus order.
const char* vehicleStatusName(VehStatus status);

// One vehicle as JSON: class, status, cargo, the order it is serving with
// both ends named, the site it stands at, where its current leg ends, and
// the path from where it is now to that end along the route polylines.
// Returns an empty string when `index` is not a vehicle.
std::string vehicleJson(const World& world, const State& state, uint32_t index);

class Sim;

// Sourcing for one buying tank (site key or index, material key): how much
// cover it has, and every way of supplying it priced as procurement prices
// it — seller, vehicle class, distance, time, lot, landed cost — with
// whether it can be booked right now, whether it arrives before the tank is
// dry, which one the next hourly pass books (from a dry run on a copy of the
// run) and which seller has supplied it most so far. An unknown site,
// material or tank gives {"error": "..."}.
std::string sourcingJson(const Sim& sim, const std::string& site, const std::string& material);

// Every tank that buys by vehicle and has at least one possible supplier:
// the list a host builds its picker from.
std::string buyTanksJson(const Sim& sim);

// The run so far in time buckets of `bucket_h` hours (the last one partial):
// per material what was ordered, spent, delivered and its price index; per
// vehicle class what it moved; per bucket the money and service totals; per
// plant the band its rate moved in. Built from the order book and the
// recorder's hourly history.
// Per-site money since tick 0 for the multiplayer scores: revenue, feed
// cost, freight, energy and profit (vehicle trades from the ledger plus
// pipeline flows at the base price), tonnes sold, the site's markup and rate
// share, and a rank by profit (1 = best) among sites that run processes.
std::string scoresJson(const World& world, const State& state);

std::string economyJson(const World& world, const State& state, const Recorder& rec,
                        uint32_t bucket_h);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_INSPECT_H
