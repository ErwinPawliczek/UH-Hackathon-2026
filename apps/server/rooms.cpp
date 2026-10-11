// PetroGrid server — multiplayer rooms: implementation.
#include "rooms.h"

#include "crx_server.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <thread>
#include <cmath>
#include <random>
#include <set>

namespace crx {
namespace server {

namespace json = nlohmann;

namespace {

constexpr size_t kMaxPlayers = 40;
constexpr double kMinSpeed = 0.1, kMaxSpeed = 64.0;
constexpr int kBeatMs = 50;
constexpr uint32_t kMaxTicksPerBeat = 4 * 64;  // one real second's worth at top speed

// Customers, ports and the gas grid are the market, not players.
const std::set<std::string> kNotPlayable = {"FUEL_DEPOT", "GAS_GRID", "PACKAGING", "CONSTRUCTION",
                                            "CONSUMER_GOODS", "PAINTS_COATINGS",
                                            "PROCESS_INDUSTRIES", "PORT_TERMINAL"};
// Fields and mines have an output but no input: playable only when the host says so.
const std::set<std::string> kSources = {"OIL_FIELD", "GAS_FIELD", "SALT_MINE"};

std::mt19937_64& rng() {
  static std::mt19937_64 gen{std::random_device{}()};
  return gen;
}
std::mutex& rngMutex() {
  static std::mutex m;
  return m;
}

std::string randomCode() {
  // No I, O or similar: the code is read off a screen and typed on a phone.
  static const char letters[] = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  std::lock_guard<std::mutex> lock(rngMutex());
  std::string out;
  for (int i = 0; i < 4; ++i) out += letters[rng()() % (sizeof letters - 1)];
  return out;
}

std::string randomToken() {
  static const char hex[] = "0123456789abcdef";
  std::lock_guard<std::mutex> lock(rngMutex());
  std::string out;
  for (int i = 0; i < 24; ++i) out += hex[rng()() % 16];
  return out;
}

void sendJson(httplib::Response& res, int status, const std::string& body) {
  res.status = status;
  res.set_content(body, "application/json");
  res.set_header("Cache-Control", "no-store");
}

std::string no(const std::string& why) { return json::json{{"ok", false}, {"error", why}}.dump(); }

const char* phaseName(Room::Phase p) {
  return p == Room::Phase::Lobby ? "lobby" : p == Room::Phase::Running ? "running"
         : p == Room::Phase::Paused ? "paused" : "ended";
}

std::string trimmed(std::string s) {
  const auto space = [](unsigned char c) { return std::isspace(c) != 0; };
  while (!s.empty() && space(static_cast<unsigned char>(s.front()))) s.erase(s.begin());
  while (!s.empty() && space(static_cast<unsigned char>(s.back()))) s.pop_back();
  return s;
}

// Sends one command to the room's engine (room locked) and logs it with its
// tick when the engine took it.
// `actor` is the player id behind a play action, empty for the host. An
// accepted command also goes to every shadow but the actor's own, whose
// shadow is made here from the run as it stood just before their first one.
std::string issue(Room& room, const json::json& command, const std::string& actor = std::string()) {
  const std::string text = command.dump();
  crx_sim* before = nullptr;
  if (!actor.empty() && room.shadows.count(actor) == 0) {
    before = crx_fork(room.sim);
    if (before != nullptr) crx_mute(before);
  }
  const std::string reply = crx_command(room.sim, text.c_str());
  const json::json r = json::json::parse(reply, nullptr, false);
  const bool ok = r.is_object() && r.value("ok", false);
  if (ok) {
    room.commands.emplace_back(crx_tick(room.sim), text);
    for (const auto& shadow : room.shadows)
      if (shadow.first != actor) crx_command(shadow.second, text.c_str());
    if (before != nullptr) room.shadows.emplace(actor, before);
  } else if (before != nullptr) {
    crx_destroy(before);
  }
  room.refreshSnapshotLocked();
  return reply;
}

// Lost customer sales so far, at base prices (the forecast's unmet_usd).
double lostSalesUsd(crx_sim* sim) {
  uint32_t n = 0;
  const double* kpis = crx_kpis(sim, &n);
  return n > 2 ? kpis[2] : 0.0;
}

RoomPlayer* playerByToken(Room& room, const std::string& token) {
  for (RoomPlayer& p : room.players)
    if (!token.empty() && p.token == token) return &p;
  return nullptr;
}

}  // namespace

Room::Room(std::string c, std::string h, crx_sim* s)
    : code(std::move(c)), hostToken(std::move(h)), sim(s), lastUsed(0) {
  worldJson = crx_world_json(sim);
  const json::json world = json::json::parse(worldJson, nullptr, false);
  if (world.is_object() && world.contains("sites"))
    for (const json::json& site : world["sites"]) {
      RoomSite rs;
      rs.key = site.value("key", std::string());
      rs.name = site.value("name", std::string());
      rs.preset = site.value("preset", std::string());
      rs.playable = kNotPlayable.count(rs.preset) == 0;
      rs.source = kSources.count(rs.preset) != 0;
      if (site.contains("processes"))
        for (const json::json& proc : site["processes"])
          if (proc.contains("units"))
            for (const json::json& unit : proc["units"])
              if (unit.contains("index")) rs.units.push_back(unit["index"].get<uint32_t>());
      sites.push_back(std::move(rs));
    }
  refreshSnapshotLocked();
}

Room::~Room() {
  stop_.store(true);
  if (clock_.joinable()) clock_.join();
  for (const auto& shadow : shadows) crx_destroy(shadow.second);
  if (baseline != nullptr) crx_destroy(baseline);
  crx_destroy(sim);
}

void Room::refreshSnapshotLocked() {
  uint32_t bytes = 0;
  const uint8_t* data = crx_snapshot(sim, &bytes);
  snapshot.assign(reinterpret_cast<const char*>(data), bytes);
  tick = crx_tick(sim);
}

void Room::beat(double elapsedSeconds) {
  std::lock_guard<std::mutex> lock(mutex);
  if (phase != Phase::Running) return;
  tickDebt += speed * 4.0 * elapsedSeconds;  // 4 ticks to the simulated hour
  const double whole = std::floor(tickDebt);
  if (whole < 1.0) return;
  tickDebt -= whole;
  const uint32_t ticks = static_cast<uint32_t>(std::min<double>(whole, kMaxTicksPerBeat));
  crx_step(sim, ticks);
  for (const auto& shadow : shadows) crx_step(shadow.second, ticks);
  if (baseline != nullptr) crx_step(baseline, ticks);
  refreshSnapshotLocked();
}

RoomRegistry::RoomRegistry(size_t capacity, Clock::duration ttl, bool runClocks)
    : capacity_(std::max<size_t>(capacity, 1)), ttl_(ttl), runClocks_(runClocks) {}

size_t RoomRegistry::size() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rooms_.size();
}

void RoomRegistry::reapExpired() {
  std::vector<std::shared_ptr<Room>> gone;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now = nowFn_().time_since_epoch().count();
    for (auto it = rooms_.begin(); it != rooms_.end();) {
      if (now - it->second->lastUsed.load() > ttl_.count()) {
        gone.push_back(std::move(it->second));
        it = rooms_.erase(it);
      } else {
        ++it;
      }
    }
  }
  gone.clear();  // clocks stop and engines are freed outside the registry lock
}

