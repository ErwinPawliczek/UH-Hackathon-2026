// Chain Reaction — world validation (world-level cross-checks).
#include "sim/validate.h"

#include <cmath>
#include <set>

namespace crx {
namespace sim {

bool validateWorld(const World& world, const WorldSpec& spec, std::string& error) {
  std::vector<std::string> problems;
  auto add = [&](const std::string& msg) { problems.push_back(msg); };

  // Tanks: capacity positive, target in range, material valid and real.
  for (size_t i = 0; i < world.tanks.size(); ++i) {
    const Tank& t = world.tanks[i];
    if (t.capacity_t <= 0) add("tank " + t.key + ": capacity must be > 0");
    if (t.target_frac < 0 || t.target_frac > 1)
      add("tank " + t.key + ": target_frac out of [0,1]");
    if (t.material >= world.catalog.materials.size()) add("tank " + t.key + ": bad material");
    if (t.site.v >= world.sites.size()) add("tank " + t.key + ": bad site");
  }

  // Processes and units: bound streams in active modes, positive capacities.
  for (size_t p = 0; p < world.processes.size(); ++p) {
    const Process& proc = world.processes[p];
    const ProcessType& type = world.catalog.process_types[proc.type];
    const Site& site = world.sites[proc.site.v];

    double share_sum = 0;
    for (const double s : proc.mode_share) share_sum += s;
    if (std::abs(share_sum - 1.0) > 1e-9)
      add(site.key + "/" + type.key + ": mode shares sum to " + std::to_string(share_sum));

    for (size_t m = 0; m < type.net.size(); ++m) {
      if (m < proc.mode_share.size() && proc.mode_share[m] <= 0) continue;
      for (const Stream& s : type.net[m]) {
        if (s.slot >= kInternalStreamBase) continue;
        if (world.catalog.materials[s.slot].kind == MatKind::Pseudo) continue;
        if (!proc.tank_of[s.slot].valid())
          add(site.key + "/" + type.key + " mode " + type.modes[m] + ": stream " + s.key +
              " is not bound to a tank");
      }
    }

    if (proc.units.count == 0) add(site.key + "/" + type.key + ": no units");
    for (uint32_t u = proc.units.begin; u < rangeEnd(proc.units); ++u) {
      const Unit& unit = world.units[u];
      if (unit.cap_per_train_t_h <= 0)
        add(site.key + "/" + type.units[unit.slot].key + ": train capacity must be > 0");
      if (unit.process.v != p) add("unit " + std::to_string(u) + ": bad process backref");
    }
  }

  // Pipelines: endpoints valid, material consistent with both tanks.
  for (size_t i = 0; i < world.pipelines.size(); ++i) {
    const Pipeline& pl = world.pipelines[i];
    if (!pl.from.valid() || !pl.to.valid() || pl.from.v >= world.tanks.size() ||
        pl.to.v >= world.tanks.size()) {
      add("pipeline " + std::to_string(i) + ": bad endpoint");
      continue;
    }
    if (pl.cap_t_h <= 0) add("pipeline " + std::to_string(i) + ": capacity must be > 0");
    if (world.tanks[pl.from.v].material != pl.material ||
        world.tanks[pl.to.v].material != pl.material)
      add("pipeline " + std::to_string(i) + ": material mismatch");
    if (pl.from.v == pl.to.v) add("pipeline " + std::to_string(i) + ": self loop");
  }

  // Material closure: every traded material tanked in the world must have a
  // producer; a consumer too unless the spec lists it as stranded.
  std::set<uint16_t> stranded;
  for (const char* key : spec.stranded_materials) {
    const int mid = world.catalog.findMaterial(key);
    if (mid >= 0) stranded.insert(static_cast<uint16_t>(mid));
  }
  std::set<uint16_t> tanked;
  for (const Tank& t : world.tanks) tanked.insert(t.material);

  for (const uint16_t mid : tanked) {
    const Material& mat = world.catalog.materials[mid];
    bool produced = false, consumed = false;
    for (const Process& proc : world.processes) {
      const ProcessType& type = world.catalog.process_types[proc.type];
      for (size_t m = 0; m < type.net.size(); ++m) {
        if (proc.mode_share[m] <= 0) continue;
        for (const Stream& s : type.net[m]) {
          if (s.slot != mid) continue;
          if (s.t_per_t > 0) produced = true;
          if (s.t_per_t < 0) consumed = true;
        }
      }
    }
    if (!produced && !consumed) continue;  // never flows; harmless
    if (!produced && mat.kind == MatKind::Traded)
      add("material " + mat.key + " is tanked but has no producer");
    if (!consumed && stranded.count(mid) == 0)
      add("material " + mat.key + " is produced but has no consumer");
  }

  if (problems.empty()) return true;
  error = "world validation failed:";
  for (const std::string& p : problems) error += "\n  - " + p;
  return false;
}

}  // namespace sim
}  // namespace crx
