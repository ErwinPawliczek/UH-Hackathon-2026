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
//   8. surplus at each port composes the port's export sinks (§3.3: every
//      product has an outlet — the port buys domestic surplus for export)
//   9. tank designs from flows and site-internal streams
//  10. fleet from tonnes moved × round-trip ÷ capacity, +20% padding
//
// There is no overseas procurement: the country is sized to be self-sufficient
// (§6.5). A material whose suppliers cannot cover its consumers is recorded in
// `unmet_t_d` and fails the feasibility gate instead of silently importing.
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
#include <set>

namespace crx {
namespace worldgen {

namespace {

constexpr double kFleetPadding = 1.60;  // §6.6: fleet padding — raised from +20% so the far-city legs (JET/LPG/CAUSTIC) keep cover through the warm-up tail

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

bool is_city_sink_preset(const std::string& preset) {
  return preset == "FUEL_DEPOT" || preset == "PACKAGING" || preset == "CONSTRUCTION" ||
         preset == "CONSUMER_GOODS" || preset == "PAINTS_COATINGS" ||
         preset == "PROCESS_INDUSTRIES";
}

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
  std::vector<int> crackers = slotsOf(slots, "STEAM_CRACKER_GAS");
  {
    const std::vector<int> flex = slotsOf(slots, "STEAM_CRACKER_FLEX");
    crackers.insert(crackers.end(), flex.begin(), flex.end());
  }
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
  // Weighted share: this site's slice of the family total, tilted by its
  // seed-drawn capacity weight (§6.5 — capacities vary, totals hold).
  const auto shareOf = [&](const std::vector<int>& sites, int site, double total) {
    double wsum = 0.0;
    for (int s : sites) wsum += slots[static_cast<size_t>(s)].capacity_weight;
    if (wsum <= 0.0) return perSite(sites.size(), total);
    return total * slots[static_cast<size_t>(site)].capacity_weight / wsum;
  };