std::shared_ptr<Room> RoomRegistry::find(const std::string& code) {
  std::string upper = code;
  for (char& c : upper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = rooms_.find(upper);
  if (it == rooms_.end()) return nullptr;
  it->second->lastUsed = nowFn_().time_since_epoch().count();
  return it->second;
}

// The room's clock: a beat every 50 ms, each worth the real time since the
// last one, so a late beat catches up instead of losing time.
namespace {
void runClock(Room* room, std::atomic<bool>* stop) {
  auto last = std::chrono::steady_clock::now();
  while (!stop->load(std::memory_order_relaxed)) {
    std::this_thread::sleep_for(std::chrono::milliseconds(kBeatMs));
    const auto now = std::chrono::steady_clock::now();
    const double elapsed = std::chrono::duration<double>(now - last).count();
    last = now;
    room->beat(std::min(elapsed, 1.0));  // a stalled machine does not burst a minute of ticks
  }
}
}  // namespace

std::shared_ptr<Room> RoomRegistry::create(const std::string& world) {
  reapExpired();
  // A plain name only: it becomes a file name in the worlds directory.
  if (world.empty() || world.size() > 64) return nullptr;
  for (const char c : world)
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_')) return nullptr;
  const std::string config = json::json{{"seed", 42}, {"world", world}}.dump();
  crx_sim* sim = crx_create(config.c_str());
  if (sim == nullptr) return nullptr;
  std::shared_ptr<Room> victim;
  std::shared_ptr<Room> room;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (rooms_.size() >= capacity_) {
      // Full: the room nobody has touched for longest makes way.
      const auto lru = std::min_element(rooms_.begin(), rooms_.end(), [](const auto& a, const auto& b) {
        return a.second->lastUsed.load() < b.second->lastUsed.load();
      });
      victim = std::move(lru->second);
      rooms_.erase(lru);
    }
    std::string code;
    do {
      code = randomCode();
    } while (rooms_.count(code) != 0);
    room = std::make_shared<Room>(code, randomToken(), sim);
    room->world = world;
    room->config = config;
    room->lastUsed = nowFn_().time_since_epoch().count();
    rooms_.emplace(code, room);
  }
  victim.reset();
  return room;
}

