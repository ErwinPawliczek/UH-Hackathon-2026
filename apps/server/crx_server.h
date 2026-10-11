// crx-server — HTTP host over the C ABI (§7.4).
//
// One thin layer between HTTP and the engine: routes map 1:1 onto the ABI
// (§7.1), sessions live in memory only, and every engine call runs
// synchronously behind a per-session mutex. The engine stays single-threaded
// and unaware of sockets.
//
// Binary responses carry little-endian scalars (f32 for series, f64 for KPIs),
// matching the snapshot convention of §7.3.
#ifndef CRX_SERVER_H
#define CRX_SERVER_H

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include "crx/api.h"

#include <httplib.h>

namespace crx {
namespace server {

// One hosted simulation: the engine handle, its own mutex (one sim per
// session, calls serialised) and a last-use stamp for inactivity expiry.
struct Session {
  Session(crx_sim* handle, std::chrono::steady_clock::time_point now)
      : sim(handle), lastUsed(now) {}
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  crx_sim* sim;
  std::mutex mutex;
  std::chrono::steady_clock::time_point lastUsed;
};

// In-memory session table (§7.4): capped at `capacity` (least-recently-used
// eviction when full — a new visitor is never refused), entries expire after
// `ttl` of inactivity. Thread-safe. Lock order is always registry → session,
// so a reaped or released session is never destroyed under a concurrent
// engine call.
class SessionRegistry {
 public:
  using Clock = std::chrono::steady_clock;

  SessionRegistry(size_t capacity = 200,
                  std::chrono::steady_clock::duration ttl = std::chrono::minutes(2));

  enum class CreateStatus { kCreated, kBadConfig, kNotFound };
  struct CreateResult {
    CreateStatus status;
    std::string id;
  };

  CreateResult create(const std::string& configJson);
  CreateResult forkFrom(const std::string& parentId);

  // Destroys the named session now, without waiting for the TTL: the client
  // calls DELETE /api/sim/{id} whenever it replaces or leaves a session.
  // Returns false when the id is unknown (already released or never existed).
  bool release(const std::string& id);

  // Runs fn(session) with the session locked and its last-use stamp touched.
  // Returns false when the id is unknown.
  template <class F>
  bool withSession(const std::string& id, F&& fn) {
    Session* s = nullptr;
    {
      std::lock_guard<std::mutex> lock(globalMutex_);
      const auto it = sessions_.find(id);
      if (it == sessions_.end()) return false;
      s = it->second.get();
      s->mutex.lock();  // acquired while the registry lock is held: excludes reap
      s->lastUsed = nowFn_();
    }
    std::unique_lock<std::mutex> sessionLock(s->mutex, std::adopt_lock);
    fn(*s);
    return true;
  }

  // Destroys sessions idle beyond the TTL. Called by create() so the cap
  // frees up, and from the reaper thread in main.
  void reapExpired();

  size_t size() const;

  // Test seam: replace the source of "now" so TTL and LRU behaviour are
  // testable without sleeps. Not synchronised — set it before concurrent use.
  void setNowSource(std::function<Clock::time_point()> source) { nowFn_ = std::move(source); }

 private:
  std::string nextIdLocked();
  CreateResult insertNew(crx_sim* sim);

  size_t capacity_;
  std::chrono::steady_clock::duration ttl_;
  mutable std::mutex globalMutex_;
  std::unordered_map<std::string, std::unique_ptr<Session>> sessions_;
  uint64_t idCounter_ = 0;
  uint64_t idEntropy_;  // seeded once, from std::random_device
  std::function<Clock::time_point()> nowFn_ = [] { return Clock::now(); };
};

// Registers every §7.4 route on svr. When webDir contains an index.html it is
// served at "/" (the built front end, same origin); otherwise "/" serves a
// minimal placeholder page pointing at the build command.
void registerRoutes(httplib::Server& svr, SessionRegistry& sessions, const std::string& webDir);

// Highest step request accepted per call; a year of sim time is far above any
// client cadence (§8 tops out at one week per 250 ms) but bounds a runaway.
constexpr uint32_t kMaxTicksPerRequest = 96 * 366;

}  // namespace server
}  // namespace crx

#endif  // CRX_SERVER_H