  // Per-capita demand rate (t/d per million people) by sink basis material.
  // LPG and CAUSTIC carry a +20% supply reserve: their production is a
  // co-product or a single-plant supply chain whose previous exact-demand
  // sizing left zero headroom — any demand-curve peak or logistics loss then
  // dried the tail depot tanks in the warm-up. The port export sinks absorb
  // the surplus (they size themselves from domestic arrivals).
  constexpr double kSupplyReserve = 1.20;
  const auto perCapita = [&](const std::string& basis) {
    if (basis == "GASOLINE") return dc.gasoline;
    if (basis == "DIESEL") return dc.diesel;
    if (basis == "JET") return dc.jet;
    if (basis == "LPG") return dc.lpg * kSupplyReserve;
    if (basis == "PE") return dc.pe;
    if (basis == "PP") return dc.pp * 0.5;  // split between two consumer sinks
    if (basis == "PVC") return dc.pvc;
    if (basis == "PS") return dc.ps;
    if (basis == "STYRENE") return dc.styrene_monomer;
    if (basis == "SOLVENT") return dc.solvent;
    if (basis == "CAUSTIC") return dc.caustic * kSupplyReserve;
    return 0.0;  // METHANE / FUEL_OIL: sized by supply, not per-capita demand
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
  const ProcessInfo* pvc_poly = catalog.process("PVC");
  const ProcessInfo* sty_proc = catalog.process("STYRENE");
  const ProcessInfo* ps_poly = catalog.process("PS");
  const ProcessInfo* electro = catalog.process("ELECTROLYSIS");
  const ProcessInfo* ngl = catalog.process("NGL_RECOVERY");
  const ProcessInfo* olefins_gas = catalog.process("OLEFINS_GAS");
  const ProcessInfo* olefins_flex = catalog.process("OLEFINS_FLEX");
  const auto olefinsFor = [&](const std::string& mode) {
    return mode == "ETHANE" ? olefins_gas : olefins_flex;
  };

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
    c.mode = slots[static_cast<size_t>(site)].preset == "STEAM_CRACKER_FLEX" ? "FLEX" : "ETHANE";
    cracker_design.push_back(c);
  }
  for (Cracker& c : cracker_design) {
    const ProcessInfo* olefins = c.mode == "ETHANE" ? olefins_gas : olefins_flex;
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
    const ProcessInfo* olefins = olefinsFor(c.mode == "ETHANE" ? "ETHANE" : "FLEX");
    (void)olefins;
    const double flex_mix[3] = {c.mode == "ETHANE" ? 1.0 : dc.flex_ethane,
                                c.mode == "ETHANE" ? 0.0 : dc.flex_lpg,
                                c.mode == "ETHANE" ? 0.0 : dc.flex_naphtha};
    for (const char* m : {"PROPYLENE", "BENZENE", "GASOLINE", "LPG", "FUEL_OIL"}) {
      cracker_credit[m] += flex_mix[0] * recipeOut(*olefins_gas, "ETHANE", m) * c.feed_t_d +
                           flex_mix[1] * recipeOut(*olefins_flex, "LPG", m) * c.feed_t_d +
                           flex_mix[2] * recipeOut(*olefins_flex, "NAPHTHA", m) * c.feed_t_d;
    }
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
       {std::pair{"GASOLINE", gasoline_d}, {std::pair{"DIESEL", diesel_d}},
        std::pair{"JET", jet_d}, std::pair{"LPG", lpg_d}})
    crude_req = std::max(crude_req, crudeFor(m, d));
  const double refinery_rate = perSite(refineries.size(), crude_req / U);
  // Total CDU design across the refinery family = the crude draw with the
  // utilisation headroom already inside refinery_rate.
  const double refinery_total = refinery_rate * static_cast<double>(refineries.size());

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
    for (const std::string& key : catalog.preset("REFINERY")->process_keys)
      rr[key] = shareOf(refineries, refineries[0], refinery_total);
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
    if (preset == "GAS_GRID") {
      d["GAS_GRID_METHANE"] = shareOf(grid, site, methane_made);  // absorbs all made
    } else if (preset == "OIL_FIELD") {
      // Fields match the refineries' design draw exactly: no crude surplus.
      d["OIL_PRODUCTION"] = shareOf(oil_fields, site, crude_req / U);
    } else if (preset == "GAS_FIELD") {
      d["GAS_PRODUCTION"] = shareOf(gas_fields, site, rg_req);
    } else if (preset == "SALT_MINE") {
      d["SALT_MINING"] = shareOf(salt_mines, site, salt_req);
    } else if (preset == "GAS_PLANT") {
      d["NGL_RECOVERY"] = shareOf(gas_plants, site, rg_req);
    } else if (preset == "REFINERY") {
      // Refinery keeps utilisation headroom (§6.5): fuel output runs 1/U over
      // city demand and the surplus exports through the port.
      d["CRUDE_DISTILLATION"] = shareOf(refineries, site, refinery_total);
      d["REFORMING"] = d["CRUDE_DISTILLATION"];   // throttled to the CDU cut
      d["FCC"] = d["CRUDE_DISTILLATION"];         // throttled to the CDU cut
      d["DIESEL_HDT"] = d["CRUDE_DISTILLATION"];  // throttled to the CDU cut
    } else if (preset == "STEAM_CRACKER_GAS" || preset == "STEAM_CRACKER_FLEX") {
      const auto it = std::find_if(cracker_design.begin(), cracker_design.end(),
                                   [&](const Cracker& c) { return c.site == site; });
      if (it != cracker_design.end()) {
        const bool flex = preset == "STEAM_CRACKER_FLEX";
        d[flex ? "OLEFINS_FLEX" : "OLEFINS_GAS"] = it->feed_t_d;
      }
    } else if (preset == "CHLOR_ALKALI") {
      d["ELECTROLYSIS"] = shareOf(cas, site, chlorine_req);
    } else if (preset == "POLYETHYLENE") {
      d["PE_POLYMERISATION"] = shareOf(pe_sites, site, pe_d / U);
    } else if (preset == "POLYPROPYLENE") {
      d["PP_POLYMERISATION"] = shareOf(pp_sites, site, pp_d / U);
    } else if (preset == "VINYLS") {
      d["VCM"] = shareOf(vinyls, site, vcm_total / U);
      d["PVC"] = shareOf(vinyls, site, pvc_d / U);
    } else if (preset == "STYRENICS") {
      d["STYRENE"] = shareOf(styrenics, site, sty_total / U);
      d["PS"] = shareOf(styrenics, site, ps_d / U);
    } else {
      // City demand sinks: every sink process in the preset runs at its city's
      // per-capita rate for the process's basis material (§3.3).
      const PresetInfo* pi = catalog.preset(preset);
      if (pi != nullptr) {
        for (const std::string& key : pi->process_keys) {
          const ProcessInfo* p = catalog.process(key);
          if (p == nullptr) continue;
          const double rate = perCapita(p->basis);
          if (rate > 0.0) d[key] = pop * rate * scale;
        }
      }
    }
    return d;
  };

