// Chain Reaction — catalog JSON loader and validator (§3, §4.2, §12 test 1).

#include "crx/catalog.h"

#include <nlohmann/json.hpp>

#include <dirent.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace crx {

namespace {

[[noreturn]] void fail(const std::string& where, const std::string& what) {
  throw std::runtime_error(where + ": " + what);
}

int parseEnum(const json& node, const std::vector<std::pair<std::string, int>>& table,
              const std::string& where, const std::string& what) {
  const std::string s = node.get<std::string>();
  for (const auto& [name, value] : table)
    if (name == s) return value;
  fail(where, "unknown " + what + " '" + s + "'");
}

uint8_t modeBitFromLetter(char letter, const std::string& where) {
  switch (letter) {
    case 'T': return 1u << uint8_t(Mode::Road);
    case 'B': return 1u << uint8_t(Mode::River);
    case 'S': return 1u << uint8_t(Mode::Sea);
    case 'P': return 1u << uint8_t(Mode::Pipeline);
    default: fail(where, std::string("unknown mode letter '") + letter + "'");
  }
}

// ---- parsers ----------------------------------------------------------

void parseMaterials(const json& root, const std::string& where, Catalog& out) {
  const json& items = root.at("materials");
  if (!items.is_array()) fail(where, "materials must be an array");
  for (size_t i = 0; i < items.size(); ++i) {
    const json& j = items[i];
    const std::string w = where + " materials[" + std::to_string(i) + "]";
    Material m;
    m.key = j.at("key").get<std::string>();
    m.name = j.at("name").get<std::string>();
    m.phase = Phase(parseEnum(j.at("phase"),
                              {{"liquid", int(Phase::Liquid)},
                               {"liquefied_gas", int(Phase::LiquefiedGas)},
                               {"gas", int(Phase::Gas)},
                               {"solid", int(Phase::Solid)}},
                              w, "phase"));
    m.kind = MatKind(parseEnum(j.at("kind"),
                               {{"traded", int(MatKind::Traded)},
                                {"site_internal", int(MatKind::SiteInternal)},
                                {"pseudo", int(MatKind::Pseudo)}},
                               w, "kind"));
    for (const auto& letter : j.at("modes"))
      m.modes |= modeBitFromLetter(letter.get<std::string>().at(0), w);
    m.base_price = j.at("base_price").get<double>();
    if (j.contains("lhv_gj_t")) m.lhv_gj_t = j.at("lhv_gj_t").get<double>();
    out.materials.push_back(std::move(m));
  }
}

void parseVehicles(const json& root, const std::string& where, Catalog& out) {
  const json& items = root.at("vehicle_classes");
  if (!items.is_array()) fail(where, "vehicle_classes must be an array");
  for (size_t i = 0; i < items.size(); ++i) {
    const json& j = items[i];
    const std::string w = where + " vehicle_classes[" + std::to_string(i) + "]";
    VehicleClass v;
    v.key = j.at("key").get<std::string>();
    v.mode = Mode(parseEnum(j.at("mode"),
                            {{"road", int(Mode::Road)},
                             {"river", int(Mode::River)},
                             {"sea", int(Mode::Sea)}},
                            w, "mode"));
    v.carries = Phase(parseEnum(j.at("carries"),
                                {{"liquid", int(Phase::Liquid)},
                                 {"liquefied_gas", int(Phase::LiquefiedGas)},
                                 {"solid", int(Phase::Solid)}},
                                w, "carries"));
    v.capacity_t = j.at("capacity_t").get<double>();
    v.speed_kmh = j.at("speed_kmh").get<double>();
    v.load_t_h = j.at("load_t_h").get<double>();
    v.freight = j.at("freight").get<double>();
    out.vehicle_classes.push_back(std::move(v));
  }
}

TankRole parseRole(const std::string& s, const std::string& w) {
  if (s == "feed") return TankRole::Feed;
  if (s == "product") return TankRole::Product;
  if (s == "internal") return TankRole::Internal;
  if (s == "both") return TankRole::Both;
  fail(w, "unknown tank role '" + s + "'");
}

void parsePresets(const json& root, const std::string& where, const Catalog& partial,
                  Catalog& out) {
  const json& items = root.at("site_presets");
  if (!items.is_array()) fail(where, "site_presets must be an array");
  for (size_t i = 0; i < items.size(); ++i) {
    const json& j = items[i];
    const std::string w = where + " site_presets[" + std::to_string(i) + "]";
    SitePreset p;
    p.key = j.at("key").get<std::string>();
    p.name = j.at("name").get<std::string>();
    for (size_t k = 0; k < j.at("processes").size(); ++k) {
      const int idx = partial.findProcess(j.at("processes")[k].get<std::string>());
      if (idx < 0) fail(w, "unknown process key");
      p.processes.push_back(uint16_t(idx));
    }
    for (size_t k = 0; k < j.at("tanks").size(); ++k) {
      const json& t = j.at("tanks")[k];
      const std::string tw = w + " tanks[" + std::to_string(k) + "]";
      TankRule r;
      const int mat = partial.findMaterial(t.at("material").get<std::string>());
      if (mat < 0) fail(tw, "unknown material key");
      r.m = MaterialId{uint32_t(mat)};
      r.role = parseRole(t.at("role").get<std::string>(), tw);
      r.cover_days = t.at("cover_days").get<double>();
      r.target_frac = t.at("target_frac").get<double>();
      p.tanks.push_back(r);
    }
    for (size_t b = 0; b < 3; ++b) p.bays[b] = j.at("bays")[b].get<uint8_t>();
    p.ref_nameplate_t_d = j.at("ref_nameplate_t_d").get<double>();
    out.site_presets.push_back(std::move(p));
  }
}

Stream parseStream(const std::string& key, double t_per_t, const ProcessType& proc,
                   const Catalog& partial, const std::string& w) {
  Stream s;
  s.key = key;
  s.t_per_t = t_per_t;
  const int mat = partial.findMaterial(key);
  if (mat >= 0) {
    s.slot = uint16_t(mat);
  } else {
    const auto it = std::find(proc.internal.begin(), proc.internal.end(), key);
    if (it == proc.internal.end()) fail(w, "unknown stream key '" + key + "'");
    s.slot = uint16_t(kInternalStreamBase + (it - proc.internal.begin()));
  }
  return s;
}

std::vector<Stream> parseStreamMap(const json& j, const ProcessType& proc,
                                    const Catalog& partial, const std::string& w) {
  std::vector<Stream> out;
  for (auto it = j.begin(); it != j.end(); ++it) {
    if (it.value() < 0) fail(w, "negative stream amount for '" + it.key() + "'");
    out.push_back(parseStream(it.key(), it.value().get<double>(), proc, partial, w));
  }
  return out;
}

void parseProcess(const json& j, const std::string& w, Catalog& out) {
  ProcessType p;
  p.key = j.at("key").get<std::string>();
  p.name = j.at("name").get<std::string>();
  p.basis_key = j.at("basis").get<std::string>();
  for (const auto& m : j.at("modes")) p.modes.push_back(m.get<std::string>());
  if (j.contains("internal"))
    for (const auto& s : j.at("internal")) p.internal.push_back(s.get<std::string>());
  p.turndown = j.at("turndown").get<double>();
  p.ramp_per_h = j.at("ramp_per_h").get<double>();
  p.restart_h = j.at("restart_h").get<double>();
  if (j.contains("swing_unit")) p.swing_unit = j.at("swing_unit").get<int>();
  if (j.contains("switch_h")) p.switch_h = j.at("switch_h").get<double>();
  if (j.contains("rations")) p.rations = j.at("rations").get<bool>();
  if (j.contains("boundary")) {
    const std::string b = j.at("boundary").get<std::string>();
    if (b == "source") p.boundary = Boundary::Source;
    else if (b == "sink") p.boundary = Boundary::Sink;
    else fail(w, "unknown boundary '" + b + "'");
  }

  const json& units = j.at("units");
  for (size_t u = 0; u < units.size(); ++u) {
    const json& uj = units[u];
    const std::string uw = w + " units[" + std::to_string(u) + "]";
    UnitSlot slot;
    slot.key = uj.at("key").get<std::string>();
    slot.name = uj.at("name").get<std::string>();
    slot.glyph = uj.at("glyph").get<std::string>();
    slot.trains = uj.at("trains").get<uint8_t>();
    const json& recipes = uj.at("recipes");
    if (recipes.size() != p.modes.size())
      fail(uw, "recipe count " + std::to_string(recipes.size()) +
                   " does not match mode count " + std::to_string(p.modes.size()));
    for (size_t r = 0; r < recipes.size(); ++r) {
      const json& rj = recipes[r];
      const std::string rw = uw + " recipes[" + std::to_string(r) + "]";
      UnitRecipe rec;
      rec.in = parseStreamMap(rj.at("in"), p, out, rw);
      rec.out = parseStreamMap(rj.at("out"), p, out, rw);
      rec.heat_gj = rj.at("heat_gj").get<double>();
      rec.power_mwh = rj.at("power_mwh").get<double>();
      slot.by_mode.push_back(std::move(rec));
    }
    p.units.push_back(std::move(slot));
  }

  // Basis must resolve to a material key (§3.7 "basis").
  const int basisIdx = out.findMaterial(p.basis_key);
  if (basisIdx < 0) fail(w, "unknown basis material '" + p.basis_key + "'");
  p.basis = MaterialId{uint32_t(basisIdx)};

  // Derive the net recipe per mode: external streams only, out positive,
  // in negative, ordered by slot. This is the only place net is written.
  p.net.assign(p.modes.size(), {});
  for (size_t m = 0; m < p.modes.size(); ++m) {
    std::map<uint16_t, Stream> agg;
    for (const UnitSlot& unit : p.units) {
      const UnitRecipe& rec = unit.by_mode[m];
      for (const Stream& s : rec.in) {
        Stream& a = agg[s.slot];
        a.key = s.key;
        a.slot = s.slot;
        a.t_per_t -= s.t_per_t;
      }
      for (const Stream& s : rec.out) {
        Stream& a = agg[s.slot];
        a.key = s.key;
        a.slot = s.slot;
        a.t_per_t += s.t_per_t;
      }
    }
    for (auto& [slot, s] : agg) {
      (void)slot;
      if (std::abs(s.t_per_t) > 0.0) p.net[m].push_back(s);
    }
  }

  out.process_types.push_back(std::move(p));
}

// ---- validation -------------------------------------------------------

struct ErrLog {
  std::vector<std::string> items;
  void add(const std::string& s) { items.push_back(s); }
  bool empty() const { return items.empty(); }
};

void validateMaterials(const Catalog& c, ErrLog& errs) {
  std::set<std::string> seen;
  for (const Material& m : c.materials) {
    const std::string w = "material " + m.key;
    if (m.key.empty()) errs.add(w + ": empty key");
    if (!seen.insert(m.key).second) errs.add(w + ": duplicate key");
    if (m.kind == MatKind::Traded) {
      if (m.base_price <= 0.0) errs.add(w + ": traded material needs a positive base price");
      if (m.modes == 0) errs.add(w + ": traded material needs at least one transport mode");
    } else {
      if (m.base_price != 0.0) errs.add(w + ": non-traded material must not have a price");
      if (m.modes != 0) errs.add(w + ": non-traded material must not list transport modes");
    }
  }
}

void validateProcess(const Catalog& c, const ProcessType& p, ErrLog& errs) {
  const std::string w = "process " + p.key;

  if (p.modes.empty()) errs.add(w + ": no modes");
  if (p.units.empty()) errs.add(w + ": no units");
  if (p.turndown < 0.0 || p.turndown >= 1.0) errs.add(w + ": turndown out of range");
  if (p.ramp_per_h < 0.0) errs.add(w + ": negative ramp");
  if (p.restart_h < 0.0) errs.add(w + ": negative restart time");
  if (p.swing_unit >= int(p.units.size())) errs.add(w + ": swing unit index out of range");
  if (p.swing_unit >= 0 && p.switch_h <= 0.0)
    errs.add(w + ": swing unit needs a positive switch time");
  if (p.boundary == Boundary::Sink && p.rations)
    errs.add(w + ": sinks do not ration (§4.2)");

  std::set<std::string> internal;
  for (const std::string& name : p.internal) {
    if (c.findMaterial(name) >= 0)
      errs.add(w + ": internal stream '" + name + "' shadows a material key");
    if (!internal.insert(name).second)
      errs.add(w + ": duplicate internal stream '" + name + "'");
  }

  std::set<std::string> unitKeys;
  for (const UnitSlot& u : p.units) {
    const std::string uw = w + "/" + u.key;
    if (!unitKeys.insert(u.key).second) errs.add(w + ": duplicate unit key " + u.key);
    if (u.trains < 1) errs.add(uw + ": needs at least one train");
    if (u.glyph.empty()) errs.add(uw + ": missing glyph");
    if (u.by_mode.size() != p.modes.size()) errs.add(uw + ": recipe/mode count mismatch");

    for (size_t m = 0; m < u.by_mode.size() && m < p.modes.size(); ++m) {
      const UnitRecipe& rec = u.by_mode[m];
      const std::string mw = uw + " mode " + p.modes[m];
      double sumIn = 0.0, sumOut = 0.0;
      for (const Stream& s : rec.in) {
        sumIn += s.t_per_t;
        if (c.findMaterial(s.key) < 0 && !internal.count(s.key))
          errs.add(mw + ": unknown stream '" + s.key + "'");
      }
      for (const Stream& s : rec.out) {
        sumOut += s.t_per_t;
        if (c.findMaterial(s.key) < 0 && !internal.count(s.key))
          errs.add(mw + ": unknown stream '" + s.key + "'");
      }
      if (p.boundary == Boundary::None) {
        if (std::abs(sumIn - sumOut) > kBalanceTol)
          errs.add(mw + ": unit does not balance (in " + std::to_string(sumIn) + " vs out " +
                   std::to_string(sumOut) + ")");
      } else if (p.boundary == Boundary::Source) {
        if (!rec.in.empty() || rec.out.empty())
          errs.add(mw + ": source unit must have no inputs and some output");
      } else {
        if (!rec.out.empty() || rec.in.empty())
          errs.add(mw + ": sink unit must have no outputs and some input");
      }
    }
  }

  // Rule 2: internal streams are produced and consumed in equal amounts
  // within the process, per mode (§3.2).
  for (size_t m = 0; m < p.modes.size(); ++m) {
    for (const std::string& name : p.internal) {
      double net = 0.0;
      for (const UnitSlot& u : p.units) {
        const UnitRecipe& rec = u.by_mode[m];
        for (const Stream& s : rec.in)
          if (s.key == name) net -= s.t_per_t;
        for (const Stream& s : rec.out)
          if (s.key == name) net += s.t_per_t;
      }
      if (std::abs(net) > kBalanceTol)
        errs.add(w + " mode " + p.modes[m] + ": internal stream '" + name +
                 "' nets to " + std::to_string(net));
    }
  }
}

void validatePresets(const Catalog& c, ErrLog& errs) {
  std::set<std::string> seen;
  for (const SitePreset& p : c.site_presets) {
    if (!seen.insert(p.key).second) errs.add("preset " + p.key + ": duplicate key");
    for (uint16_t idx : p.processes)
      if (idx >= c.process_types.size())
        errs.add("preset " + p.key + ": process index out of range");
    std::set<uint32_t> mats;
    for (const TankRule& t : p.tanks) {
      if (!t.m.valid() || t.m.v >= c.materials.size()) {
        errs.add("preset " + p.key + ": tank material out of range");
        continue;
      }
      if (!mats.insert(t.m.v).second)
        errs.add("preset " + p.key + ": duplicate tank for " + c.materials[t.m.v].key);
      if (t.cover_days < 0.0) errs.add("preset " + p.key + ": negative cover days");
      if (t.target_frac <= 0.0 || t.target_frac > 1.0)
        errs.add("preset " + p.key + ": target fraction out of range");
    }
  }
}

void validateVehicles(const Catalog& c, ErrLog& errs) {
  std::set<std::string> seen;
  for (const VehicleClass& v : c.vehicle_classes) {
    const std::string w = "vehicle class " + v.key;
    if (!seen.insert(v.key).second) errs.add(w + ": duplicate key");
    if (v.mode == Mode::Pipeline) errs.add(w + ": pipelines are not vehicles");
    if (v.carries == Phase::Gas) errs.add(w + ": gases move by pipeline only (§3.4)");
    if (v.capacity_t <= 0.0 || v.speed_kmh <= 0.0 || v.load_t_h <= 0.0)
      errs.add(w + ": capacity, speed and load rate must be positive");
    if (v.freight < 0.0) errs.add(w + ": negative freight");
  }
}

// §12 test 1, last clause: every traded material has a producer and a
// consumer among the process net recipes.
void validateProducersAndConsumers(const Catalog& c, ErrLog& errs) {
  for (size_t i = 0; i < c.materials.size(); ++i) {
    const Material& m = c.materials[i];
    if (m.kind != MatKind::Traded) continue;
    bool produced = false, consumed = false;
    for (const ProcessType& p : c.process_types) {
      for (const auto& net : p.net) {
        for (const Stream& s : net) {
          if (s.slot == i && s.t_per_t > 0.0) produced = true;
          if (s.slot == i && s.t_per_t < 0.0) consumed = true;
        }
      }
    }
    if (!produced) errs.add("material " + m.key + ": no producer process");
    if (!consumed) errs.add("material " + m.key + ": no consumer process");
  }
}

std::string joinErrors(const ErrLog& errs) {
  std::ostringstream ss;
  for (const std::string& e : errs.items) ss << e << "\n";
  return ss.str();
}

std::string readFileOrThrow(const std::string& path) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) throw std::runtime_error("cannot open " + path);
  std::string text;
  char buf[65536];
  size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) text.append(buf, n);
  std::fclose(f);
  return text;
}

}  // namespace

