// PetroGrid server — multiplayer rooms.
//
// A room is one shared run of the default world. The server owns its clock:
// a thread per room steps the engine at `speed` simulated hours per real
// second while the room is running; clients only read and send actions.
// Players join with a name, claim a plant, and may act on that plant alone.
#ifndef CRX_ROOMS_H
#define CRX_ROOMS_H

#include "crx/api.h"

#include <httplib.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace crx {
namespace server {

struct RoomPlayer {
  std::string id, name, token;
  int site = -1;  // world site index, -1 = none claimed
  std::chrono::steady_clock::time_point seen;
};

struct RoomSite {
  std::string key, name, preset;
  bool playable = false;
  std::vector<uint32_t> units;  // global unit indexes at the site
};

class Room {
 public:
  enum class Phase { Lobby, Running, Paused, Ended };

  Room(std::string code, std::string hostToken, crx_sim* sim);
  ~Room();
  Room(const Room&) = delete;
  Room& operator=(const Room&) = delete;

  const std::string code, hostToken;

  // Everything below is guarded by `mutex`; the clock thread takes it only
  // for the few microseconds a step takes.
  std::mutex mutex;
  crx_sim* sim;
  Phase phase = Phase::Lobby;
  double speed = 1.0;        // simulated hours per real second
  double tickDebt = 0.0;     // fractional ticks carried between clock beats
  std::string worldJson;     // static for the room's life
  std::string snapshot;      // the binary snapshot of the current tick
  uint64_t tick = 0;
  std::vector<RoomPlayer> players;
  std::vector<RoomSite> sites;
  uint32_t nextPlayer = 1;
  // Every command the engine accepted, with its tick: host scenarios and
  // players' actions alike. The forecast rebuilds the run from it.
  std::vector<std::pair<uint64_t, std::string>> commands;
  std::atomic<std::chrono::steady_clock::rep> lastUsed;

  // Advances the run by what `elapsed` real seconds are worth at the
  // current speed (nothing unless running). Called by the clock thread;
  // tests call it directly for exact timing.
  void beat(double elapsedSeconds);
  void refreshSnapshotLocked();
  // Starts the room's own clock thread (once). Rooms made for tests without
  // clocks are driven by beat() directly.
  void startClock();

 private:
  std::atomic<bool> stop_{false};
  std::thread clock_;
};

class RoomRegistry {
 public:
  using Clock = std::chrono::steady_clock;
  explicit RoomRegistry(size_t capacity = 4, Clock::duration ttl = std::chrono::minutes(30),
                        bool runClocks = true);

  // A new room on the default world, paused at tick 0. Null when the engine
  // could not build the world.
  std::shared_ptr<Room> create();
  std::shared_ptr<Room> find(const std::string& code);
  void reapExpired();
  size_t size() const;
  void setNowSource(std::function<Clock::time_point()> source) { nowFn_ = std::move(source); }
  Clock::time_point now() const { return nowFn_(); }
  bool runClocks() const { return runClocks_; }

 private:
  size_t capacity_;
  Clock::duration ttl_;
  bool runClocks_;
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<Room>> rooms_;
  std::function<Clock::time_point()> nowFn_ = [] { return Clock::now(); };
};

// Registers /api/room/... on the server.
void registerRoomRoutes(httplib::Server& svr, RoomRegistry& rooms);

}  // namespace server
}  // namespace crx

#endif  // CRX_ROOMS_H
