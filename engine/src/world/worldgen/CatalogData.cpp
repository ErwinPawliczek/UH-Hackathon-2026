// CatalogView implementation — LOCAL REFERENCE TABLE.
//
// ⚠️ Clearly-marked local data: every number below is transcribed from
// docs/OUTLINE.md §3 (v0.3). This table exists only until the catalog
// workstream's loader (engine/src/catalog + engine/data/catalog) merges;
// `referenceCatalog()` is then rebuilt on top of the loader and this file
// shrinks to the lookup helpers.

#include "world/worldgen/CatalogView.h"

namespace crx {
namespace worldgen {

namespace {

constexpr uint8_t kRoad = 1u << 0;
constexpr uint8_t kRiver = 1u << 1;
constexpr uint8_t kSea = 1u << 2;
constexpr uint8_t kPipe = 1u << 3;

MaterialInfo mat(const char* key, Phase phase, MatKind kind, uint8_t modes, double price) {
  return MaterialInfo{key, phase, kind, modes, price};
}

NetStream s(const char* m, double t) { return NetStream{m, t}; }

ProcessInfo::UnitInfo u(const char* key, uint8_t trains) { return {key, trains}; }

}  // namespace

const MaterialInfo* CatalogView::material(const std::string& key) const {
  for (const auto& m : materials)
    if (m.key == key) return &m;
  return nullptr;
}

const ProcessInfo* CatalogView::process(const std::string& key) const {
  for (const auto& p : processes)
    if (p.key == key) return &p;
  return nullptr;
}

const PresetInfo* CatalogView::preset(const std::string& key) const {
  for (const auto& p : presets)
    if (p.key == key) return &p;
  return nullptr;
}

const VehicleClassInfo* CatalogView::vehicle(const std::string& key) const {
  for (const auto& v : vehicles)
    if (v.key == key) return &v;
  return nullptr;
}

CatalogView referenceCatalog() {
  CatalogView c;

  // ---- Materials (§3.1): key, phase, kind, modes P/S/B/T, base price $/t ----
  c.materials = {
      mat("CRUDE", Phase::Liquid, MatKind::Traded, kPipe | kSea, 520),
      mat("RAW_GAS", Phase::Gas, MatKind::Traded, kPipe, 120),
      mat("SALT", Phase::Solid, MatKind::Traded, kSea | kRiver | kRoad, 50),
      mat("METHANE", Phase::Gas, MatKind::Traded, kPipe, 180),
      mat("ETHANE", Phase::LiquefiedGas, MatKind::Traded, kPipe | kSea, 220),
      mat("LPG", Phase::LiquefiedGas, MatKind::Traded, kPipe | kSea | kRiver | kRoad, 450),
      mat("NAPHTHA", Phase::Liquid, MatKind::Traded, kPipe | kSea | kRiver | kRoad, 600),
      mat("GASOLINE", Phase::Liquid, MatKind::Traded, kPipe | kSea | kRiver | kRoad, 750),
      mat("JET", Phase::Liquid, MatKind::Traded, kPipe | kSea | kRiver | kRoad, 740),
      mat("DIESEL", Phase::Liquid, MatKind::Traded, kPipe | kSea | kRiver | kRoad, 720),
      mat("FUEL_OIL", Phase::Liquid, MatKind::Traded, kSea | kRiver | kRoad, 430),
      mat("SOLVENT", Phase::Liquid, MatKind::Traded, kSea | kRiver | kRoad, 850),
      mat("BENZENE", Phase::Liquid, MatKind::Traded, kSea | kRiver | kRoad, 900),
      mat("ETHYLENE", Phase::Gas, MatKind::Traded, kPipe | kSea, 900),
      mat("PROPYLENE", Phase::LiquefiedGas, MatKind::Traded, kPipe | kSea | kRoad, 850),
      mat("CHLORINE", Phase::LiquefiedGas, MatKind::Traded, kPipe | kRoad, 300),
      mat("CAUSTIC", Phase::Liquid, MatKind::Traded, kSea | kRiver | kRoad, 400),
      mat("STYRENE", Phase::Liquid, MatKind::Traded, kSea | kRiver | kRoad, 1100),
      mat("PE", Phase::Solid, MatKind::Traded, kSea | kRiver | kRoad, 1200),
      mat("PP", Phase::Solid, MatKind::Traded, kSea | kRiver | kRoad, 1150),
      mat("PVC", Phase::Solid, MatKind::Traded, kSea | kRiver | kRoad, 950),
      mat("PS", Phase::Solid, MatKind::Traded, kSea | kRiver | kRoad, 1400),
      // Site-internal (tank between processes on one site, §3.1)
      mat("HEAVY_NAPHTHA", Phase::Liquid, MatKind::SiteInternal, 0, 0),
      mat("GASOIL", Phase::Liquid, MatKind::SiteInternal, 0, 0),
      mat("VGO", Phase::Liquid, MatKind::SiteInternal, 0, 0),
      mat("VCM", Phase::LiquefiedGas, MatKind::SiteInternal, 0, 0),
      // Pseudos that close the balances (§3.1)
      mat("FUEL_GAS", Phase::Gas, MatKind::Pseudo, 0, 0),
      mat("WATER", Phase::Liquid, MatKind::Pseudo, 0, 0),
      mat("AIR_O2", Phase::Gas, MatKind::Pseudo, 0, 0),
      mat("LOSS", Phase::Liquid, MatKind::Pseudo, 0, 0),
  };

  // ---- Process types (§3.2): per-mode unit aggregates, t per t of basis ----
  {
    ProcessInfo p;
    p.key = "NGL_RECOVERY";
    p.basis = "RAW_GAS";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{
        {s("RAW_GAS", 1.000)},
        {s("METHANE", 0.787), s("ETHANE", 0.078), s("LPG", 0.074), s("NAPHTHA", 0.021),
         s("LOSS", 0.040)}}};
    p.nameplate_t_d = 30000.0;  // t/d raw gas (~350 MMscfd; 3 plants cover the
                                // ethane-driven requirement at utilisation 0.88)
    p.units = {u("GP-AMINE", 2), u("GP-CRYO", 2), u("GP-FRAC", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "CRUDE_DISTILLATION";
    p.basis = "CRUDE";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{
        {s("CRUDE", 1.000)},
        {s("LPG", 0.020), s("NAPHTHA", 0.070), s("HEAVY_NAPHTHA", 0.130), s("JET", 0.100),
         s("GASOIL", 0.250), s("VGO", 0.250), s("FUEL_OIL", 0.180)}}};
    p.nameplate_t_d = 27000.0;  // t/d crude
    p.units = {u("RF-CDU", 1), u("RF-VDU", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "REFORMING";
    p.basis = "HEAVY_NAPHTHA";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{
        {s("HEAVY_NAPHTHA", 1.000)},
        {s("GASOLINE", 0.690), s("SOLVENT", 0.100), s("BENZENE", 0.060), s("LPG", 0.080),
         s("FUEL_GAS", 0.065), s("LOSS", 0.005)}}};
    p.nameplate_t_d = 27000.0 * 0.130;  // full CDU heavy-naphtha cut
    p.units = {u("RF-NHT", 1), u("RF-CCR", 1), u("RF-BTX", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "FCC";
    p.basis = "VGO";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{
        {s("VGO", 1.000)},
        {s("GASOLINE", 0.480), s("DIESEL", 0.180), s("LPG", 0.110), s("FUEL_OIL", 0.070),
         s("FUEL_GAS", 0.060), s("PROPYLENE", 0.050), s("LOSS", 0.050)}}};
    p.nameplate_t_d = 27000.0 * 0.250;  // full CDU VGO cut
    p.units = {u("RF-FCC", 1), u("RF-FRAC", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "DIESEL_HDT";
    p.basis = "GASOIL";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("GASOIL", 1.000)}, {s("DIESEL", 0.980), s("LOSS", 0.020)}}};
    p.nameplate_t_d = 27000.0 * 0.250;  // full CDU gasoil cut
    p.units = {u("RF-DHT", 2)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "OLEFINS";
    p.basis = "FRESH_FEED";  // one of the mode feeds; yield table §3.2
    p.modes = {"ETHANE", "LPG", "NAPHTHA"};
    p.by_mode = {
        NetRecipe{{s("ETHANE", 1.000)},
                  {s("ETHYLENE", 0.780), s("PROPYLENE", 0.030), s("LPG", 0.030),
                   s("BENZENE", 0.007), s("GASOLINE", 0.013), s("FUEL_GAS", 0.130),
                   s("FUEL_OIL", 0.010)}},
        NetRecipe{{s("LPG", 1.000)},
                  {s("ETHYLENE", 0.420), s("PROPYLENE", 0.170), s("LPG", 0.050),
                   s("BENZENE", 0.025), s("GASOLINE", 0.045), s("FUEL_GAS", 0.270),
                   s("FUEL_OIL", 0.020)}},
        NetRecipe{{s("NAPHTHA", 1.000)},
                  {s("ETHYLENE", 0.310), s("PROPYLENE", 0.160), s("LPG", 0.090),
                   s("BENZENE", 0.075), s("GASOLINE", 0.145), s("FUEL_GAS", 0.170),
                   s("FUEL_OIL", 0.050)}}};
    p.nameplate_t_d = 5500.0;  // t/d fresh feed
    p.units = {u("SC-FURN", 8), u("SC-QUENCH", 1), u("SC-CGC", 1), u("SC-COLD", 1),
               u("SC-BTX", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "ELECTROLYSIS";
    p.basis = "CHLORINE";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("SALT", 1.648), s("WATER", 0.508)},
                           {s("CHLORINE", 1.000), s("CAUSTIC", 1.128), s("FUEL_GAS", 0.028)}}};
    p.nameplate_t_d = 1370.0;  // t/d chlorine (500 kt/y)
    p.units = {u("CA-BRINE", 1), u("CA-CELL", 6), u("CA-CL2", 1), u("CA-EVAP", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "PE_POLYMERISATION";
    p.basis = "PE";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("ETHYLENE", 1.015)}, {s("PE", 1.000), s("LOSS", 0.015)}}};
    p.nameplate_t_d = 1370.0;  // t/d PE (500 kt/y)
    p.units = {u("PO-PURIF", 1), u("PO-RX", 2), u("PO-EXTR", 2)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "PP_POLYMERISATION";
    p.basis = "PP";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("PROPYLENE", 1.020)}, {s("PP", 1.000), s("LOSS", 0.020)}}};
    p.nameplate_t_d = 820.0;  // t/d PP (300 kt/y)
    p.units = {u("PO-PURIF", 1), u("PO-RX", 2), u("PO-EXTR", 2)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "VCM";
    p.basis = "VCM";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("ETHYLENE", 0.465), s("CHLORINE", 0.585), s("AIR_O2", 0.135)},
                           {s("VCM", 1.000), s("LOSS", 0.185)}}};
    p.nameplate_t_d = 1640.0 * 1.020;  // feeds the site's PVC nameplate
    p.units = {u("VN-DC", 1), u("VN-OXY", 1), u("VN-CRACK", 4), u("VN-PURIF", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "PVC_POLY";
    p.basis = "PVC";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("VCM", 1.020)}, {s("PVC", 1.000), s("LOSS", 0.020)}}};
    p.nameplate_t_d = 1640.0;  // t/d PVC (600 kt/y)
    p.units = {u("VN-POLY", 8), u("VN-DRY", 2)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "STYRENE_PROC";
    p.basis = "STYRENE";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("BENZENE", 0.780), s("ETHYLENE", 0.285)},
                           {s("STYRENE", 1.000), s("SOLVENT", 0.020), s("FUEL_GAS", 0.020),
                            s("LOSS", 0.025)}}};
    p.nameplate_t_d = 550.0;  // t/d styrene (200 kt/y)
    p.units = {u("ST-ALK", 1), u("ST-DEHY", 2), u("ST-DIST", 1)};
    c.processes.push_back(p);
  }
  {
    ProcessInfo p;
    p.key = "PS_POLY";
    p.basis = "PS";
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s("STYRENE", 1.010)}, {s("PS", 1.000), s("LOSS", 0.010)}}};
    p.nameplate_t_d = 550.0 / 1.010;  // styrene made on site, mostly to PS
    p.units = {u("ST-PS", 2)};
    c.processes.push_back(p);
  }
  // Sources and sinks: ordinary processes with no input / no output (§2).
  // LOCAL generator convention: one SINK_<MATERIAL> per consumed material, one
  // <MATERIAL>_SUPPLY per field; design rates come from the sizing walk.
  for (const char* sink : {"METHANE", "GASOLINE", "DIESEL", "JET", "LPG", "PE", "PP", "PVC",
                           "PS", "SOLVENT", "STYRENE", "CAUSTIC"}) {
    ProcessInfo p;
    p.key = std::string("SINK_") + sink;
    p.basis = sink;
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{s(sink, 1.000)}, {}}};
    p.nameplate_t_d = 0.0;  // sinks are sized by demand, not nameplate
    p.units = {u("SINK", 1)};
    c.processes.push_back(p);
  }
  for (const char* src : {"CRUDE", "RAW_GAS", "SALT"}) {
    ProcessInfo p;
    p.key = std::string(src) + "_SUPPLY";
    p.basis = src;
    p.modes = {"DEFAULT"};
    p.by_mode = {NetRecipe{{}, {s(src, 1.000)}}};
    p.nameplate_t_d = 0.0;  // sources are sized by downstream requirement
    p.units = {u("WELL", 1)};
    c.processes.push_back(p);
  }

  // ---- Site presets (§3.3 + §3.2 processes per site) ----
  {
    auto preset = [&](const char* key, const char* name, std::vector<std::string> procs,
                      double cf, double cp, double ci, uint8_t br, uint8_t brv, uint8_t bs) {
      PresetInfo p;
      p.key = key;
      p.name = name;
      p.process_keys = std::move(procs);
      p.cover_feed_d = cf;
      p.cover_product_d = cp;
      p.cover_internal_d = ci;
      p.bays_road = br;
      p.bays_river = brv;
      p.bays_sea = bs;
      c.presets.push_back(p);
    };
    preset("OIL_FIELD", "Oil field", {"CRUDE_SUPPLY"}, 10.0, 10.0, 2.0, 1, 0, 0);
    preset("GAS_FIELD", "Gas field", {"RAW_GAS_SUPPLY"}, 10.0, 10.0, 2.0, 1, 0, 0);
    preset("SALT_MINE", "Salt mine", {"SALT_SUPPLY"}, 10.0, 10.0, 2.0, 2, 0, 0);
    preset("GAS_PLANT", "Gas plant", {"NGL_RECOVERY"}, 15.0, 10.0, 2.0, 2, 0, 0);
    preset("REFINERY", "Refinery",
           {"CRUDE_DISTILLATION", "REFORMING", "FCC", "DIESEL_HDT"}, 15.0, 10.0, 2.0, 4, 2, 0);
    preset("STEAM_CRACKER", "Steam cracker", {"OLEFINS"}, 15.0, 10.0, 2.0, 3, 0, 0);
    preset("CHLOR_ALKALI", "Chlor-alkali plant", {"ELECTROLYSIS"}, 15.0, 2.0, 2.0, 2, 0, 0);
    preset("POLYETHYLENE", "Polyethylene plant", {"PE_POLYMERISATION"}, 12.0, 10.0, 2.0, 3, 0,
           0);
    preset("POLYPROPYLENE", "Polypropylene plant", {"PP_POLYMERISATION"}, 12.0, 10.0, 2.0, 3,
           0, 0);
    preset("VINYLS", "Vinyls plant", {"VCM", "PVC_POLY"}, 12.0, 10.0, 2.0, 3, 0, 0);
    preset("STYRENICS", "Styrenics plant", {"STYRENE_PROC", "PS_POLY"}, 12.0, 10.0, 2.0, 3, 0,
           0);
    preset("GAS_GRID", "Gas grid", {"SINK_METHANE"}, 5.0, 5.0, 2.0, 1, 0, 0);
    preset("FUEL_DEPOT", "Fuel depot",
           {"SINK_GASOLINE", "SINK_DIESEL", "SINK_JET", "SINK_LPG"}, 10.0, 10.0, 2.0, 4, 0, 0);
    preset("PACKAGING", "Packaging plants", {"SINK_PE", "SINK_PP"}, 12.0, 12.0, 2.0, 3, 0, 0);
    preset("CONSTRUCTION", "Construction industry", {"SINK_PVC"}, 12.0, 12.0, 2.0, 3, 0, 0);
    preset("CONSUMER_GOODS", "Consumer goods", {"SINK_PS", "SINK_PP"}, 12.0, 12.0, 2.0, 3, 0,
           0);
    preset("PAINTS_COATINGS", "Paints and coatings", {"SINK_SOLVENT", "SINK_STYRENE"}, 12.0,
           12.0, 2.0, 3, 0, 0);
    preset("PROCESS_INDUSTRIES", "Process industries", {"SINK_CAUSTIC"}, 12.0, 12.0, 2.0, 3, 0,
           0);
    preset("PORT_TERMINAL", "Port terminal", {}, 15.0, 15.0, 2.0, 2, 2, 4);
  }

  // ---- Vehicle classes (§3.4) ----
  {
    auto veh = [&](const char* key, Mode mode, Phase phase, double cap, double spd,
                   double load, double freight) {
      c.vehicles.push_back(VehicleClassInfo{key, mode, phase, cap, spd, load, freight});
    };
    veh("TRUCK_TANK", Mode::Road, Phase::Liquid, 25.0, 70.0, 50.0, 0.10);
    veh("TRUCK_PRESS", Mode::Road, Phase::LiquefiedGas, 20.0, 70.0, 40.0, 0.14);
    veh("TRUCK_BULK", Mode::Road, Phase::Solid, 25.0, 70.0, 50.0, 0.10);
    veh("BARGE_TANK", Mode::River, Phase::Liquid, 2000.0, 12.0, 400.0, 0.025);
    veh("BARGE_DRY", Mode::River, Phase::Solid, 1500.0, 12.0, 300.0, 0.025);
    veh("SHIP_TANK", Mode::Sea, Phase::Liquid, 40000.0, 26.0, 2500.0, 0.004);
    veh("SHIP_GAS", Mode::Sea, Phase::LiquefiedGas, 12000.0, 30.0, 800.0, 0.008);
    veh("SHIP_DRY", Mode::Sea, Phase::Solid, 20000.0, 24.0, 1000.0, 0.005);
  }

  return c;
}

}  // namespace worldgen
}  // namespace crx
