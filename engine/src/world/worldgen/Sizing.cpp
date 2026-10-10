// The sizing walk (§6.5–6.6), implemented as one deterministic pass:
//
//   1. end demands from per-capita rates × city populations × demand_scale
//   2. polymer chain → monomer requirements (ethylene, propylene, chlorine…)
//   3. crackers sized on ethylene (fixed feed-mode policy), co-products credited
//   4. refinery crude rate from fuel demands net of cracker credits (fuels only —
//      chemicals are left to the market match so they cannot inflate crude)
//   5. chlor-alkali on chlorine, caustic credited; salt requirement
//   6. gas plants from the max-ratio raw-gas requirement (methane → gas grid)
//   7. per-site external nets → greedy supplier matching → flows
//   8. leftovers to ports (imports/exports via the overseas node)
//   9. tank designs from flows and site-internal streams
//  10. fleet from tonnes moved × round-trip ÷ capacity, +20% padding
//
// Count rule (§6.5): capacity = required ÷ count ÷ utilisation, where count
// comes from the site template. If the implied utilisation exceeds the target
// the feasibility gate reports it — the walk never hides it.
#include "world/worldgen/Sizing.h"

#include "world/worldgen/Geo.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <map>

namespace crx {
namespace worldgen {

namespace {

constexpr double kFleetPadding = 1.20;  // §6.6: +20% fleet padding

std::vector<int> slotsOf(const std::vector<SiteSlot>& slots, const char* preset) {
  std::vector<int> out;
  for (size_t i = 0; i < slots.size(); ++i)
    if (slots[i].preset == preset) out.push_back(static_cast<int>(i));
  return out;
}

double recipeIn(const ProcessInfo& p, const std::string& mode, const std::string& m) {
  for (size_t i = 0; i < p.modes.size(); ++i) {
    if (p.modes[i] != mode) continue;
    for (const NetStream& s : p.by_mode[i].in)
      if (s.material == m) return s.t_per_t;
  }
  return 0.0;
}

double recipeOut(const ProcessInfo& p, const std::string& mode, const std::string& m) {
  for (size_t i = 0; i < p.modes.size(); ++i) {
    if (p.modes[i] != mode) continue;
    for (const NetStream& s : p.by_mode[i].out)
      if (s.material == m) return s.t_per_t;
  }
  return 0.0;
}

// Compose a site: every process in the preset runs at its desired rate unless
// its site-internal feed throttles it (no on-site accumulation). Yields the
// per-process rates plus the site's traded and internal stream totals, t/d.
struct Composition {
  std::map<std::string, double> traded_net;        // + produces, − consumes
  std::map<std::string, double> internal_out_t_d;  // tank inflow side
  std::map<std::string, double> internal_in_t_d;   // tank outflow side
  std::vector<std::pair<std::string, std::pair<std::string, double>>> procs;  // key, mode, t/d
};

Composition composeSite(const CatalogView& catalog, const SiteSlot& slot,
                        const std::map<std::string, double>& desired,
                        const std::map<std::string, std::string>& modes) {
  Composition comp;
  const PresetInfo* preset = catalog.preset(slot.preset);
  if (preset == nullptr) return comp;

  std::map<std::string, double> pool;
  for (const std::string& key : preset->process_keys) {
    const ProcessInfo* p = catalog.process(key);
    if (p == nullptr) continue;
    double rate = 0.0;
    {
      const auto it = desired.find(key);
      if (it != desired.end()) rate = it->second;
    }
    std::string mode;
    {
      const auto it = modes.find(key);
      mode = it != modes.end() ? it->second
                               : (p->modes.empty() ? "DEFAULT" : p->modes.front());
    }
    // Throttle to internal feed availability.
    for (size_t mi = 0; mi < p->modes.size(); ++mi) {
      if (p->modes[mi] != mode) continue;
      for (const NetStream& s : p->by_mode[mi].in) {
        const MaterialInfo* m = catalog.material(s.material);
        if (m == nullptr || m->kind != MatKind::SiteInternal || s.t_per_t <= 0.0) continue;
        const auto avail = pool.find(s.material);
        if (avail != pool.end())
          rate = std::min(rate, avail->second / s.t_per_t);
        else
          rate = 0.0;
      }
      if (rate < 0.0) rate = 0.0;
      const double per_day = rate;
      for (const NetStream& s : p->by_mode[mi].in) {
        const MaterialInfo* m = catalog.material(s.material);
        if (m == nullptr) continue;
        if (m->kind == MatKind::SiteInternal) pool[s.material] -= s.t_per_t * per_day;
        else if (m->kind == MatKind::Traded) comp.traded_net[s.material] -= s.t_per_t * per_day;
      }
      for (const NetStream& s : p->by_mode[mi].out) {
        const MaterialInfo* m = catalog.material(s.material);
        if (m == nullptr) continue;
        if (m->kind == MatKind::SiteInternal) pool[s.material] += s.t_per_t * per_day;
        else if (m->kind == MatKind::Traded) comp.traded_net[s.material] += s.t_per_t * per_day;
      }
      break;
    }
    comp.procs.push_back({key, {mode, rate}});
  }
  return comp;
}

}  // namespace

SizingResult sizeWorld(const CatalogView& catalog, const GenParams& params,
                       const DemandConstants& dc, const Features& features,
                       const std::vector<SiteSlot>& slots, const Routes& routes) {
  SizingResult out;
  const double U = std::clamp(params.target_utilisation, 0.10, 1.0);
  const double scale = params.demand_scale;

  const auto idx = [&](const std::vector<int>& v, size_t i) { return v[std::min(i, v.size() - 1)]; };
  const std::vector<int> depots = slotsOf(slots, "FUEL_DEPOT");
  const std::vector<int> packaging = slotsOf(slots, "PACKAGING");
  const std::vector<int> construction = slotsOf(slots, "CONSTRUCTION");
  const std::vector<int> consumer = slotsOf(slots, "CONSUMER_GOODS");
  const std::vector<int> paints = slotsOf(slots, "PAINTS_COATINGS");
  const std::vector<int> procind = slotsOf(slots, "PROCESS_INDUSTRIES");
  const std::vector<int> crackers = slotsOf(slots, "STEAM_CRACKER");
  const std::vector<int> refineries = slotsOf(slots, "REFINERY");
  const std::vector<int> cas = slotsOf(slots, "CHLOR_ALKALI");
  const std::vector<int> gas_plants = slotsOf(slots, "GAS_PLANT");
  const std::vector<int> oil_fields = slotsOf(slots, "OIL_FIELD");
  const std::vector<int> gas_fields = slotsOf(slots, "GAS_FIELD");
  const std::vector<int> salt_mines = slotsOf(slots, "SALT_MINE");
  const std::vector<int> pe_sites = slotsOf(slots, "POLYETHYLENE");
  const std::vector<int> pp_sites = slotsOf(slots, "POLYPROPYLENE");
  const std::vector<int> vinyls = slotsOf(slots, "VINYLS");
  const std::vector<int> styrenics = slotsOf(slots, "STYRENICS");
  const std::vector<int> grid = slotsOf(slots, "GAS_GRID");
  const std::vector<int> ports = slotsOf(slots, "PORT_TERMINAL");

  const auto popOf = [&](int site) {
    const int city = slots[static_cast<size_t>(site)].city;
    return city >= 0 ? features.cities[static_cast<size_t>(city)].pop_m : 0.0;
  };
  const auto citySum = [&](const std::vector<int>& sites) {
    double s = 0.0;
    for (int site : sites) s += popOf(site);
    return s;
  };
  const auto perSite = [&](size_t n, double total) {
    return n == 0 ? 0.0 : total / static_cast<double>(n);
  };

  // ---- 1. End demands (t/d).
  const double gasoline_d = citySum(depots) * dc.gasoline * scale;
  const double diesel_d = citySum(depots) * dc.diesel * scale;
  const double jet_d = citySum(depots) * dc.jet * scale;
  const double lpg_d = citySum(depots) * dc.lpg * scale;
  const double pe_d = citySum(packaging) * dc.pe * scale;
  const double pp_d = (citySum(packaging) + citySum(consumer)) * dc.pp * 0.5 * scale;
  const double pvc_d = citySum(construction) * dc.pvc * scale;
  const double ps_d = citySum(consumer) * dc.ps * scale;
  const double styrene_mon_d = citySum(paints) * dc.styrene_monomer * scale;

  // ---- 2. Polymer chain requirements.
  const ProcessInfo* pe_poly = catalog.process("PE_POLYMERISATION");
  const ProcessInfo* vcm_proc = catalog.process("VCM");
  const ProcessInfo* pvc_poly = catalog.process("PVC_POLY");
  const ProcessInfo* sty_proc = catalog.process("STYRENE_PROC");
  const ProcessInfo* ps_poly = catalog.process("PS_POLY");
  const ProcessInfo* electro = catalog.process("ELECTROLYSIS");
  const ProcessInfo* ngl = catalog.process("NGL_RECOVERY");
  const ProcessInfo* olefins = catalog.process("OLEFINS");

  const double vcm_total = pvc_d * recipeIn(*pvc_poly, "DEFAULT", "VCM");
  const double sty_total = ps_d * recipeIn(*ps_poly, "DEFAULT", "STYRENE") + styrene_mon_d;
  const double ethylene_req =
      pe_d * recipeIn(*pe_poly, "DEFAULT", "ETHYLENE") +
      vcm_total * recipeIn(*vcm_proc, "DEFAULT", "ETHYLENE") +
      sty_total * recipeIn(*sty_proc, "DEFAULT", "ETHYLENE");
  const double chlorine_req = vcm_total * recipeIn(*vcm_proc, "DEFAULT", "CHLORINE");

  // ---- 3. Crackers sized on ethylene (§6.5: required ÷ count ÷ utilisation).
  struct Cracker {
    int site = -1;
    std::string mode;  // "ETHANE" (gas cracker) or "FLEX"
    double feed_t_d = 0.0, ethylene_t_d = 0.0;
    double ethane = 0.0, lpg = 0.0, naphtha = 0.0;
  };
  std::vector<Cracker> cracker_design;
  for (int site : crackers) {
    Cracker c;
    c.site = site;
    c.mode = slots[static_cast<size_t>(site)].variant == "flex" ? "FLEX" : "ETHANE";
    cracker_design.push_back(c);
  }
  for (Cracker& c : cracker_design) {
    const double yld =
        c.mode == "ETHANE"
            ? recipeOut(*olefins, "ETHANE", "ETHYLENE")
            : dc.flex_ethane * recipeOut(*olefins, "ETHANE", "ETHYLENE") +
                  dc.flex_lpg * recipeOut(*olefins, "LPG", "ETHYLENE") +
                  dc.flex_naphtha * recipeOut(*olefins, "NAPHTHA", "ETHYLENE");
    c.ethylene_t_d = ethylene_req / static_cast<double>(cracker_design.size()) / U;
    c.feed_t_d = yld > 1e-9 ? c.ethylene_t_d / yld : 0.0;
    if (c.mode == "ETHANE") {
      c.ethane = c.feed_t_d;
    } else {
      c.ethane = dc.flex_ethane * c.feed_t_d;
      c.lpg = dc.flex_lpg * c.feed_t_d;
      c.naphtha = dc.flex_naphtha * c.feed_t_d;
    }
  }
  std::map<std::string, double> cracker_credit;
  for (const Cracker& c : cracker_design) {
    const double flex_mix[3] = {c.mode == "ETHANE" ? 1.0 : dc.flex_ethane,
                                c.mode == "ETHANE" ? 0.0 : dc.flex_lpg,
                                c.mode == "ETHANE" ? 0.0 : dc.flex_naphtha};
    for (const char* m : {"PROPYLENE", "BENZENE", "GASOLINE", "LPG", "FUEL_OIL"})
      cracker_credit[m] +=
          flex_mix[0] * recipeOut(*olefins, "ETHANE", m) * c.feed_t_d +
          flex_mix[1] * recipeOut(*olefins, "LPG", m) * c.feed_t_d +
          flex_mix[2] * recipeOut(*olefins, "NAPHTHA", m) * c.feed_t_d;
  }

  // ---- 4. Refinery: crude requirement from fuel demands net of credits.
  std::map<std::string, double> one_t;
  if (!refineries.empty()) {
    for (const std::string& key : catalog.preset("REFINERY")->process_keys) one_t[key] = 1.0;
  }
  const Composition refinery_slate = refineries.empty()
                                         ? Composition{}
                                         : composeSite(catalog, slots[static_cast<size_t>(refineries[0])], one_t, {});
  auto crudeFor = [&](const char* m, double demand) {
    const auto it = refinery_slate.traded_net.find(m);
    if (it == refinery_slate.traded_net.end() || it->second <= 1e-9) return 0.0;
    const double credit = cracker_credit.count(m) ? cracker_credit.at(m) : 0.0;
    return std::max(0.0, (demand - credit) / it->second);
  };
  double crude_req = 0.0;
  for (const auto& [m, d] :
       {std::pair{"GASOLINE", gasoline_d}, {"DIESEL", diesel_d}, {"JET", jet_d}, {"LPG", lpg_d}})
    crude_req = std::max(crude_req, crudeFor(m, d));
  const double refinery_rate = perSite(refineries.size(), crude_req / U);

  // ---- 5. Chlor-alkali; salt requirement from the recipe.
  const double ca_rate = perSite(cas.size(), chlorine_req / U);
  const double salt_req = chlorine_req * recipeIn(*electro, "DEFAULT", "SALT");

  // ---- 6. Gas plants: raw-gas requirement by max ratio; methane → grid.
  double ethane_req = 0.0, flex_lpg_req = 0.0, flex_naphtha_req = 0.0;
  for (const Cracker& c : cracker_design) {
    ethane_req += c.ethane;
    flex_lpg_req += c.lpg;
    flex_naphtha_req += c.naphtha;
  }
  double refinery_lpg = 0.0, refinery_naphtha = 0.0;
  if (!refineries.empty()) {
    std::map<std::string, double> rr;
    for (const std::string& key : catalog.preset("REFINERY")->process_keys) rr[key] = refinery_rate;
    const Composition comp = composeSite(catalog, slots[static_cast<size_t>(refineries[0])], rr, {});
    refinery_lpg += comp.traded_net.count("LPG") ? comp.traded_net.at("LPG") : 0.0;
    refinery_naphtha += comp.traded_net.count("NAPHTHA") ? comp.traded_net.at("NAPHTHA") : 0.0;
  }
  const double lpg_deficit =
      std::max(0.0, lpg_d + flex_lpg_req - refinery_lpg - cracker_credit["LPG"]);
  const double naphtha_deficit = std::max(0.0, flex_naphtha_req - refinery_naphtha);
  const double rg_req = std::max({ethane_req / recipeOut(*ngl, "DEFAULT", "ETHANE"),
                                  lpg_deficit / recipeOut(*ngl, "DEFAULT", "LPG"),
                                  naphtha_deficit / recipeOut(*ngl, "DEFAULT", "NAPHTHA"), 0.0});
  const double methane_made = rg_req * recipeOut(*ngl, "DEFAULT", "METHANE");

  // ---- 7. Desired rates per site, then composition → process designs.
  const auto desiredOf = [&](int site) {
    const std::string& preset = slots[static_cast<size_t>(site)].preset;
    std::map<std::string, double> d;
    const double pop = popOf(site);
    if (preset == "FUEL_DEPOT") {
      d["SINK_GASOLINE"] = pop * dc.gasoline * scale;
      d["SINK_DIESEL"] = pop * dc.diesel * scale;
      d["SINK_JET"] = pop * dc.jet * scale;
      d["SINK_LPG"] = pop * dc.lpg * scale;
    } else if (preset == "PACKAGING") {
      d["SINK_PE"] = pop * dc.pe * scale;
      d["SINK_PP"] = pop * dc.pp * 0.5 * scale;
    } else if (preset == "CONSUMER_GOODS") {
      d["SINK_PS"] = pop * dc.ps * scale;
      d["SINK_PP"] = pop * dc.pp * 0.5 * scale;
    } else if (preset == "CONSTRUCTION") {
      d["SINK_PVC"] = pop * dc.pvc * scale;
    } else if (preset == "PAINTS_COATINGS") {
      d["SINK_SOLVENT"] = pop * dc.solvent * scale;
      d["SINK_STYRENE"] = pop * dc.styrene_monomer * scale;
    } else if (preset == "PROCESS_INDUSTRIES") {
      d["SINK_CAUSTIC"] = pop * dc.caustic * scale;
    } else if (preset == "GAS_GRID") {
      d["SINK_METHANE"] = perSite(grid.size(), methane_made);  // absorbs all made
    } else if (preset == "OIL_FIELD") {
      d["CRUDE_SUPPLY"] = perSite(oil_fields.size(), crude_req);
    } else if (preset == "GAS_FIELD") {
      d["RAW_GAS_SUPPLY"] = perSite(gas_fields.size(), rg_req);
    } else if (preset == "SALT_MINE") {
      d["SALT_SUPPLY"] = perSite(salt_mines.size(), salt_req);
    } else if (preset == "GAS_PLANT") {
      d["NGL_RECOVERY"] = perSite(gas_plants.size(), rg_req / U);
    } else if (preset == "REFINERY") {
      d["CRUDE_DISTILLATION"] = refinery_rate;
      d["REFORMING"] = refinery_rate;    // throttled to the CDU cut
      d["FCC"] = refinery_rate;          // throttled to the CDU cut
      d["DIESEL_HDT"] = refinery_rate;   // throttled to the CDU cut
    } else if (preset == "STEAM_CRACKER") {
      const auto it = std::find_if(cracker_design.begin(), cracker_design.end(),
                                   [&](const Cracker& c) { return c.site == site; });
      if (it != cracker_design.end()) {
        d["OLEFINS"] = it->feed_t_d;
        d["__mode_OLEFINS"] = 0.0;  // marker; mode resolved below
      }
    } else if (preset == "CHLOR_ALKALI") {
      d["ELECTROLYSIS"] = ca_rate;
    } else if (preset == "POLYETHYLENE") {
      d["PE_POLYMERISATION"] = perSite(pe_sites.size(), pe_d / U);
    } else if (preset == "POLYPROPYLENE") {
      d["PP_POLYMERISATION"] = perSite(pp_sites.size(), pp_d / U);
    } else if (preset == "VINYLS") {
      d["VCM"] = perSite(vinyls.size(), vcm_total / U);
      d["PVC_POLY"] = perSite(vinyls.size(), pvc_d / U);
    } else if (preset == "STYRENICS") {
      d["STYRENE_PROC"] = perSite(styrenics.size(), sty_total / U);
      d["PS_POLY"] = perSite(styrenics.size(), ps_d / U);
    }
    return d;
  };

  std::vector<Composition> comps(slots.size());
  for (size_t s = 0; s < slots.size(); ++s) {
    std::map<std::string, double> desired = desiredOf(static_cast<int>(s));
    std::map<std::string, std::string> mode_over;
    if (desired.count("__mode_OLEFINS")) {
      desired.erase("__mode_OLEFINS");
      const auto it = std::find_if(cracker_design.begin(), cracker_design.end(),
                                   [&](const Cracker& c) { return c.site == static_cast<int>(s); });
      mode_over["OLEFINS"] = it != cracker_design.end() ? it->mode : "ETHANE";
    }
    comps[s] = composeSite(catalog, slots[s], desired, mode_over);
    for (const auto& [key, mm] : comps[s].procs) {
      if (mm.second <= 0.0) continue;
      out.processes.push_back({static_cast<int>(s), key, mm.first, mm.second / 24.0});
    }
  }

  // ---- 8. Flows: greedy supplier matching per traded material.
  const auto is_city_sink = [&](int site) {
    const std::string& p = slots[static_cast<size_t>(site)].preset;
    return p == "FUEL_DEPOT" || p == "PACKAGING" || p == "CONSTRUCTION" ||
           p == "CONSUMER_GOODS" || p == "PAINTS_COATINGS" || p == "PROCESS_INDUSTRIES";
  };
  const auto addFlow = [&](const std::string& m, int from, int to, double t_d, bool piped) {
    if (t_d > 1e-9) out.flows.push_back({m, from, to, t_d, piped});
  };

  for (const MaterialInfo& mi : catalog.materials) {
    if (mi.kind != MatKind::Traded) continue;
    struct SiteAmt {
      int site;
      double amt;
    };
    std::vector<SiteAmt> suppliers, consumers;
    for (size_t s = 0; s < slots.size(); ++s) {
      const auto it = comps[s].traded_net.find(mi.key);
      if (it == comps[s].traded_net.end() || std::abs(it->second) < 1e-9) continue;
      (it->second > 0.0 ? suppliers : consumers).push_back({static_cast<int>(s), std::abs(it->second)});
    }
    if (consumers.empty()) continue;
    const bool pipable = (mi.modes_mask & (1u << 3)) != 0;

    for (const auto& c : consumers) {
      struct Cand {
        double rank;  // piped pairs by distance; vehicle pairs after
        int site;
        bool piped;
        double vehicle_cost;
      };
      std::vector<Cand> cands;
      for (const auto& s : suppliers) {
        if (s.amt <= 1e-9) continue;
        double vehicle_cost = 1e18;
        for (const VehicleClassInfo& v : catalog.vehicles) {
          if (v.carries != mi.phase) continue;
          const int a = routes.siteNode(s.site, v.mode);
          const int b = routes.siteNode(c.site, v.mode);
          if (a < 0 || b < 0 || !routes.reachable(a, b, v.mode)) continue;
          const double cost = v.freight_per_t_km * routes.km(a, b, v.mode);
          vehicle_cost = std::min(vehicle_cost, cost);
        }
        const bool pipe_ok = pipable && !is_city_sink(c.site);
        if (pipe_ok) {
          const double d = distKM(slots[static_cast<size_t>(s.site)].pos,
                                  slots[static_cast<size_t>(c.site)].pos);
          cands.push_back({d, s.site, true, vehicle_cost});
        }
        if (vehicle_cost < 1e18)
          cands.push_back({1e6 + vehicle_cost, s.site, false, vehicle_cost});
      }
      std::sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) {
        if (a.rank != b.rank) return a.rank < b.rank;
        return a.site < b.site;
      });
      double need = c.amt;
      for (const auto& cd : cands) {
        if (need <= 1e-9) break;
        auto& sup = *std::find_if(suppliers.begin(), suppliers.end(),
                                  [&](const SiteAmt& s) { return s.site == cd.site; });
        const double take = std::min(need, sup.amt);
        if (take <= 1e-9) continue;
        sup.amt -= take;
        need -= take;
        addFlow(mi.key, sup.site, c.site, take, cd.piped);
      }
      if (need > 1e-6 && !ports.empty()) {
        // Import: overseas → nearest port, then port → consumer by vehicle.
        int nearest = idx(ports, 0);
        double best = 1e18;
        for (int p : ports) {
          const double d = distKM(slots[static_cast<size_t>(p)].pos,
                                  slots[static_cast<size_t>(c.site)].pos);
          if (d < best) {
            best = d;
            nearest = p;
          }
        }
        addFlow(mi.key, kOverseasSite, nearest, need, false);
        addFlow(mi.key, nearest, c.site, need, false);
      }
    }
    for (const auto& s : suppliers) {
      if (s.amt <= 1e-6 || ports.empty()) continue;
      int nearest = idx(ports, 0);
      double best = 1e18;
      for (int p : ports) {
        const double d = distKM(slots[static_cast<size_t>(p)].pos,
                                slots[static_cast<size_t>(s.site)].pos);
        if (d < best) {
          best = d;
          nearest = p;
        }
      }
      addFlow(mi.key, s.site, nearest, s.amt, pipable && !is_city_sink(nearest));
      addFlow(mi.key, nearest, kOverseasSite, s.amt, false);
    }
  }