  std::vector<Composition> comps(slots.size());
  for (size_t s = 0; s < slots.size(); ++s) {
    std::map<std::string, double> desired = desiredOf(static_cast<int>(s));
    std::map<std::string, std::string> mode_over;
    const std::string& preset = slots[s].preset;
    if (preset == "STEAM_CRACKER_GAS" || preset == "STEAM_CRACKER_FLEX") {
      const auto it = std::find_if(cracker_design.begin(), cracker_design.end(),
                                   [&](const Cracker& c) { return c.site == static_cast<int>(s); });
      if (it != cracker_design.end())
        mode_over[preset == "STEAM_CRACKER_FLEX" ? "OLEFINS_FLEX" : "OLEFINS_GAS"] = it->mode;
    }
    comps[s] = composeSite(catalog, slots[s], desired, mode_over);
    // Flex crackers run a blended feed (three real modes at the demand
    // constants' shares); composeSite applies one mode at a time, so the
    // blended net is composed directly from the mode recipes.
    if (preset == "STEAM_CRACKER_FLEX") {
      const auto it = std::find_if(cracker_design.begin(), cracker_design.end(),
                                   [&](const Cracker& c) { return c.site == static_cast<int>(s); });
      const ProcessInfo* of = catalog.process("OLEFINS_FLEX");
      if (it != cracker_design.end() && of != nullptr && it->feed_t_d > 0.0) {
        const double mix[3] = {dc.flex_ethane, dc.flex_lpg, dc.flex_naphtha};
        const char* feeds[3] = {"ETHANE", "LPG", "NAPHTHA"};
        for (size_t mi = 0; mi < of->modes.size(); ++mi) {
          int k = -1;
          for (int j = 0; j < 3; ++j)
            if (of->modes[mi] == feeds[j]) k = j;
          if (k < 0 || mix[k] <= 0.0) continue;
          for (const NetStream& st : of->by_mode[mi].in) {
            const MaterialInfo* m = catalog.material(st.material);
            if (m == nullptr || m->kind != MatKind::Traded) continue;
            comps[s].traded_net[st.material] -= st.t_per_t * mix[k] * it->feed_t_d;
          }
          for (const NetStream& st : of->by_mode[mi].out) {
            const MaterialInfo* m = catalog.material(st.material);
            if (m == nullptr || m->kind != MatKind::Traded) continue;
            comps[s].traded_net[st.material] += st.t_per_t * mix[k] * it->feed_t_d;
          }
        }
      }
    }
    for (const auto& [key, mm] : comps[s].procs) {
      if (mm.second <= 0.0) continue;
      const bool curved = is_city_sink_preset(preset);
      out.processes.push_back({static_cast<int>(s), key, mm.first, mm.second / 24.0, curved});
    }
  }

  // ---- 8. Flows: greedy supplier matching per traded material. Surplus is
  // routed to the nearest port for export (§3.3); shortfalls are unmet.
  const auto is_city_sink = [&](int site) {
    return is_city_sink_preset(slots[static_cast<size_t>(site)].preset);
  };
  const auto addFlow = [&](const std::string& m, int from, int to, double t_d, bool piped) {
    if (t_d > 1e-9) out.flows.push_back({m, from, to, t_d, piped});
  };

