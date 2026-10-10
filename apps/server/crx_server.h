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

#include "crx/api.h"

#include <httplib.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace crx {
namespace server {

// One hosted simulation: the engine handle, its own mutex (one sim per
// session, calls serialised) and a last-use stamp for inactivity expiry.
struct Session {
  explicit Session(crx_sim* handle) : sim(handle) {}
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  crx_sim* sim;
  std::mutex mutex;
  std::chrono::steady_clock::time_point lastUsed{std::chrono::steady_clock::now()};
};

// In-memory session table (§7.4): capped at `capacity`, entries expire after
// `ttl` of inactivity. Thread-safe. Lock order is always registry → session,
// so a reaped session is never destroyed under a concurrent engine call.
class SessionRegistry {
 public:
  SessionRegistry(size_t capacity = 16,
                  std::chrono::steady_clock::duration ttl = std::chrono::minutes(10));

  enum class CreateStatus { kCreated, kBadConfig, kNotFound, kAtCapacity };
  struct CreateResult {
    CreateStatus status;
    std::string id;
  };

  CreateResult create(const std::string& configJson);
  CreateResult forkFrom(const std::string& parentId);

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
      s->lastUsed = Clock::now();
    }
    std::unique_lock<std::mutex> sessionLock(s->mutex, std::adopt_lock);
    fn(*s);
    return true;
  }

  // Destroys sessions idle beyond the TTL. Called by create() so the cap
  // frees up, and from the reaper thread in main.
  void reapExpired();

  size_t size() const;

 private:
  using Clock = std::chrono::steady_clock;

  std::string nextIdLocked();
  CreateResult insertNew(crx_sim* sim);

  size_t capacity_;
  std::chrono::steady_clock::duration ttl_;
  mutable std::mutex globalMutex_;
  std::unordered_map<std::string, std::unique_ptr<Session>> sessions_;
  uint64_t idCounter_ = 0;
  uint64_t idEntropy_;  // seeded once, from std::random_device
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