// ---- public API -------------------------------------------------------

int Catalog::findMaterial(const std::string& key) const {
  for (size_t i = 0; i < materials.size(); ++i)
    if (materials[i].key == key) return int(i);
  return -1;
}

int Catalog::findProcess(const std::string& key) const {
  for (size_t i = 0; i < process_types.size(); ++i)
    if (process_types[i].key == key) return int(i);
  return -1;
}

int Catalog::findPreset(const std::string& key) const {
  for (size_t i = 0; i < site_presets.size(); ++i)
    if (site_presets[i].key == key) return int(i);
  return -1;
}

int Catalog::findVehicle(const std::string& key) const {
  for (size_t i = 0; i < vehicle_classes.size(); ++i)
    if (vehicle_classes[i].key == key) return int(i);
  return -1;
}

const char* toString(Phase phase) {
  switch (phase) {
    case Phase::Liquid: return "liquid";
    case Phase::LiquefiedGas: return "liquefied_gas";
    case Phase::Gas: return "gas";
    case Phase::Solid: return "solid";
  }
  return "?";
}

const char* toString(MatKind kind) {
  switch (kind) {
    case MatKind::Traded: return "traded";
    case MatKind::SiteInternal: return "site_internal";
    case MatKind::Pseudo: return "pseudo";
  }
  return "?";
}