  // Port export sinks: basis materials the port can buy for export (§3.3).
  std::set<std::string> exportable;
  if (const PresetInfo* port_preset = catalog.preset("PORT_TERMINAL")) {
    for (const std::string& key : port_preset->process_keys) {
      const ProcessInfo* p = catalog.process(key);
      if (p != nullptr && p->boundary == Boundary::Sink && !p->basis.empty())
        exportable.insert(p->basis);
    }
  }

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
        // Seed-drawn supplier preference (§6.5): sites with a higher capacity
        // weight attract flow slightly more, so preferred suppliers vary by
        // seed while staying near the cost optimum.
        const double pref = 2.0 - slots[static_cast<size_t>(s.site)].capacity_weight;
        double vehicle_cost = 1e18;
        for (const VehicleClassInfo& v : catalog.vehicles) {
          if (v.carries != mi.phase) continue;
          if ((mi.modes_mask & (1u << static_cast<uint8_t>(v.mode))) == 0) continue;
          const int a = routes.siteNode(s.site, v.mode);
          const int b = routes.siteNode(c.site, v.mode);
          if (a < 0 || b < 0 || !routes.reachable(a, b, v.mode)) continue;
          const double cost = v.freight_per_t_km * routes.km(a, b, v.mode);
          vehicle_cost = std::min(vehicle_cost, cost);
        }
        const bool pipe_ok = pipable && !is_city_sink(c.site);
        if (pipe_ok) {
          const double d = distKM(slots[static_cast<size_t>(s.site)].pos,
                                  slots[static_cast<size_t>(c.site)].pos) *
                           pref;
          cands.push_back({d, s.site, true, vehicle_cost});
        }
        if (vehicle_cost < 1e18)
          cands.push_back({1e6 + vehicle_cost * pref, s.site, false, vehicle_cost});
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
      if (need > 1e-6) out.unmet_t_d[mi.key] += need;  // §6.5: no import fallback
    }
    // Supplier surplus → nearest port, which exports it (§3.3). Only materials
    // the port can actually buy for export route there; anything else (e.g.
    // chlorine, crude, raw gas, methane) stays at the producing site, where a
    // full tank throttles production back to demand.
    for (const auto& s : suppliers) {
      if (s.amt <= 1e-6 || ports.empty() || !exportable.count(mi.key)) continue;
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
      addFlow(mi.key, s.site, nearest, s.amt, pipable);
    }
  }

  // ---- 8b. Port composition: export sinks and the bunker sink run at the
  // domestic arrival rates they were assigned above (t/d). This instantiates
  // the port's consuming processes so every arrival has an in-world outlet.
  for (int p : ports) {
    std::map<std::string, double> arrivals;
    for (const auto& f : out.flows)
      if (f.to_site == p) arrivals[f.material] += f.t_d;
    std::map<std::string, double> desired;
    const PresetInfo* pi = catalog.preset("PORT_TERMINAL");
    if (pi != nullptr) {
      // One consuming process per basis material: a domestic-demand sink
      // (fuel depot, bunker) wins over the export sink, so an arrival is
      // never counted twice.
      std::map<std::string, const ProcessInfo*> chosen;
      for (const std::string& key : pi->process_keys) {
        const ProcessInfo* proc = catalog.process(key);
        if (proc == nullptr) continue;
        if (arrivals.find(proc->basis) == arrivals.end() || arrivals.at(proc->basis) <= 1e-9)
          continue;
        const bool export_sink = proc->key.rfind("PORT_EXPORT_", 0) == 0;
        const auto it = chosen.find(proc->basis);
        if (it == chosen.end()) {
          chosen[proc->basis] = proc;
        } else if (!export_sink &&
                   it->second->key.rfind("PORT_EXPORT_", 0) == 0) {
          it->second = proc;  // prefer the domestic-demand sink
        }
      }
      for (const auto& [basis, proc] : chosen) desired[proc->key] = arrivals.at(basis);
    }
    comps[static_cast<size_t>(p)] = composeSite(catalog, slots[static_cast<size_t>(p)], desired, {});
    for (const auto& [key, mm] : comps[static_cast<size_t>(p)].procs) {
      if (mm.second <= 0.0) continue;
      out.processes.push_back({p, key, mm.first, mm.second / 24.0, false});
    }
  }

  // ---- 9. Ledger: country-level net requirement (+ = shortfall, − = export).
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
    // Flex crackers run a blended feed (three real modes at the demand
    // constants' shares) — the same blend the composition's traded-net
    // fix-up applies. A single d.mode cannot express that blend, so weight
    // the three real modes here; otherwise this design matches no mode and
    // its tank designs silently lose every process stream.
    if (d.type == "OLEFINS_FLEX") {
      const ProcessInfo* of = catalog.process("OLEFINS_FLEX");
      if (of != nullptr) {
        const double mix[3] = {dc.flex_ethane, dc.flex_lpg, dc.flex_naphtha};
        const char* feeds[3] = {"ETHANE", "LPG", "NAPHTHA"};
        for (size_t mi = 0; mi < of->modes.size(); ++mi) {
          int k = -1;
          for (int j = 0; j < 3; ++j)
            if (of->modes[mi] == feeds[j]) k = j;
          if (k < 0 || mix[k] <= 0.0) continue;
          for (const NetStream& st : of->by_mode[mi].in) {
            const MaterialInfo* m = catalog.material(st.material);
            if (m == nullptr || m->kind != MatKind::Traded) continue;
            tf[{d.site, st.material}].out += st.t_per_t * mix[k] * d.rate_t_h;
          }
          for (const NetStream& st : of->by_mode[mi].out) {
            const MaterialInfo* m = catalog.material(st.material);
            if (m == nullptr || m->kind != MatKind::Traded) continue;
            tf[{d.site, st.material}].in += st.t_per_t * mix[k] * d.rate_t_h;
          }
        }
      }
      continue;
    }
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
    // Exact per-material cover from the preset's tank rules (§4.2), with the
    // role aggregates as fallback for materials the rules do not name.
    const double cov_m =
        preset && preset->cover_by_material.count(key.second)
            ? preset->cover_by_material.at(key.second)
            : 0.0;
    const double cov_f = preset ? preset->cover_feed_d : 10.0;
    const double cov_p = preset ? preset->cover_product_d : 10.0;
    const double cov_i = preset ? preset->cover_internal_d : 2.0;
    const double cov = params.cover_multiplier *
                       slots[static_cast<size_t>(key.first)].cover_weight;
    // A per-material cover is the catalog author's explicit rule for that
    // tank (e.g. chlorine holds about a day, not a week) — it wins outright.
    const double cap =
        internal
            ? std::max(f.in, f.out) * 24.0 * cov_i * cov
        : cov_m > 0.0
            ? std::max(f.in, f.out) * 24.0 * cov_m * cov
            : std::max({f.in * 24.0 * cov_p, f.out * 24.0 * cov_f}) * cov;
    const TankRole role =
        internal                                    ? TankRole::Internal
        : (f.in > 1e-12 && f.out > 1e-12)           ? TankRole::Both
        : f.in > 1e-12                              ? TankRole::Product
                                                    : TankRole::Feed;
    out.tanks.push_back({key.first, key.second, role, f.in, f.out, cap});
  }

  // ---- 11. Fleet: per flow pick the vehicle class the way the sim's
  // procurement would. Liquids follow the country's geography (§6.4): a
  // coastal-to-coastal pair ships the sea lanes; otherwise a pair with river
  // access both ends barges the inland waterway; road trucks take what is
  // left. Solids and bottled gases simply take the cheapest feasible class.
  // Either way the material's catalog mode list gates the choice, and count
  // = ceil(trips × round-trip ÷ 24 × 1.2).
  for (const auto& f : out.flows) {
    if (f.piped) continue;
    const MaterialInfo* mi = catalog.material(f.material);
    if (mi == nullptr) continue;
    struct Pick {
      const VehicleClassInfo* v = nullptr;
      double arc = 0.0, cost = 1e18;
    };
    Pick by_mode[3];  // indexed by Mode: Road, River, Sea
    for (const VehicleClassInfo& v : catalog.vehicles) {
      if (v.carries != mi->phase) continue;
      if ((mi->modes_mask & (1u << static_cast<uint8_t>(v.mode))) == 0) continue;
      const int a = routes.siteNode(f.from_site, v.mode);
      const int b = routes.siteNode(f.to_site, v.mode);
      if (a < 0 || b < 0 || !routes.reachable(a, b, v.mode)) continue;
      const double arc = routes.km(a, b, v.mode);
      const double cost = v.freight_per_t_km * arc;
      Pick& slot = by_mode[static_cast<uint8_t>(v.mode)];
      if (slot.v == nullptr || cost < slot.cost - 1e-12) slot = {&v, arc, cost};
    }
    const auto valid = [](const Pick& p) { return p.v != nullptr; };
    const bool both_sea = routes.siteNode(f.from_site, Mode::Sea) >= 0 &&
                          routes.siteNode(f.to_site, Mode::Sea) >= 0;
    const bool both_river = routes.siteNode(f.from_site, Mode::River) >= 0 &&
                            routes.siteNode(f.to_site, Mode::River) >= 0;
    Pick pick;
    // Short liquid legs move by truck: a barge's ~17 h cycle cannot absorb
    // the many short refinery-to-city lanes, and queueing there starves the
    // refineries (product tanks fill, plants shut down). Barges and ships
    // keep the long lanes, where their per-tonne cost wins.
    if (mi->phase == Phase::Liquid && valid(by_mode[0]) && by_mode[0].arc <= 120.0) {
      pick = by_mode[0];  // short lane: road
    } else if (mi->phase == Phase::Liquid && both_sea && valid(by_mode[2])) {
      pick = by_mode[2];  // coastal pair: sea lanes
    } else if (mi->phase == Phase::Liquid && both_river && valid(by_mode[1])) {
      pick = by_mode[1];  // inland pair: the river
    } else {
      for (int m = 0; m < 3; ++m)
        if (valid(by_mode[m]) && by_mode[m].cost < pick.cost) pick = by_mode[m];
    }
    if (pick.v == nullptr) continue;
    const int home = f.from_site;
    const double trips = f.t_d / pick.v->capacity_t;
    const double rt_h = 2.0 * pick.arc / std::max(1.0, pick.v->speed_kmh) +
                        2.0 * pick.v->capacity_t / std::max(1.0, pick.v->load_t_h);
    const int count = static_cast<int>(std::ceil(trips * rt_h / 24.0 * kFleetPadding));
    out.fleet.push_back({pick.v->key, home, std::max(1, count)});
  }

  return out;
}

}  // namespace worldgen
}  // namespace crx
