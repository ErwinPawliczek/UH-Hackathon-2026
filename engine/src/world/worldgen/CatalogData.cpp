// CatalogView — built from the production catalog (§4.2).
//
// One table, no transcription: the generator's keys and recipes are the
// engine's keys and recipes (materials, process net flows, site presets,
// vehicle classes — all loaded by the validated catalog loader). The name
// plate mapping below adds the outline §3.2 cut-fraction references for
// refinery secondary processes, which the catalog does not carry (they are
// fractions of the crude basis, not independent nameplates).
#include "world/worldgen/CatalogView.h"

#include "crx/catalog.h"

#include <algorithm>
#include <map>

namespace crx {
namespace worldgen {

const MaterialInfo* CatalogView::material(const std::string& key) const {
  const auto it = std::find_if(materials.begin(), materials.end(),
                               [&](const MaterialInfo& m) { return m.key == key; });
  return it == materials.end() ? nullptr : &*it;
}

const ProcessInfo* CatalogView::process(const std::string& key) const {
  const auto it = std::find_if(processes.begin(), processes.end(),
                               [&](const ProcessInfo& p) { return p.key == key; });
  return it == processes.end() ? nullptr : &*it;
}

const PresetInfo* CatalogView::preset(const std::string& key) const {
  const auto it = std::find_if(presets.begin(), presets.end(),
                               [&](const PresetInfo& p) { return p.key == key; });
  return it == presets.end() ? nullptr : &*it;
}

const VehicleClassInfo* CatalogView::vehicle(const std::string& key) const {
  const auto it = std::find_if(vehicles.begin(), vehicles.end(),
                               [&](const VehicleClassInfo& v) { return v.key == key; });
  return it == vehicles.end() ? nullptr : &*it;
}

namespace {

// Outline §3.2: refinery secondary processes run per-tonne cuts of the crude
// basis. Their reference nameplate is the cut fraction of the refinery
// preset's reference crude rate, not an independent plant size.
double secondaryNameplate(const std::string& key, double refinery_ref_t_d) {
  if (key == "REFORMING") return 0.130 * refinery_ref_t_d;
  if (key == "FCC") return 0.250 * refinery_ref_t_d;
  if (key == "DIESEL_HDT") return 0.250 * refinery_ref_t_d;
  return 0.0;  // other secondaries are checked against their site's rate
}

Boundary toBoundary(crx::Boundary b) {
  switch (b) {
    case crx::Boundary::Source: return Boundary::Source;
    case crx::Boundary::Sink: return Boundary::Sink;
    default: return Boundary::None;
  }
}

Phase toPhase(crx::Phase p) {
  switch (p) {
    case crx::Phase::LiquefiedGas: return Phase::LiquefiedGas;
    case crx::Phase::Gas: return Phase::Gas;
    case crx::Phase::Solid: return Phase::Solid;
    default: return Phase::Liquid;
  }
}

MatKind toKind(crx::MatKind k) {
  switch (k) {
    case crx::MatKind::SiteInternal: return MatKind::SiteInternal;
    case crx::MatKind::Pseudo: return MatKind::Pseudo;
    default: return MatKind::Traded;
  }
}

}  // namespace

CatalogView makeCatalogView(const crx::Catalog& catalog) {
  CatalogView view;

  view.materials.reserve(catalog.materials.size());
  for (const Material& m : catalog.materials)
    view.materials.push_back(
        {m.key, toPhase(m.phase), toKind(m.kind), m.modes, m.base_price});

  // Reference nameplate per process: the site preset whose FIRST process it
  // is lends its ref_nameplate_t_d; refinery secondaries use the §3.2 cuts.
  std::map<std::string, double> ref_by_process;
  for (const SitePreset& sp : catalog.site_presets) {
    if (sp.processes.empty() || sp.ref_nameplate_t_d <= 0.0) continue;
    const std::string& primary = catalog.process_types[sp.processes[0]].key;
    ref_by_process.emplace(primary, sp.ref_nameplate_t_d);
  }

  view.processes.reserve(catalog.process_types.size());
  for (const ProcessType& p : catalog.process_types) {
    ProcessInfo info;
    info.key = p.key;
    info.basis = p.basis_key;
    info.modes = p.modes;
    info.boundary = toBoundary(p.boundary);
    info.by_mode.assign(p.net.size(), {});
    for (size_t m = 0; m < p.net.size(); ++m) {
      for (const Stream& s : p.net[m]) {
        if (s.slot >= kInternalStreamBase) continue;  // cancels within a process
        if (s.t_per_t < 0)
          info.by_mode[m].in.push_back({s.key, -s.t_per_t});
        else
          info.by_mode[m].out.push_back({s.key, s.t_per_t});
      }
    }
    const auto ref = ref_by_process.find(p.key);
    if (ref != ref_by_process.end())
      info.nameplate_t_d = ref->second;
    else if (p.key == "REFORMING" || p.key == "FCC" || p.key == "DIESEL_HDT")
      // §3.2 cut of the refinery's crude reference (27000 t/d in the catalog).
      info.nameplate_t_d = secondaryNameplate(p.key, ref_by_process.count("CRUDE_DISTILLATION")
                                                             ? ref_by_process.at("CRUDE_DISTILLATION")
                                                             : 27000.0);
    info.units.reserve(p.units.size());
    for (const UnitSlot& u : p.units) info.units.push_back({u.key, u.trains});
    view.processes.push_back(std::move(info));
  }

  view.presets.reserve(catalog.site_presets.size());
  for (const SitePreset& sp : catalog.site_presets) {
    PresetInfo info;
    info.key = sp.key;
    info.name = sp.name;
    for (const uint16_t pi : sp.processes)
      info.process_keys.push_back(catalog.process_types[pi].key);
    info.ref_nameplate_t_d = sp.ref_nameplate_t_d;
    info.bays_road = sp.bays[0];
    info.bays_river = sp.bays[1];
    info.bays_sea = sp.bays[2];
    for (const TankRule& t : sp.tanks) {
      const std::string key = catalog.materials[t.m.v].key;
      info.cover_by_material.emplace(key, t.cover_days);
      if (t.role == crx::TankRole::Feed || t.role == crx::TankRole::Both)
        info.cover_feed_d = std::max(info.cover_feed_d, t.cover_days);
      if (t.role == crx::TankRole::Product || t.role == crx::TankRole::Both)
        info.cover_product_d = std::max(info.cover_product_d, t.cover_days);
      if (t.role == crx::TankRole::Internal)
        info.cover_internal_d = std::max(info.cover_internal_d, t.cover_days);
    }
    view.presets.push_back(std::move(info));
  }

  view.vehicles.reserve(catalog.vehicle_classes.size());
  for (const VehicleClass& v : catalog.vehicle_classes) {
    view.vehicles.push_back({v.key, static_cast<Mode>(v.mode), toPhase(v.carries),
                             v.capacity_t, v.speed_kmh, v.load_t_h, v.freight});
  }

  return view;
}

}  // namespace worldgen
}  // namespace crx