bool validateCatalog(const Catalog& catalog, std::string& error) {
  ErrLog errs;
  validateMaterials(catalog, errs);
  for (const ProcessType& p : catalog.process_types) validateProcess(catalog, p, errs);
  validatePresets(catalog, errs);
  validateVehicles(catalog, errs);
  validateProducersAndConsumers(catalog, errs);
  error = joinErrors(errs);
  return errs.empty();
}

bool buildCatalog(const std::string& materials_json,
                  const std::string& vehicles_json,
                  const std::string& presets_json,
                  const std::vector<std::pair<std::string, std::string>>& process_files,
                  Catalog& out, std::string& error) {
  try {
    Catalog c;
    parseMaterials(json::parse(materials_json), "materials.json", c);
    parseVehicles(json::parse(vehicles_json), "vehicles.json", c);
    for (const auto& [name, text] : process_files) {
      const json doc = json::parse(text);
      if (!doc.is_array()) fail(name, "process file must be an array");
      for (size_t i = 0; i < doc.size(); ++i)
        parseProcess(doc[i], name + " process[" + std::to_string(i) + "]", c);
    }
    parsePresets(json::parse(presets_json), "presets.json", c, c);

    std::string verror;
    if (!validateCatalog(c, verror)) {
      error = "catalog validation failed:\n" + verror;
      return false;
    }
    out = std::move(c);
    return true;
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
}

bool loadCatalogFromDir(const std::string& dir, Catalog& out, std::string& error) {
  try {
    const std::string materials = readFileOrThrow(dir + "/materials.json");
    const std::string vehicles = readFileOrThrow(dir + "/vehicles.json");
    const std::string presets = readFileOrThrow(dir + "/presets.json");

    std::vector<std::pair<std::string, std::string>> processFiles;
    if (DIR* d = opendir((dir + "/processes").c_str())) {
      std::vector<std::string> names;
      while (dirent* e = readdir(d))
        if (e->d_name[0] != '.') names.push_back(e->d_name);
      closedir(d);
      std::sort(names.begin(), names.end());
      for (const std::string& n : names)
        processFiles.emplace_back(n, readFileOrThrow(dir + "/processes/" + n));
    } else {
      throw std::runtime_error("cannot open " + dir + "/processes");
    }

    return buildCatalog(materials, vehicles, presets, processFiles, out, error);
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
}

}  // namespace crx
