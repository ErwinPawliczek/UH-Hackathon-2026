// Chain Reaction — §5.9 recorder: hourly history and the event log.
#ifndef CRX_SIM_RECORDER_H
#define CRX_SIM_RECORDER_H

#include "sim/state.h"
#include "sim/world.h"

#include <string>
#include <vector>

namespace crx {
namespace sim {

struct Recorder {
  // Series kind 0: tank fill (level ÷ capacity), one ring per tank.
  // Series kind 1: process rate ÷ design rate, one ring per process.
  // §4.4: rolling 60-day windows (5,760 hourly points).
  std::vector<std::vector<float>> tank_fill, proc_rate;
  std::vector<LogEntry> log;
  uint64_t next_seq = 1;
};

// Records one hourly sample (call on ticks where tick % 4 == 0 at dt = 0.25 h).
void recordHourly(const World& world, const State& state, Recorder& rec);

// Appends a log entry with the next sequence number (§7.2).
void logEvent(Recorder& rec, uint64_t tick, const std::string& type, const std::string& site,
              const std::string& unit, const std::string& text);

// JSON array of log entries with seq > since_seq.
std::string eventsJson(const Recorder& rec, uint64_t since_seq);

// Deterministic state fingerprint (determinism rules 4 and 6): FNV-1a over
// the tick, seed, and every mutable scalar. World and recorder excluded —
// they are identical across forks or derived.
uint64_t hashState(const World& world, const State& state);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_RECORDER_H
