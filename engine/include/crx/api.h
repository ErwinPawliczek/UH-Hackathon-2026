// Chain Reaction engine — public C ABI (§7.1).
//
// The whole contract between the C++ engine and its hosts (CLI, wasm). JSON
// for rare structured data (world, commands, event log); one binary snapshot
// (§7.3) for per-frame data, read as typed-array views with no copy.
//
// Pointers returned by these functions are owned by the sim and remain valid
// until the next non-const call on the same crx_sim.
#ifndef CRX_API_H
#define CRX_API_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct crx_sim crx_sim;

/* config_json: {"seed":..,"gen":{..}} or {"world":{..}}; NULL = defaults. */
crx_sim* crx_create(const char* config_json);

/* Failure reason from the most recent crx_create call on this thread: a
   non-empty message after a rejected config (bad JSON, unknown world,
   infeasible generation, failed warm-up gate); empty after a success. The
   pointer stays valid until the next crx_create on the same thread. Hosts
   must treat a null return from crx_create as "read crx_last_error and
   report" — never as a crash. */
const char* crx_last_error(void);

/* Copies State, shares World. Forks the run (baseline twin). */
crx_sim* crx_fork(const crx_sim* src);

void crx_destroy(crx_sim* sim);

/* Advances the simulation by `ticks` fixed ticks of 0.25 h. */
void crx_step(crx_sim* sim, uint32_t ticks);

/* Commands (§7.2): events, overrides, settings. Reply valid until next call. */
const char* crx_command(crx_sim* sim, const char* json);

/* Static description: names, geometry, catalog entries. Read once. */
const char* crx_world_json(const crx_sim* sim);

/* Terrain heights for rendering only; row-major grid, size in cells returned. */
const float* crx_terrain(const crx_sim* sim, uint32_t* n);

/* Binary snapshot (§7.3), rebuilt after the latest step. */
const uint8_t* crx_snapshot(crx_sim* sim, uint32_t* bytes);

/* JSON array of log entries with seq > since_seq. */
const char* crx_events(const crx_sim* sim, uint64_t since_seq);

/* Hourly history. kind 0 = tank fill fraction, indexed by tank id. */
const float* crx_series(const crx_sim* sim, uint32_t kind, uint32_t id, uint32_t* n);

/* KPI vector (§5.10): service level, unmet t, unmet $, production index,
   shutdown hours, stock-outs, freight cost, energy cost. */
const double* crx_kpis(const crx_sim* sim, uint32_t* n);

uint64_t crx_tick(const crx_sim* sim);
uint64_t crx_state_hash(const crx_sim* sim);
const char* crx_version(void);

#ifdef __cplusplus
}
#endif

#endif  // CRX_API_H