void Room::startClock() {
  if (!clock_.joinable()) clock_ = std::thread(runClock, this, &stop_);
}

void registerRoomRoutes(httplib::Server& svr, RoomRegistry& rooms) {
  const std::string code = "([A-Za-z]{4})";
  using Req = httplib::Request;
  using Res = httplib::Response;

  const auto body = [](const Req& req) {
    json::json j = json::json::parse(req.body.empty() ? "{}" : req.body, nullptr, false);
    return j.is_object() ? j : json::json::object();
  };
  const auto str = [](const json::json& j, const char* key) {
    return j.contains(key) && j[key].is_string() ? j[key].get<std::string>() : std::string();
  };
  const auto room404 = [](Res& res) { sendJson(res, 404, no("There is no room with that code")); };

  // Opening a room is the one costly call, so a deployment can lock it behind
  // a password (CRX_HOST_PASSWORD). It is checked here and never sent to a page.
  svr.Post("/api/room", [&rooms, body, str](const Req& req, Res& res) {
    if (const char* want = std::getenv("CRX_HOST_PASSWORD"); want && *want) {
      const std::string got = str(body(req), "password");
      const std::string need = want;
      unsigned char diff = got.size() == need.size() ? 0 : 1;
      for (std::size_t i = 0; i < need.size(); ++i) diff |= static_cast<unsigned char>(need[i] ^ (i < got.size() ? got[i] : 0));
      if (diff != 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(700));  // slow guessing down
        return sendJson(res, 200, no(got.empty() ? "Enter the host password" : "That host password is not right"));
      }
    }
    const json::json b = body(req);
    if (b.contains("world") && !b["world"].is_string())
      return sendJson(res, 200, no("Name the world as text"));
    const std::string world = b.contains("world") ? b["world"].get<std::string>() : "erwin-world-v1";
    const std::shared_ptr<Room> room = rooms.create(world);
    if (!room)
      return b.contains("world") ? sendJson(res, 200, no("There is no world called " + world))
                                 : sendJson(res, 500, no("The world could not be built"));
    if (rooms.runClocks()) room->startClock();
    sendJson(res, 200,
             json::json{{"code", room->code}, {"hostToken", room->hostToken}, {"world", room->world}}.dump());
  });

  svr.Get("/api/room/" + code, [&rooms, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    const auto now = rooms.now();
    std::lock_guard<std::mutex> lock(room->mutex);
    if (RoomPlayer* me = playerByToken(*room, req.get_param_value("token"))) me->seen = now;
    json::json players = json::json::array(), sites = json::json::array();
    std::vector<std::string> owner(room->sites.size());
    for (const RoomPlayer& p : room->players) {
      if (p.site >= 0 && p.site < static_cast<int>(owner.size())) owner[static_cast<size_t>(p.site)] = p.id;
      players.push_back({{"id", p.id},
                         {"name", p.name},
                         {"site", p.site >= 0 ? json::json(p.site) : json::json(nullptr)},
                         {"connected", now - p.seen < std::chrono::seconds(10)}});
    }
    for (size_t i = 0; i < room->sites.size(); ++i) {
      const RoomSite& s = room->sites[i];
      sites.push_back({{"index", i},
                       {"key", s.key},
                       {"name", s.name},
                       {"preset", s.preset},
                       {"playable", s.playable && (room->allowSources || !s.source)},
                       {"owner", owner[i].empty() ? json::json(nullptr) : json::json(owner[i])}});
    }
    sendJson(res, 200,
             json::json{{"code", room->code},
                        {"world", room->world},
                        {"phase", phaseName(room->phase)},
                        {"tick", room->tick},
                        {"speed", room->speed},
                        {"allowSources", room->allowSources},
                        {"players", players},
                        {"sites", sites}}
                 .dump());
  });

  svr.Post("/api/room/" + code + "/join", [&rooms, body, str, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    std::string name = trimmed(str(body(req), "name"));
    if (name.empty() || name.size() > 20)
      return sendJson(res, 200, no("Give a name of 1 to 20 characters"));
    std::lock_guard<std::mutex> lock(room->mutex);
    if (room->phase == Room::Phase::Ended) return sendJson(res, 200, no("This simulation has ended"));
    if (room->players.size() >= kMaxPlayers) return sendJson(res, 200, no("This room is full"));
    // Two Sams become Sam and Sam 2.
    std::string unique = name;
    for (int n = 2;; ++n) {
      bool taken = false;
      for (const RoomPlayer& p : room->players) taken = taken || p.name == unique;
      if (!taken) break;
      unique = name.substr(0, 17) + " " + std::to_string(n);
    }
    RoomPlayer p;
    p.id = "p" + std::to_string(room->nextPlayer++);
    p.name = unique;
    p.token = randomToken();
    p.seen = rooms.now();
    room->players.push_back(p);
    sendJson(res, 200, json::json{{"playerId", p.id}, {"token", p.token}, {"name", p.name}}.dump());
  });

  svr.Post("/api/room/" + code + "/claim", [&rooms, body, str, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    const json::json b = body(req);
    std::lock_guard<std::mutex> lock(room->mutex);
    RoomPlayer* me = playerByToken(*room, str(b, "token"));
    if (me == nullptr) return sendJson(res, 200, no("Join the room first"));
    me->seen = rooms.now();
    if (!b.contains("site") || b["site"].is_null()) {
      if (room->phase != Room::Phase::Lobby)
        return sendJson(res, 200, no("Plants cannot be given up once the simulation has started"));
      me->site = -1;
      return sendJson(res, 200, json::json{{"ok", true}}.dump());
    }
    if (!b["site"].is_number_unsigned() || b["site"].get<uint64_t>() >= room->sites.size())
      return sendJson(res, 200, no("There is no such plant"));
    const int site = static_cast<int>(b["site"].get<uint64_t>());
    if (!room->sites[static_cast<size_t>(site)].playable)
      return sendJson(res, 200, no(room->sites[static_cast<size_t>(site)].name +
                                   " is a customer, not a plant to run"));
    if (room->sites[static_cast<size_t>(site)].source && !room->allowSources)
      return sendJson(res, 200, no(room->sites[static_cast<size_t>(site)].name +
                                   " is a source, and the host has kept sources out of this session"));
    for (const RoomPlayer& p : room->players)
      if (p.site == site && p.id != me->id)
        return sendJson(res, 200, no(room->sites[static_cast<size_t>(site)].name +
                                     " is already taken by " + p.name));
    if (me->site >= 0 && me->site != site && room->phase != Room::Phase::Lobby)
      return sendJson(res, 200, no("Plants cannot be swapped once the simulation has started"));
    me->site = site;
    sendJson(res, 200, json::json{{"ok", true}}.dump());
  });

  svr.Post("/api/room/" + code + "/host", [&rooms, body, str, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    const json::json b = body(req);
    std::lock_guard<std::mutex> lock(room->mutex);
    if (str(b, "hostToken") != room->hostToken)
      return sendJson(res, 200, no("Only the host can do that"));
    const std::string action = str(b, "action");
    const auto ok = [&res] { sendJson(res, 200, json::json{{"ok", true}}.dump()); };
    if (room->phase == Room::Phase::Ended) return sendJson(res, 200, no("This simulation has ended"));
    if (action == "start") {
      if (room->phase != Room::Phase::Lobby) return sendJson(res, 200, no("The simulation has already started"));
      room->phase = Room::Phase::Running;
      room->tickDebt = 0;
      room->baseline = crx_fork(room->sim);
      if (room->baseline != nullptr) crx_mute(room->baseline);
      return ok();
    }
    if (action == "pause") {
      if (room->phase != Room::Phase::Running) return sendJson(res, 200, no("The simulation is not running"));
      room->phase = Room::Phase::Paused;
      return ok();
    }
    if (action == "resume") {
      if (room->phase != Room::Phase::Paused) return sendJson(res, 200, no("The simulation is not paused"));
      room->phase = Room::Phase::Running;
      room->tickDebt = 0;
      return ok();
    }
    if (action == "speed") {
      if (!b.contains("speed") || !b["speed"].is_number())
        return sendJson(res, 200, no("Give a speed from 0.1 to 64"));
      room->speed = std::clamp(b["speed"].get<double>(), kMinSpeed, kMaxSpeed);
      return sendJson(res, 200, json::json{{"ok", true}, {"speed", room->speed}}.dump());
    }
    if (action == "sources") {
      if (room->phase != Room::Phase::Lobby)
        return sendJson(res, 200, no("Which plants can be picked is set before the start"));
      room->allowSources = b.value("allow", false);
      if (!room->allowSources)  // anyone holding a field or mine picks again
        for (RoomPlayer& p : room->players)
          if (p.site >= 0 && room->sites[static_cast<size_t>(p.site)].source) p.site = -1;
      return sendJson(res, 200, json::json{{"ok", true}, {"allowSources", room->allowSources}}.dump());
    }
    if (action == "end") {
      room->phase = Room::Phase::Ended;
      return ok();
    }
    if (action == "scenario") {
      if (room->phase == Room::Phase::Lobby)
        return sendJson(res, 200, no("Start the simulation before triggering a scenario"));
      if (!b.contains("command") || !b["command"].is_object())
        return sendJson(res, 200, no("A scenario needs a command"));
      return sendJson(res, 200, issue(*room, b["command"]));
    }
    sendJson(res, 200, no("Unknown host action"));
  });

  svr.Post("/api/room/" + code + "/play", [&rooms, body, str, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    const json::json b = body(req);
    std::lock_guard<std::mutex> lock(room->mutex);
    RoomPlayer* me = playerByToken(*room, str(b, "token"));
    if (me == nullptr) return sendJson(res, 200, no("Join the room first"));
    me->seen = rooms.now();
    if (me->site < 0) return sendJson(res, 200, no("Pick a plant first"));
    if (room->phase == Room::Phase::Lobby) return sendJson(res, 200, no("The simulation has not started yet"));
    if (room->phase == Room::Phase::Ended) return sendJson(res, 200, no("This simulation has ended"));
    const RoomSite& site = room->sites[static_cast<size_t>(me->site)];
    const std::string action = str(b, "action");
    json::json command;
    if (action == "price") {
      if (!b.contains("markup") || !b["markup"].is_number())
        return sendJson(res, 200, no("Give a markup from -0.2 to 0.3"));
      command = {{"type", "set_price"}, {"site", me->site},
                 {"markup", std::clamp(b["markup"].get<double>(), -0.2, 0.3)}};
    } else if (action == "rate") {
      if (!b.contains("share") || !b["share"].is_number())
        return sendJson(res, 200, no("Give a rate as a share of design, up to 1"));
      command = {{"type", "site_rate"}, {"site", me->site}, {"share", b["share"].get<double>()}};
    } else if (action == "unit") {
      if (!b.contains("unit_index") || !b["unit_index"].is_number_unsigned() ||
          !b.contains("down") || !b["down"].is_boolean())
        return sendJson(res, 200, no("Say which unit, and whether it goes down or comes back"));
      const uint32_t unit = b["unit_index"].get<uint32_t>();
      // The ownership check: a player's units are the ones at their plant.
      if (std::find(site.units.begin(), site.units.end(), unit) == site.units.end())
        return sendJson(res, 200, no("That unit is not at " + site.name + ", your plant"));
      command = {{"type", "unit_state"}, {"unit_index", unit}, {"down", b["down"].get<bool>()}};
    } else if (action == "block") {
      const std::string direction = str(b, "direction");
      if (!b.contains("partner") || !b["partner"].is_number_unsigned() ||
          (direction != "sell" && direction != "buy") || !b.contains("blocked") ||
          !b["blocked"].is_boolean())
        return sendJson(res, 200, no("Say which partner, whether to stop selling or buying, and on or off"));
      if (b["partner"].get<uint64_t>() >= room->sites.size())
        return sendJson(res, 200, no("There is no such site"));
      command = {{"type", "trade_block"}, {"site", me->site}, {"partner", b["partner"].get<uint64_t>()},
                 {"direction", direction}, {"blocked", b["blocked"].get<bool>()}};
    } else {
      return sendJson(res, 200, no("Unknown action"));
    }
    // The engine names the player in the log line the action writes.
    command["player"] = me->id;
    command["player_name"] = me->name;
    const std::string reply = issue(*room, command, me->id);
    const json::json r = json::json::parse(reply, nullptr, false);
    if (r.is_object() && r.value("ok", false)) ++me->moves;
    sendJson(res, 200, reply);
  });

  svr.Get("/api/room/" + code + "/snapshot", [&rooms, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    std::string snap;
    uint64_t tick = 0;
    {
      std::lock_guard<std::mutex> lock(room->mutex);  // a copy of bytes already built
      tick = room->tick;
      const std::string etag = "\"" + std::to_string(tick) + "\"";
      res.set_header("ETag", etag);
      res.set_header("Cache-Control", "no-cache");
      if (req.get_header_value("If-None-Match") == etag) {
        res.status = 304;
        return;
      }
      snap = room->snapshot;
    }
    res.status = 200;
    res.set_content(std::move(snap), "application/octet-stream");
  });

  svr.Get("/api/room/" + code + "/world", [&rooms, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    sendJson(res, 200, room->worldJson);  // never changes after the room is made
  });

  // What the disruptions so far will cost over the next days: {"days": N}.
  // Computed on a fork outside the room lock, so the clock keeps running.
  svr.Post("/api/room/" + code + "/forecast", [&rooms, body, room404](const Req& req, Res& res) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    const json::json b = body(req);
    uint64_t days = 30;
    if (b.contains("days")) {
      if (!b["days"].is_number_unsigned() || b["days"].get<uint64_t>() < 1 || b["days"].get<uint64_t>() > 120)
        return sendJson(res, 400, no("days must be from 1 to 120"));
      days = b["days"].get<uint64_t>();
    }
    crx_sim* with = nullptr;
    std::vector<std::pair<uint64_t, std::string>> commands;
    uint64_t now = 0;
    std::string config;
    {
      std::lock_guard<std::mutex> lock(room->mutex);
      config = room->config;
      with = crx_fork(room->sim);
      commands = room->commands;
      now = room->tick;
    }
    std::string doc;
    if (with == nullptr || !forecastJson(with, config, commands, now, static_cast<uint32_t>(days), doc))
      return sendJson(res, 500, no("The forecast could not be computed"));
    sendJson(res, 200, doc);
  });

  // The read-only views a single-player session has, on the room's run.
  const auto view = [&rooms, room404](const Req& req, Res& res,
                                      const std::function<void(Room&, Res&)>& fn) {
    const auto room = rooms.find(req.matches[1].str());
    if (!room) return room404(res);
    std::lock_guard<std::mutex> lock(room->mutex);
    fn(*room, res);
  };
  svr.Get("/api/room/" + code + "/events", [view](const Req& req, Res& res) {
    uint64_t since = 0;
    try {
      since = req.has_param("since") ? std::stoull(req.get_param_value("since")) : 0;
    } catch (...) {
      return sendJson(res, 400, no("since must be a number"));
    }
    view(req, res, [since](Room& r, Res& out) { sendJson(out, 200, crx_events(r.sim, since)); });
  });
  svr.Get("/api/room/" + code + "/economy", [view](const Req& req, Res& res) {
    uint32_t bucket = 24;
    try {
      if (req.has_param("bucket_h")) bucket = static_cast<uint32_t>(std::stoul(req.get_param_value("bucket_h")));
    } catch (...) {
      bucket = 0;
    }
    view(req, res, [bucket](Room& r, Res& out) {
      const char* text = crx_economy(r.sim, bucket);
      if (text == nullptr) return sendJson(out, 400, no("bucket_h must be a whole number of hours, 1 to 168"));
      sendJson(out, 200, text);
    });
  });
  svr.Get("/api/room/" + code + "/sourcing", [view](const Req& req, Res& res) {
    const std::string site = req.get_param_value("site"), material = req.get_param_value("material");
    view(req, res, [site, material](Room& r, Res& out) {
      const std::string doc = crx_sourcing(r.sim, site.c_str(), material.c_str());
      sendJson(out, doc.rfind("{\"error\"", 0) == 0 ? 400 : 200, doc);
    });
  });
  svr.Get("/api/room/" + code + "/vehicle", [view](const Req& req, Res& res) {
    uint32_t index = 0;
    try {
      index = static_cast<uint32_t>(std::stoul(req.get_param_value("index")));
    } catch (...) {
      return sendJson(res, 400, no("query must be ?index=N"));
    }
    view(req, res, [index](Room& r, Res& out) {
      const char* text = crx_vehicle(r.sim, index);
      if (text == nullptr) return sendJson(out, 400, no("no vehicle with that index"));
      sendJson(out, 200, text);
    });
  });
  svr.Get("/api/room/" + code + "/series", [view](const Req& req, Res& res) {
    uint32_t kind = 0, id = 0;
    try {
      kind = static_cast<uint32_t>(std::stoul(req.get_param_value("kind")));
      id = static_cast<uint32_t>(std::stoul(req.get_param_value("id")));
    } catch (...) {
      return sendJson(res, 400, no("query must be ?kind=K&id=N"));
    }
    view(req, res, [kind, id](Room& r, Res& out) {
      uint32_t n = 0;
      const float* data = crx_series(r.sim, kind, id, &n);
      if (data == nullptr && n == 0) {
        out.status = 404;
        return;
      }
      out.status = 200;
      out.set_content(std::string(reinterpret_cast<const char*>(data), n * sizeof(float)),
                      "application/octet-stream");
    });
  });
  svr.Get("/api/room/" + code + "/partners", [view](const Req& req, Res& res) {
    uint32_t site = 0;
    try {
      site = static_cast<uint32_t>(std::stoul(req.get_param_value("site")));
    } catch (...) {
      return sendJson(res, 400, no("query must be ?site=N"));
    }
    view(req, res, [site](Room& r, Res& out) {
      const char* text = crx_partners(r.sim, site);
      if (text == nullptr) return sendJson(out, 400, no("There is no such site"));
      sendJson(out, 200, text);
    });
  });
  // Before and after: the room against its untouched baseline, site by
  // site, and against each player's shadow for who broke what.
  svr.Get("/api/room/" + code + "/summary", [view](const Req& req, Res& res) {
    view(req, res, [](Room& r, Res& out) {
      const json::json actual = json::json::parse(crx_summary(r.sim), nullptr, false);
      const json::json base =
          r.baseline != nullptr ? json::json::parse(crx_summary(r.baseline), nullptr, false) : actual;
      if (!actual.is_object() || !base.is_object()) return sendJson(out, 500, no("no summary"));
      // Clearly worse in `a` than in `b`: stopped six hours longer, a tenth
      // less through, or (a customer) $5,000 more in lost sales.
      const auto broken = [](const json::json& a, const json::json& b) {
        const double out_a = a.value("outputT", 0.0), out_b = b.value("outputT", 0.0);
        return a.value("stoppedHours", 0.0) - b.value("stoppedHours", 0.0) >= 6.0 ||
               (out_b > 1.0 && out_a < 0.9 * out_b) ||
               a.value("lostSalesUsd", 0.0) - b.value("lostSalesUsd", 0.0) > 5000.0;
      };
      json::json sites = json::json::array();
      for (size_t i = 0; i < actual["sites"].size(); ++i) {
        const json::json& a = actual["sites"][i];
        const json::json& b = base["sites"][i];
        json::json row = {{"site", a["site"]}, {"key", a["key"]}, {"name", a["name"]},
                          {"owner", nullptr}, {"ownerName", nullptr},
                          {"customer", a["customer"]},
                          {"status", a["status"]}, {"baselineStatus", b["status"]},
                          {"stoppedHours", a["stoppedHours"]}, {"baselineStoppedHours", b["stoppedHours"]},
                          {"outputT", a["outputT"]}, {"baselineOutputT", b["outputT"]},
                          {"lostSalesUsd", a["lostSalesUsd"]}, {"baselineLostSalesUsd", b["lostSalesUsd"]},
                          {"broken", broken(a, b)}};
        for (const RoomPlayer& p : r.players)
          if (p.site == static_cast<int>(i)) {
            row["owner"] = p.id;
            row["ownerName"] = p.name;
          }
        sites.push_back(std::move(row));
      }
      json::json pipes = json::json::array();
      for (size_t i = 0; i < actual["pipelines"].size(); ++i) {
        json::json row = actual["pipelines"][i];
        const double moved = row.value("movedT", 0.0);
        const double before = base["pipelines"][i].value("movedT", 0.0);
        row["baselineMovedT"] = before;
        row["broken"] = before > 1.0 && moved < 0.9 * before;
        pipes.push_back(std::move(row));
      }
      // What was paid per tonne, material by material, against the baseline.
      std::vector<json::json> priceRows;
      for (size_t i = 0; i < actual["prices"].size(); ++i) {
        const json::json& a = actual["prices"][i];
        const json::json& b = base["prices"][i];
        const double t = a.value("tonnes", 0.0), bt = b.value("tonnes", 0.0);
        if (t <= 0.0 && bt <= 0.0) continue;
        const double avg = a.value("avgUsdPerT", 0.0), bavg = b.value("avgUsdPerT", 0.0);
        priceRows.push_back({{"material", a["material"]}, {"name", a["name"]},
                             {"tonnes", t}, {"baselineTonnes", bt},
                             {"avgUsdPerT", avg}, {"baselineAvgUsdPerT", bavg},
                             // Nothing bought in one of the two runs: no price to compare.
                             {"changePct", t > 0.0 && bt > 0.0 && bavg > 0.0 ? (avg / bavg - 1.0) * 100.0 : 0.0}});
      }
      std::stable_sort(priceRows.begin(), priceRows.end(), [](const json::json& x, const json::json& y) {
        return std::abs(x.value("changePct", 0.0)) > std::abs(y.value("changePct", 0.0));
      });
      const double lost = actual["economy"].value("lostSalesUsd", 0.0);
      json::json players = json::json::array();
      for (const RoomPlayer& p : r.players) {
        json::json took = json::json::array();
        double damage = 0.0;
        const auto shadow = r.shadows.find(p.id);
        if (shadow != r.shadows.end()) {
          const json::json without = json::json::parse(crx_summary(shadow->second), nullptr, false);
          if (without.is_object()) {
            damage = lost - without["economy"].value("lostSalesUsd", 0.0);
            for (size_t i = 0; i < actual["sites"].size(); ++i)
              if (broken(actual["sites"][i], without["sites"][i])) took.push_back(i);
          }
        }
        players.push_back({{"id", p.id}, {"name", p.name},
                           {"site", p.site >= 0 ? json::json(p.site) : json::json(nullptr)},
                           {"damageUsd", damage}, {"tookDown", took}, {"moves", p.moves}});
      }
      sendJson(out, 200,
               json::json{{"tick", actual["tick"]},
                          {"economy",
                           {{"actual", actual["economy"]},
                            {"baseline", base["economy"]},
                            {"damageUsd", lost - base["economy"].value("lostSalesUsd", 0.0)}}},
                          {"sites", sites},
                          {"pipelines", pipes},
                          {"prices", priceRows},
                          {"players", players}}
                   .dump());
    });
  });
  svr.Get("/api/room/" + code + "/scores", [view](const Req& req, Res& res) {
    view(req, res, [](Room& r, Res& out) {
      json::json doc = json::json::parse(crx_scores(r.sim), nullptr, false);
      if (!doc.is_object() || !doc.contains("scores")) return sendJson(out, 500, no("no scores"));
      const double lost = lostSalesUsd(r.sim);
      for (json::json& row : doc["scores"]) {
        row["owner"] = nullptr;
        row["ownerName"] = nullptr;
        // Damage to the economy: customer sales lost in this run that would
        // not have been lost had this player never acted. Negative = helped.
        row["damageUsd"] = 0.0;
        const int site = row.value("site", -1);
        for (const RoomPlayer& p : r.players)
          if (p.site == site) {
            row["owner"] = p.id;
            row["ownerName"] = p.name;
            const auto shadow = r.shadows.find(p.id);
            if (shadow != r.shadows.end()) row["damageUsd"] = lost - lostSalesUsd(shadow->second);
          }
      }
      sendJson(out, 200, doc.dump());
    });
  });
}

}  // namespace server
}  // namespace crx