  // ---- 9. Ledger: country-level net requirement (+ = import, − = export).
  for (size_t s = 0; s < slots.size(); ++s)
    for (const auto& [m, t] : comps[s].traded_net) out.net_t_d[m] += t;

  // ---- 10. Tanks: transport flows + process streams + internal streams.
  // Tank balance at steady state: in = transport in + process production,
  // out = transport out + process consumption — both sides counted.
  struct TankFlow {
    double in = 0.0, out = 0.0;
  };
  std::map<std::pair<int, std::string>, TankFlow> tf;
  for (const auto& f : out.flows) {
    if (f.from_site >= 0) tf[{f.from_site, f.material}].out += f.t_d / 24.0;
    if (f.to_site >= 0) tf[{f.to_site, f.material}].in += f.t_d / 24.0;
  }
  for (size_t s = 0; s < slots.size(); ++s) {
    for (const auto& [m, t] : comps[s].internal_out_t_d) tf[{static_cast<int>(s), m}].in += t / 24.0;
    for (const auto& [m, t] : comps[s].internal_in_t_d) tf[{static_cast<int>(s), m}].out += t / 24.0;
  }
  for (const auto& d : out.processes) {
    const ProcessInfo* p = catalog.process(d.type);
    if (p == nullptr) continue;
    for (size_t mi = 0; mi < p->modes.size(); ++mi) {
      if (p->modes[mi] != d.mode) continue;
      for (const NetStream& s : p->by_mode[mi].in) {
        const MaterialInfo* m = catalog.material(s.material);
        if (m != nullptr && m->kind == MatKind::Traded)
          tf[{d.site, s.material}].out += s.t_per_t * d.rate_t_h;
      }
      for (const NetStream& s : p->by_mode[mi].out) {
        const MaterialInfo* m = catalog.material(s.material);
        if (m != nullptr && m->kind == MatKind::Traded)
          tf[{d.site, s.material}].in += s.t_per_t * d.rate_t_h;
      }
      break;
    }
  }
  for (const auto& [key, f] : tf) {
    const MaterialInfo* mi = catalog.material(key.second);
    const bool internal = mi != nullptr && mi->kind == MatKind::SiteInternal;
    const PresetInfo* preset = catalog.preset(slots[static_cast<size_t>(key.first)].preset);
    const double cov_f = preset ? preset->cover_feed_d : 10.0;
    const double cov_p = preset ? preset->cover_product_d : 10.0;
    const double cov_i = preset ? preset->cover_internal_d : 2.0;
    const double cov = params.cover_multiplier;
    const double cap =
        internal
            ? std::max(f.in, f.out) * 24.0 * cov_i * cov
            : std::max(f.in * 24.0 * cov_p, f.out * 24.0 * cov_f) * cov;
    const TankRole role =
        internal                                    ? TankRole::Internal
        : (f.in > 1e-12 && f.out > 1e-12)           ? TankRole::Both
        : f.in > 1e-12                              ? TankRole::Product
                                                    : TankRole::Feed;
    out.tanks.push_back({key.first, key.second, role, f.in, f.out, cap});
  }

