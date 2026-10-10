#include "world/worldgen/Layout.h"

#include "world/worldgen/Geo.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace crx {
namespace worldgen {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Fictional toponyms — fixed pools keep site names deterministic and unique.
constexpr std::array<const char*, 8> kCityNames = {"Ashcombe",  "Belvale",   "Carrowmore",
                                                   "Dunlow",    "Eastbrook", "Fennmouth",
                                                   "Garrowby",  "Hollowden"};
constexpr std::array<const char*, 2> kPortNames = {"Brackenmouth", "Saltmere"};

Vec2 ringPos(Vec2 center, double r_min, double r_max, Rng& rng) {
  const double r = rng.uniform(r_min, r_max);
  const double angle = rng.uniform01() * 2.0 * kPi;
  return {center.x + r * std::cos(angle), center.y + r * std::sin(angle)};
}

// Move a point toward the land centre, perpendicular to the coast.
Vec2 inland(const Frame& frame, Vec2 p, double km) {
  Vec2 dir{0.0, 0.0};
  switch (frame.sea_edge) {
    case 0: dir = {0.0, -1.0}; break;
    case 1: dir = {0.0, 1.0}; break;
    case 2: dir = {-1.0, 0.0}; break;
    default: dir = {1.0, 0.0}; break;
  }
  return p + dir * km;
}

std::string suffix(int ordinal) {
  return std::string(1, static_cast<char>('A' + ordinal));
}

}  // namespace

Vec2 Frame::coastPoint(double u) const {
  switch (sea_edge) {
    case 0: return {u * w_km, h_km};
    case 1: return {u * w_km, 0.0};
    case 2: return {w_km, u * h_km};
    default: return {0.0, u * h_km};
  }
}

double Frame::distToCoast(Vec2 p) const {
  switch (sea_edge) {
    case 0: return h_km - p.y;
    case 1: return p.y;
    case 2: return w_km - p.x;
    default: return p.x;
  }
}

bool Frame::onLand(Vec2 p, double margin_km) const {
  return p.x >= margin_km && p.x <= w_km - margin_km && p.y >= margin_km &&
         p.y <= h_km - margin_km && distToCoast(p) >= margin_km;
}

Frame makeFrame(const GenParams& params, Rng& rng) {
  Frame f;
  f.w_km = params.map_w_km;
  f.h_km = params.map_h_km;
  f.sea_edge = static_cast<int>(rng.below(4));
  f.sea_leg_km = params.sea_leg_days * 24.0 * params.ship_speed_kmh;  // 18 d ≈ 11,232 km
  const Vec2 mid = f.coastPoint(0.5);
  Vec2 outward{0.0, 0.0};
  switch (f.sea_edge) {
    case 0: outward = {0.0, 1.0}; break;
    case 1: outward = {0.0, -1.0}; break;
    case 2: outward = {1.0, 0.0}; break;
    default: outward = {-1.0, 0.0}; break;
  }
  f.overseas = mid + outward * f.sea_leg_km;
  return f;
}

