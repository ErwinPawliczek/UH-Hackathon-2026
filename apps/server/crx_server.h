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

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
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
// The stamp is atomic: it is written under the session mutex while LRU
// eviction and the TTL sweep read it under the registry lock, and the two
// locks are never held together.
struct Session {
  Session(crx_sim* handle, std::chrono::steady_clock::time_point now)
      : sim(handle), lastUsed(now.time_since_epoch().count()) {}
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  crx_sim* sim;
  std::mutex mutex;
  std::atomic<std::chrono::steady_clock::rep> lastUsed;  // steady_clock ticks
};

// In-memory session table (§7.4): capped at `capacity` (least-recently-used
// eviction when full — a new visitor is never refused), entries expire after
// `ttl` of inactivity. Thread-safe. Sessions are held by shared_ptr: lookups
// copy the pointer out under the registry lock, then take the session's own
// mutex with no registry lock held. Erasing an entry only drops the
// registry's reference, so release, eviction and the TTL sweep can never free
// a session an in-flight request is using — destruction happens when the
// last reference drops, outside every lock.
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
  // Returns false when the id is unknown. The shared_ptr is copied out under
  // the registry lock, so the session stays alive even if release, eviction
  // or the TTL sweep erases the entry while fn runs.
  template <class F>
  bool withSession(const std::string& id, F&& fn) {
    std::shared_ptr<Session> s;
    {
      std::lock_guard<std::mutex> lock(globalMutex_);
      const auto it = sessions_.find(id);
      if (it == sessions_.end()) return false;
      s = it->second;
    }
    std::lock_guard<std::mutex> sessionLock(s->mutex);
    s->lastUsed = nowFn_().time_since_epoch().count();
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
  std::unordered_map<std::string, std::shared_ptr<Session>> sessions_;
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