  // ---- 11. Fleet: cheapest feasible class per flow; count = ceil(trips ×
  // round-trip ÷ 24 × 1.2).
  for (const auto& f : out.flows) {
    if (f.piped) continue;
    const MaterialInfo* mi = catalog.material(f.material);
    if (mi == nullptr) continue;
    const VehicleClassInfo* best = nullptr;
    double best_cost = 1e18, best_arc = 0.0;
    for (const VehicleClassInfo& v : catalog.vehicles) {
      if (v.carries != mi->phase) continue;
      int a = -1, b = -1;
      if (f.from_site == kOverseasSite || f.to_site == kOverseasSite) {
        const int port = f.from_site == kOverseasSite ? f.to_site : f.from_site;
        a = routes.siteNode(port, Mode::Sea);
        b = routes.overseas_node;
      } else {
        a = routes.siteNode(f.from_site, v.mode);
        b = routes.siteNode(f.to_site, v.mode);
      }
      if (a < 0 || b < 0 || !routes.reachable(a, b, v.mode)) continue;
      const double arc = routes.km(a, b, v.mode);
      const double cost = v.freight_per_t_km * arc;
      if (cost < best_cost - 1e-12) {
        best_cost = cost;
        best = &v;
        best_arc = arc;
      }
    }
    if (best == nullptr) continue;
    const int home = f.from_site == kOverseasSite ? f.to_site : f.from_site;
    const double trips = f.t_d / best->capacity_t;
    const double rt_h = 2.0 * best_arc / std::max(1.0, best->speed_kmh) +
                        2.0 * best->capacity_t / std::max(1.0, best->load_t_h);
    const int count = static_cast<int>(std::ceil(trips * rt_h / 24.0 * kFleetPadding));
    out.fleet.push_back({best->key, home, std::max(1, count)});
  }

  return out;
}

}  // namespace worldgen
}  // namespace crx