Features makeFeatures(const GenParams& params, Rng& rng, const Frame& frame) {
  Features ft;

  // -- Basins and the salt deposit: interior points with pairwise separation.
  const double margin = 60.0;
  const std::array<double, 3> separations = {160.0, 140.0, 140.0};  // oil-gas, oil-salt, gas-salt
  std::array<Vec2, 3> deposits{};
  for (int attempt = 0; attempt < 8192; ++attempt) {
    for (auto& d : deposits) {
      d = {rng.uniform(margin, frame.w_km - margin), rng.uniform(margin, frame.h_km - margin)};
    }
    bool ok = frame.onLand(deposits[0], margin) && frame.onLand(deposits[1], margin) &&
              frame.onLand(deposits[2], margin);
    if (ok) {
      const double relax = attempt >= 4096 ? 0.96 : 1.0;
      ok = distKM(deposits[0], deposits[1]) >= separations[0] * relax &&
           distKM(deposits[0], deposits[2]) >= separations[1] * relax &&
           distKM(deposits[1], deposits[2]) >= separations[2] * relax;
    }
    if (ok) break;
  }
  ft.oil_basin = deposits[0];
  ft.gas_basin = deposits[1];
  ft.salt_deposit = deposits[2];

  // -- Ports: two fractions along the coast, far apart (§6.3 siting rules).
  ft.port_u[0] = rng.uniform(0.18, 0.30);
  ft.port_u[1] = rng.uniform(0.62, 0.78);

  // -- River: highlands (inland corner farthest from the sea) to a coastal
  // mouth kept clear of both ports, as a wiggled polyline (§6.2).
  const double cx = frame.w_km / 2.0, cy = frame.h_km / 2.0;
  std::array<Vec2, 4> corners = {{ {0, 0}, {frame.w_km, 0}, {frame.w_km, frame.h_km}, {0, frame.h_km} }};
  Vec2 start = corners[0];
  double best = -1.0;
  for (const Vec2 c : corners) {
    const double d = frame.distToCoast(c);
    if (d > best + 1e-9) {
      best = d;
      start = c;
    }
  }
  start = {start.x + (cx - start.x > 0 ? 60.0 : -60.0), start.y + (cy - start.y > 0 ? 60.0 : -60.0)};
  double mouth_u = 0.0;
  for (int attempt = 0; attempt < 256; ++attempt) {
    const double u = rng.uniform(0.20, 0.80);
    if (std::abs(u - ft.port_u[0]) >= 0.18 && std::abs(u - ft.port_u[1]) >= 0.18) {
      mouth_u = u;
      break;
    }
    mouth_u = u;
  }
  const Vec2 mouth = frame.coastPoint(mouth_u);
  ft.river = wigglePolyline(start, mouth, 1.25, rng);

  // -- Cities: rank-size populations, rejection-sampled with spacing and
  // clearance from basins and the river (§6.2).
  const int n = std::max(1, params.n_cities);
  double rank_sum = 0.0;
  for (int i = 1; i <= n; ++i) rank_sum += 1.0 / std::pow(static_cast<double>(i), params.rank_size_exponent);

  const double spacing0 = params.city_min_spacing_km;
  double spacing = spacing0;
  int failures = 0;
  ft.cities.reserve(static_cast<size_t>(n));
  while (static_cast<int>(ft.cities.size()) < n && failures < 20000) {
    const Vec2 p = {rng.uniform(50.0, frame.w_km - 50.0), rng.uniform(50.0, frame.h_km - 50.0)};
    ++failures;
    bool ok = frame.onLand(p, 45.0) && polylineMinDist(p, ft.river) >= 12.0 &&
              distKM(p, ft.oil_basin) >= 45.0 && distKM(p, ft.gas_basin) >= 45.0 &&
              distKM(p, ft.salt_deposit) >= 45.0;
    if (ok) {
      for (const City& c : ft.cities) {
        if (distKM(p, c.pos) < spacing) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      const int idx = static_cast<int>(ft.cities.size());
      const double pop = params.top_population_m *
                         (std::pow(static_cast<double>(idx + 1), -params.rank_size_exponent) /
                          rank_sum);
      ft.cities.push_back(City{p, pop, kCityNames[static_cast<size_t>(idx) % kCityNames.size()]});
      spacing = spacing0;
      failures = 0;
    } else if (failures % 256 == 0) {
      spacing *= 0.96;  // deterministic relaxation
      if (spacing < 40.0) spacing = 40.0;
    }
  }
  return ft;
}

std::vector<SiteSlot> placeSites(const GenParams& params, Rng& rng, const Features& ft,
                                 const Frame& frame) {
  std::vector<SiteSlot> slots;
  slots.reserve(48);

  const auto tooClose = [&](Vec2 p, double min_km) {
    for (const SiteSlot& s : slots)
      if (distKM(p, s.pos) < min_km) return true;
    return false;
  };

  // Sample a position in [r_min, r_max] of `center` until it clears the placed
  // sites; relax after 64 failures, give up gracefully after 256 (accepting
  // the last sample keeps placement total — sites may end up close together).
  const auto near = [&](Vec2 center, double r_min, double r_max, double min_sep) {
    for (int attempt = 0; attempt < 256; ++attempt) {
      const Vec2 p = ringPos(center, r_min, r_max, rng);
      if (!tooClose(p, min_sep)) return p;
      if (attempt % 64 == 63) min_sep *= 0.95;
    }
    return ringPos(center, r_min, r_max, rng);
  };

  const auto push = [&](const char* preset, const std::string& name, Vec2 p,
                        const char* variant = "", int city = -1) {
    SiteSlot s;
    s.preset = preset;
    s.name = name;
    s.variant = variant;
    s.pos = {roundTo(std::clamp(p.x, 1.0, frame.w_km - 1.0), 0.1),
             roundTo(std::clamp(p.y, 1.0, frame.h_km - 1.0), 0.1)};
    s.city = city;
    slots.push_back(s);
  };

  // Ports on the coast (§6.3: refineries/crackers at ports).
  const Vec2 port_a = frame.coastPoint(ft.port_u[0]);
  const Vec2 port_b = frame.coastPoint(ft.port_u[1]);
  push("PORT_TERMINAL", std::string("Port ") + kPortNames[0], port_a);
  push("PORT_TERMINAL", std::string("Port ") + kPortNames[1], port_b);

  // Refineries just inland of the ports; crackers beside them.
  const Vec2 ref_a = inland(frame, port_a, 5.0);
  const Vec2 ref_b = inland(frame, port_b, 5.0);
  push("REFINERY", "Refinery A", ref_a);
  push("REFINERY", "Refinery B", ref_b);
  const Vec2 crk_a = inland(frame, ref_a, 8.0);
  const Vec2 crk_b = inland(frame, ref_b, 8.0);
  push("STEAM_CRACKER", "Cracker A (gas)", crk_a, "gas");
  push("STEAM_CRACKER", "Cracker B (flex)", crk_b, "flex");

  // Fields: oil and gas around their basins, salt at the deposit.
  push("OIL_FIELD", "Oil field A", near(ft.oil_basin, 8.0, 28.0, 10.0));
  push("OIL_FIELD", "Oil field B", near(ft.oil_basin, 8.0, 28.0, 10.0));
  push("GAS_FIELD", "Gas field A", near(ft.gas_basin, 8.0, 28.0, 10.0));
  push("GAS_FIELD", "Gas field B", near(ft.gas_basin, 8.0, 28.0, 10.0));
  push("GAS_FIELD", "Gas field C", near(ft.gas_basin, 8.0, 28.0, 10.0));
  push("SALT_MINE", "Salt mine", ft.salt_deposit);

  // Gas plants at the gas basin, clear of the wells.
  push("GAS_PLANT", "Gas plant A", near(ft.gas_basin, 6.0, 20.0, 12.0));
  push("GAS_PLANT", "Gas plant B", near(ft.gas_basin, 6.0, 20.0, 12.0));
  push("GAS_PLANT", "Gas plant C", near(ft.gas_basin, 6.0, 20.0, 12.0));

  // Derivative plants within 25 km of a cracker (§6.3), alternating between
  // the two crackers so no single cluster carries everything.
  const int cracker_count = 2;
  int pe_seen = 0;
  for (int i = 0; i < 3; ++i) {
    const Vec2 crk = (i % cracker_count == 0) ? crk_a : crk_b;
    push("POLYETHYLENE", std::string("PE plant ") + suffix(pe_seen++), near(crk, 8.0, 16.0, 6.0));
  }
  push("POLYPROPYLENE", "PP plant", near(crk_a, 10.0, 18.0, 6.0));
  std::array<Vec2, 2> vinyls_pos{};
  for (int i = 0; i < 2; ++i) {
    const Vec2 crk = (i % cracker_count == 0) ? crk_a : crk_b;
    vinyls_pos[static_cast<size_t>(i)] = near(crk, 10.0, 20.0, 6.0);
    push("VINYLS", std::string("Vinyls plant ") + suffix(i),
         vinyls_pos[static_cast<size_t>(i)]);
  }
  // Chlor-alkali next to vinyls (§6.3).
  push("CHLOR_ALKALI", "Chlor-alkali A", near(vinyls_pos[0], 3.0, 6.0, 3.0));
  push("CHLOR_ALKALI", "Chlor-alkali B", near(vinyls_pos[1], 3.0, 6.0, 3.0));
  push("STYRENICS", "Styrenics plant", near(crk_a, 8.0, 14.0, 6.0));

  // Gas grid by the largest city.
  Vec2 largest = ft.cities.empty() ? Vec2{frame.w_km / 2, frame.h_km / 2} : ft.cities[0].pos;
  push("GAS_GRID", "Gas grid", near(largest, 6.0, 10.0, 4.0));

  // City sinks: a fuel depot in every city, industrial sinks in the five
  // largest (§6.3).
  for (size_t i = 0; i < ft.cities.size(); ++i) {
    const City& c = ft.cities[i];
    push("FUEL_DEPOT", "Fuel depot " + c.name, near(c.pos, 1.0, 3.0, 3.0), "", static_cast<int>(i));
  }
  const std::array<const char*, 5> industrial = {
      "PACKAGING", "CONSTRUCTION", "CONSUMER_GOODS", "PAINTS_COATINGS", "PROCESS_INDUSTRIES"};
  for (size_t i = 0; i < industrial.size() && i < ft.cities.size(); ++i) {
    const City& c = ft.cities[i];
    push(industrial[i], std::string(industrial[i]) + " (" + c.name + ")",
         near(c.pos, 2.0, 5.0, 3.0), "", static_cast<int>(i));
  }

  (void)params;  // siting is template-driven; params only bound counts upstream
  return slots;
}

}  // namespace worldgen
}  // namespace crx
