#!/usr/bin/env python3
"""Build engine/data/worlds/erwin-world-v1.json from the hand-drawn layout.

The layout (design/worlds/erwin-world-v1.json) fixes where everything is: sites,
road / river / sea strips, pipelines and water. This script adds what a layout
cannot carry: how big each plant is, how much each customer takes, tank sizes,
which sites have river and sea berths, and the fleet. Rates are closed forward
from the three sources so that every tonne made has somewhere to go.

Run from the repository root:  python3 tools/worlds/build_erwin_world.py
"""
import heapq
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAYOUT = ROOT / "design/worlds/erwin-world-v1.json"
OUT = ROOT / "engine/data/worlds/erwin-world-v1.json"

# ----------------------------------------------------------------------------
# Knobs
# ----------------------------------------------------------------------------
RAW_GAS = 500.0          # gas plant design, t/h of raw gas
FLEX_DESIGN = 44.0       # flex cracker design, t/h of furnace feed basis
FLEX_TRAINS = [1, 1, 6]  # furnaces on ETHANE / LPG / NAPHTHA
SINK_SHARE = 0.98        # customers take this share of what the chain can make
PLANT_SPARE = 1.00       # plants are built to the balance. (Tried 1.10 with full product tanks:
                         # any upset then gridlocks the whole world, so no spare here.)
SOURCE_MARGIN = 1.03     # fields and the mine can make this much more than needed
PRODUCT_GAP_H = None     # starting pickup gap (h) of product tanks; None keeps the engine's 4 h
STYRENE_TO_PAINTS = 0.18 # share of styrene sold as monomer instead of made into PS
PP_TO_PACKAGING = 0.60
NORTH_PORT_BUNKER = 12.0 # t/h of fuel oil trucked to the north port
FLEET_SPARE = 1.30
SMOOTH_KM = 8.0          # corners of drawn roads, lanes and pipelines are rounded with this radius
TRUCK_LEAD = 64.0       # starting lead time (h) for truck-fed tanks; they hold about 2.5 x half of it
# Ordering rules for this world (engine MarketParams overrides): a buyer waits
# until it can fill most of a vehicle, places at most a few lots per hour, and
# waiting orders are served first come first served (urgency buys a 48 h head start).
MARKET = {"min_lot_cap_frac": 0.8, "min_lot_target_frac": 0.4, "max_lots_per_tank": 3,
          "dispatch_urgency_boost_h": 48,
          # No supplier contracts in this world, so a charge for "switching supplier" would
          # sit on every option equally and only confuse the Supply options view.
          "switch_cost_frac": 0.0}

MERGE_KM = 4.0
ATTACH_KM = 12.0
SPEED = {"road": 70.0, "river": 12.0, "sea": 28.0}

# Net recipes, tonnes per tonne of basis (engine catalog, dumped from the loader).
Y = {
    "NGL": {"METHANE": 0.787, "ETHANE": 0.078, "LPG": 0.074, "NAPHTHA": 0.021},
    "CDU": {"LPG": 0.02, "NAPHTHA": 0.07, "JET": 0.10, "FUEL_OIL": 0.18,
            "HEAVY_NAPHTHA": 0.13, "GASOIL": 0.25, "VGO": 0.25},
    "REF": {"LPG": 0.08, "GASOLINE": 0.69, "SOLVENT": 0.10, "BENZENE": 0.06},
    "FCC": {"LPG": 0.11, "GASOLINE": 0.48, "DIESEL": 0.18, "FUEL_OIL": 0.07, "PROPYLENE": 0.05},
    "HDT": {"DIESEL": 0.98},
    "ETH": {"LPG": 0.03, "GASOLINE": 0.013, "FUEL_OIL": 0.01, "BENZENE": 0.007,
            "ETHYLENE": 0.78, "PROPYLENE": 0.03},
    "LPGM": {"LPG": -0.95, "GASOLINE": 0.045, "FUEL_OIL": 0.02, "BENZENE": 0.025,
             "ETHYLENE": 0.42, "PROPYLENE": 0.17},
    "NAP": {"LPG": 0.09, "GASOLINE": 0.145, "FUEL_OIL": 0.05, "BENZENE": 0.075,
            "ETHYLENE": 0.31, "PROPYLENE": 0.16},
}

VEH = {  # capacity t, speed km/h, load t/h, mode, phase carried
    "TRUCK_TANK": (25, 70, 50, "road", "liquid"),
    "TRUCK_PRESS": (20, 70, 40, "road", "liquefied_gas"),
    "TRUCK_BULK": (25, 70, 50, "road", "solid"),
    "BARGE_TANK": (2000, 12, 400, "river", "liquid"),
    "BARGE_DRY": (1500, 12, 300, "river", "solid"),
    "SHIP_TANK": (40000, 26, 2500, "sea", "liquid"),
    "SHIP_GAS": (12000, 30, 800, "sea", "liquefied_gas"),
    "SHIP_DRY": (20000, 24, 1000, "sea", "solid"),
}
PHASE = {"SALT": "solid", "LPG": "liquefied_gas", "NAPHTHA": "liquid", "GASOLINE": "liquid",
         "JET": "liquid", "DIESEL": "liquid", "FUEL_OIL": "liquid", "SOLVENT": "liquid",
         "BENZENE": "liquid", "PROPYLENE": "liquefied_gas", "CHLORINE": "liquefied_gas",
         "CAUSTIC": "liquid", "STYRENE": "liquid", "PE": "solid", "PP": "solid",
         "PVC": "solid", "PS": "solid"}
MAT_MODES = {"SALT": "road river sea", "LPG": "road river sea", "NAPHTHA": "road river sea",
             "GASOLINE": "road river sea", "JET": "road river sea", "DIESEL": "road river sea",
             "FUEL_OIL": "road river sea", "SOLVENT": "road river sea", "BENZENE": "road river sea",
             "PROPYLENE": "road sea", "CHLORINE": "road", "CAUSTIC": "road river sea",
             "STYRENE": "road river sea", "PE": "road river sea", "PP": "road river sea",
             "PVC": "road river sea", "PS": "road river sea"}

# Layout site id -> engine key, and berths (road, river, sea bays). A berth count
# of 0 keeps the site off that network even where a lane passes it: this is what
# sends salt, caustic and naphtha by barge and fuels, fuel oil and LPG by ship.
# The fuel depot and Port terminal B take cargo by water only, so a short supply
# can never turn into hundreds of truck orders for a ship-sized lane.
#
# Tank sizes follow one rule besides cover days: a by-product with a single
# outlet (benzene, propylene, naphtha, solvent, cracker LPG and pygas) gets a
# large tank, so an outage at that outlet does not shut the unit that makes it.
# Small tanks there tie the refinery, the flex cracker and styrenics into a loop
# that cannot restart once all three are down.
SITES = {
    1: ("OIL_FIELD", (1, 0, 0)), 2: ("OIL_FIELD_B", (1, 0, 0)), 3: ("GAS_FIELD", (1, 0, 0)),
    4: ("SALT_MINE", (2, 1, 0)), 5: ("GAS_PLANT", (3, 1, 1)), 6: ("REFINERY", (4, 2, 2)),
    7: ("CRACKER_ETHANE", (3, 1, 0)), 8: ("CRACKER_FLEX", (4, 2, 0)),
    9: ("CHLOR_ALKALI", (4, 2, 0)), 10: ("POLYETHYLENE", (4, 0, 0)),
    11: ("POLYPROPYLENE", (3, 0, 0)), 12: ("VINYLS", (4, 0, 0)), 13: ("STYRENICS", (3, 0, 0)),
    14: ("FUEL_DEPOT", (0, 1, 2)), 15: ("GAS_GRID", (1, 0, 0)), 16: ("PACKAGING", (4, 0, 0)),
    17: ("CONSTRUCTION", (3, 0, 0)), 18: ("CONSUMER_GOODS", (3, 0, 0)), 19: ("PAINTS", (2, 0, 0)),
    20: ("PROCESS_INDUSTRIES", (2, 1, 0)), 21: ("PORT_TERMINAL", (2, 0, 0)),
    22: ("PORT_TERMINAL_B", (0, 0, 2)),
}


def balance():
    """Close every rate forward from the sources. Returns a dict of t/h figures."""
    a, b, c = FLEX_TRAINS
    tot = a + b + c
    e, l, n = (FLEX_DESIGN * a / tot, FLEX_DESIGN * b / tot, FLEX_DESIGN * c / tot)
    G = RAW_GAS
    ethane = Y["NGL"]["ETHANE"] * G
    E1 = ethane - e                                   # ethane cracker takes the rest
    crude = (n - Y["NGL"]["NAPHTHA"] * G) / Y["CDU"]["NAPHTHA"]   # naphtha closes the refinery
    assert E1 > 0 and crude > 0
    hn, gasoil, vgo = (Y["CDU"][k] * crude for k in ("HEAVY_NAPHTHA", "GASOIL", "VGO"))

    def flex(mat):
        return Y["ETH"].get(mat, 0) * e + Y["LPGM"].get(mat, 0) * l + Y["NAP"].get(mat, 0) * n

    benzene = Y["REF"]["BENZENE"] * hn + Y["ETH"]["BENZENE"] * E1 + flex("BENZENE")
    styrene = benzene / 0.78
    flex_ethylene = flex("ETHYLENE")
    vcm = (flex_ethylene - 0.285 * styrene) / 0.465
    pvc = vcm / 1.02
    chlorine = 0.585 * vcm
    pe = Y["ETH"]["ETHYLENE"] * E1 / 1.015
    propylene = Y["FCC"]["PROPYLENE"] * vgo + Y["ETH"]["PROPYLENE"] * E1 + flex("PROPYLENE")
    pp = propylene / 1.02
    sty_paints = STYRENE_TO_PAINTS * styrene
    ps = (styrene - sty_paints) / 1.01
    r = dict(G=G, e=e, l=l, n=n, E1=E1, crude=crude, hn=hn, gasoil=gasoil, vgo=vgo,
             benzene=benzene, styrene=styrene, vcm=vcm, pvc=pvc, chlorine=chlorine, pe=pe,
             propylene=propylene, pp=pp, ps=ps, sty_paints=sty_paints,
             salt=1.648 * chlorine, caustic=1.128 * chlorine, methane=Y["NGL"]["METHANE"] * G)
    # Refinery products
    ref = {"LPG": Y["CDU"]["LPG"] * crude + Y["REF"]["LPG"] * hn + Y["FCC"]["LPG"] * vgo,
           "NAPHTHA": Y["CDU"]["NAPHTHA"] * crude, "JET": Y["CDU"]["JET"] * crude,
           "GASOLINE": Y["REF"]["GASOLINE"] * hn + Y["FCC"]["GASOLINE"] * vgo,
           "DIESEL": Y["FCC"]["DIESEL"] * vgo + Y["HDT"]["DIESEL"] * gasoil,
           "FUEL_OIL": Y["CDU"]["FUEL_OIL"] * crude + Y["FCC"]["FUEL_OIL"] * vgo,
           "SOLVENT": Y["REF"]["SOLVENT"] * hn, "BENZENE": Y["REF"]["BENZENE"] * hn,
           "PROPYLENE": Y["FCC"]["PROPYLENE"] * vgo}
    eth = {k: v * E1 for k, v in Y["ETH"].items()}
    flx = {k: flex(k) for k in ("ETHYLENE", "PROPYLENE", "BENZENE", "GASOLINE", "FUEL_OIL")}
    flx_lpg_in = Y["ETH"]["LPG"] * e + Y["NAP"]["LPG"] * n
    flx_lpg_out = 0.95 * l
    r.update(ref=ref, eth=eth, flx=flx, flx_lpg_in=flx_lpg_in, flx_lpg_out=flx_lpg_out,
             gp_lpg=Y["NGL"]["LPG"] * G, gp_naphtha=Y["NGL"]["NAPHTHA"] * G)
    r["gasoline"] = ref["GASOLINE"] + eth["GASOLINE"] + flx["GASOLINE"]
    r["fuel_oil"] = ref["FUEL_OIL"] + eth["FUEL_OIL"] + flx["FUEL_OIL"]
    r["lpg_to_depot"] = r["gp_lpg"] + ref["LPG"] + eth["LPG"] - (flx_lpg_out - flx_lpg_in)
    r["solvent"] = ref["SOLVENT"] + 0.02 * styrene
    return r


# ----------------------------------------------------------------------------
# Route graph, mirroring the loader's rules, to measure lane distances
# ----------------------------------------------------------------------------
def build_graph(layout, mode, site_xy):
    """site_xy: {key: (x, y)} for sites with a berth in this mode. Returns
    (dist[key][key] in km, attached set)."""
    pts, ends, edges = [], set(), []
    for strip in layout["network"]:
        if strip["mode"] != mode:
            continue
        base = len(pts)
        for p in strip["points"]:
            pts.append((float(p[0]), float(p[1])))
        ends.add(base)
        ends.add(len(pts) - 1)
        for i in range(base, len(pts) - 1):
            edges.append((i, i + 1))
    parent = list(range(len(pts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            if (i in ends or j in ends) and math.dist(pts[i], pts[j]) <= MERGE_KM:
                parent[find(i)] = find(j)
    adj = {}

    def link(u, v, w):
        if u == v:
            return
        adj.setdefault(u, []).append((v, w))
        adj.setdefault(v, []).append((u, w))

    for i, j in edges:
        link(find(i), find(j), math.dist(pts[i], pts[j]))
    attached = set()
    for key, xy in site_xy.items():
        near = [(math.dist(xy, p), i) for i, p in enumerate(pts) if math.dist(xy, p) <= ATTACH_KM]
        if not near:
            continue
        attached.add(key)
        nearest = min(near)[1]
        for d, i in near:
            if i == nearest or i in ends:
                link(("site", key), find(i), max(d, 0.1))
    dist = {}
    for key in attached:
        src = ("site", key)
        best = {src: 0.0}
        heap = [(0.0, 0, src)]
        tie = 1
        while heap:
            d, _, u = heapq.heappop(heap)
            if d > best.get(u, 1e18):
                continue
            for v, w in adj.get(u, []):
                if d + w < best.get(v, 1e18):
                    best[v] = d + w
                    heapq.heappush(heap, (d + w, tie, v))
                    tie += 1
        dist[key] = {k: best[("site", k)] for k in attached if ("site", k) in best}
    return dist, attached


def main():
    layout = json.loads(LAYOUT.read_text())
    r = balance()
    k = SINK_SHARE
    by_id = {s["id"]: s for s in layout["sites"]}
    key_of = {i: SITES[i][0] for i in by_id}
    xy = {key_of[i]: (float(s["x"]), float(s["y"])) for i, s in by_id.items()}

    # ---------------- processes and tanks per site ----------------
    def T(m, role, cover, init=None, lead=None, reject=False):
        t = {"material": m, "role": role, "cover_days": cover, "target_frac": 0.7}
        if init is not None:
            t["init_frac"] = init
        if lead is not None:
            t["lead_time_h"] = lead  # water-fed tanks: a barge or ship takes days, not hours
        if reject:
            t["reject_when_full"] = True  # overflow is discarded instead of blocking the plant
        if role == "product" and PRODUCT_GAP_H:
            t["pickup_gap_h"] = PRODUCT_GAP_H
        return t

    BOUNDARY = ("OIL_PRODUCTION", "GAS_PRODUCTION", "SALT_MINING")

    def P(t, rate, trains=None):
        is_sink = t.startswith(("FUEL_DEPOT_", "GAS_GRID_", "PACKAGING_", "CONSTRUCTION_",
                                "CONSUMER_GOODS_", "PAINTS_", "PROCESS_INDUSTRIES_", "PORT_BUNKER_"))
        scale = 1.0 if is_sink else PLANT_SPARE
        return {"type": t, "design_t_h": round(rate * scale, 3), "trains": trains or [1]}
    half_crude = 0.5 * r["crude"] * SOURCE_MARGIN
    spec = {
        "OIL_FIELD": ([P("OIL_PRODUCTION", half_crude)], [T("CRUDE", "product", 5, 0.5)]),
        "OIL_FIELD_B": ([P("OIL_PRODUCTION", half_crude)], [T("CRUDE", "product", 5, 0.5)]),
        "GAS_FIELD": ([P("GAS_PRODUCTION", r["G"] * SOURCE_MARGIN)], [T("RAW_GAS", "product", 2, 0.5)]),
        "SALT_MINE": ([P("SALT_MINING", r["salt"] * SOURCE_MARGIN)], [T("SALT", "product", 10, 0.6)]),
        "GAS_PLANT": ([P("NGL_RECOVERY", r["G"])],
                      [T("RAW_GAS", "feed", 2), T("METHANE", "product", 3, 0.5),
                       # A gas plant that cannot place its ethane leaves it in the sales gas
                       # rather than shutting down, so the city grid keeps its methane.
                       T("ETHANE", "product", 20, 0.3, reject=True), T("LPG", "product", 20, 0.4),
                       T("NAPHTHA", "product", 60, 0.3)]),
        "REFINERY": ([P("CRUDE_DISTILLATION", r["crude"]), P("REFORMING", r["hn"]),
                      P("FCC", r["vgo"]), P("DIESEL_HDT", r["gasoil"])],
                     [T("CRUDE", "feed", 5), T("HEAVY_NAPHTHA", "both", 5), T("GASOIL", "both", 5),
                      T("VGO", "both", 5), T("LPG", "product", 30, 0.4), T("NAPHTHA", "product", 45, 0.3),
                      T("JET", "product", 16, 0.4), T("GASOLINE", "product", 16, 0.4),
                      T("DIESEL", "product", 16, 0.4), T("FUEL_OIL", "product", 16, 0.4),
                      T("SOLVENT", "product", 60, 0.3), T("BENZENE", "product", 120, 0.3),
                      T("PROPYLENE", "product", 60, 0.3)]),
        "CRACKER_ETHANE": ([P("OLEFINS_GAS", r["E1"])],
                           [T("ETHANE", "feed", 5), T("ETHYLENE", "product", 7, 0.5),
                            T("PROPYLENE", "product", 60, 0.3), T("LPG", "product", 60, 0.3),
                            # pygas is a trickle here: a big tank and a rare barge call
                            T("BENZENE", "product", 200, 0.3), T("GASOLINE", "product", 400, 0.45),
                            T("FUEL_OIL", "product", 120, 0.3)]),
        "CRACKER_FLEX": ([P("OLEFINS_FLEX", FLEX_DESIGN, FLEX_TRAINS)],
                         [T("ETHANE", "feed", 5), T("LPG", "both", 10, 0.5, lead=TRUCK_LEAD), T("NAPHTHA", "feed", 12, 0.6, lead=64),
                          T("ETHYLENE", "product", 7, 0.5), T("PROPYLENE", "product", 45, 0.3),
                          T("BENZENE", "product", 120, 0.3), T("GASOLINE", "product", 60, 0.4),
                          T("FUEL_OIL", "product", 90, 0.3)]),
        "CHLOR_ALKALI": ([P("ELECTROLYSIS", r["chlorine"])],
                         [T("SALT", "feed", 10, 0.5, lead=56), T("CHLORINE", "product", 3, 0.4),
                          T("CAUSTIC", "product", 20, 0.4)]),
        "POLYETHYLENE": ([P("PE_POLYMERISATION", r["pe"])],
                         [T("ETHYLENE", "feed", 4), T("PE", "product", 7, 0.5)]),
        "POLYPROPYLENE": ([P("PP_POLYMERISATION", r["pp"])],
                          [T("PROPYLENE", "feed", 7, 0.5, lead=TRUCK_LEAD), T("PP", "product", 7, 0.5)]),
        "VINYLS": ([P("VCM", r["vcm"]), P("PVC", r["pvc"])],
                   [T("ETHYLENE", "feed", 4), T("CHLORINE", "feed", 5, 0.5, lead=TRUCK_LEAD), T("VCM", "both", 5),
                    T("PVC", "product", 7, 0.5)]),
        "STYRENICS": ([P("STYRENE", r["styrene"]), P("PS", r["ps"])],
                      [T("BENZENE", "feed", 10, 0.5, lead=TRUCK_LEAD), T("ETHYLENE", "feed", 4), T("STYRENE", "both", 7),
                       T("SOLVENT", "product", 120, 0.3), T("PS", "product", 7, 0.5)]),
        "FUEL_DEPOT": ([P("FUEL_DEPOT_GASOLINE", k * r["gasoline"]), P("FUEL_DEPOT_DIESEL", k * r["ref"]["DIESEL"]),
                        P("FUEL_DEPOT_JET", k * r["ref"]["JET"]), P("FUEL_DEPOT_LPG", k * r["lpg_to_depot"])],
                       [T("GASOLINE", "feed", 10, 0.42, lead=48), T("DIESEL", "feed", 10, 0.47, lead=48),
                        T("JET", "feed", 10, 0.52, lead=48), T("LPG", "feed", 10, 0.40, lead=48)]),
        "GAS_GRID": ([P("GAS_GRID_METHANE", k * r["methane"])], [T("METHANE", "feed", 2)]),
        "PACKAGING": ([P("PACKAGING_PE", k * r["pe"]), P("PACKAGING_PP", k * r["pp"] * PP_TO_PACKAGING)],
                      [T("PE", "feed", 7, 0.45, lead=TRUCK_LEAD), T("PP", "feed", 7, 0.50, lead=TRUCK_LEAD)]),
        "CONSTRUCTION": ([P("CONSTRUCTION_PVC", k * r["pvc"])], [T("PVC", "feed", 7, 0.48, lead=TRUCK_LEAD)]),
        "CONSUMER_GOODS": ([P("CONSUMER_GOODS_PS", k * r["ps"]),
                            P("CONSUMER_GOODS_PP", k * r["pp"] * (1 - PP_TO_PACKAGING))],
                           [T("PS", "feed", 7, 0.46, lead=TRUCK_LEAD), T("PP", "feed", 7, 0.52, lead=TRUCK_LEAD)]),
        "PAINTS": ([P("PAINTS_SOLVENT", k * r["solvent"]), P("PAINTS_STYRENE", k * r["sty_paints"])],
                   [T("SOLVENT", "feed", 10, 0.45, lead=TRUCK_LEAD), T("STYRENE", "feed", 10, 0.40, lead=TRUCK_LEAD)]),
        "PROCESS_INDUSTRIES": ([P("PROCESS_INDUSTRIES_CAUSTIC", k * r["caustic"])],
                               [T("CAUSTIC", "feed", 12, 0.5, lead=56)]),
        "PORT_TERMINAL": ([P("PORT_BUNKER_FUEL_OIL", NORTH_PORT_BUNKER)], [T("FUEL_OIL", "feed", 7, 0.45, lead=TRUCK_LEAD)]),
        "PORT_TERMINAL_B": ([P("PORT_BUNKER_FUEL_OIL", k * r["fuel_oil"] - NORTH_PORT_BUNKER)],
                            [T("FUEL_OIL", "feed", 12, 0.50, lead=60)]),
    }

    # ---------------- route graphs ----------------
    modes = ("road", "river", "sea")
    dist, attached = {}, {}
    for mi, mode in enumerate(modes):
        want = {SITES[i][0]: xy[SITES[i][0]] for i in SITES if SITES[i][1][mi] > 0}
        dist[mode], attached[mode] = build_graph(layout, mode, want)
        missing = sorted(set(want) - attached[mode])
        if missing:
            sys.exit(f"{mode}: sites with a berth but no lane within {ATTACH_KM} km: {missing}")

    # ---------------- lanes: who sells what to whom ----------------
    sellers = {  # material -> {site: t/h on offer}
        "SALT": {"SALT_MINE": r["salt"]},
        "LPG": {"GAS_PLANT": r["gp_lpg"], "REFINERY": r["ref"]["LPG"], "CRACKER_ETHANE": r["eth"]["LPG"]},
        "NAPHTHA": {"GAS_PLANT": r["gp_naphtha"], "REFINERY": r["ref"]["NAPHTHA"]},
        "GASOLINE": {"REFINERY": r["ref"]["GASOLINE"], "CRACKER_ETHANE": r["eth"]["GASOLINE"],
                     "CRACKER_FLEX": r["flx"]["GASOLINE"]},
        "JET": {"REFINERY": r["ref"]["JET"]}, "DIESEL": {"REFINERY": r["ref"]["DIESEL"]},
        "FUEL_OIL": {"REFINERY": r["ref"]["FUEL_OIL"], "CRACKER_ETHANE": r["eth"]["FUEL_OIL"],
                     "CRACKER_FLEX": r["flx"]["FUEL_OIL"]},
        "SOLVENT": {"REFINERY": r["ref"]["SOLVENT"], "STYRENICS": 0.02 * r["styrene"]},
        "BENZENE": {"REFINERY": r["ref"]["BENZENE"], "CRACKER_ETHANE": r["eth"]["BENZENE"],
                    "CRACKER_FLEX": r["flx"]["BENZENE"]},
        "PROPYLENE": {"REFINERY": r["ref"]["PROPYLENE"], "CRACKER_ETHANE": r["eth"]["PROPYLENE"],
                      "CRACKER_FLEX": r["flx"]["PROPYLENE"]},
        "CHLORINE": {"CHLOR_ALKALI": r["chlorine"]}, "CAUSTIC": {"CHLOR_ALKALI": r["caustic"]},
        "STYRENE": {"STYRENICS": r["sty_paints"]},
        "PE": {"POLYETHYLENE": r["pe"]}, "PP": {"POLYPROPYLENE": r["pp"]},
        "PVC": {"VINYLS": r["pvc"]}, "PS": {"STYRENICS": r["ps"]},
    }
    buyers = {  # material -> {site: (t/h drawn, cover_days of the buying tank)}
        "SALT": {"CHLOR_ALKALI": r["salt"]},
        "LPG": {"FUEL_DEPOT": r["lpg_to_depot"], "CRACKER_FLEX": r["flx_lpg_out"] - r["flx_lpg_in"]},
        "NAPHTHA": {"CRACKER_FLEX": r["n"]},
        "GASOLINE": {"FUEL_DEPOT": r["gasoline"]}, "JET": {"FUEL_DEPOT": r["ref"]["JET"]},
        "DIESEL": {"FUEL_DEPOT": r["ref"]["DIESEL"]},
        "FUEL_OIL": {"PORT_TERMINAL": NORTH_PORT_BUNKER, "PORT_TERMINAL_B": r["fuel_oil"] - NORTH_PORT_BUNKER},
        "SOLVENT": {"PAINTS": r["solvent"]}, "BENZENE": {"STYRENICS": r["benzene"]},
        "PROPYLENE": {"POLYPROPYLENE": r["propylene"]}, "CHLORINE": {"VINYLS": r["chlorine"]},
        "CAUSTIC": {"PROCESS_INDUSTRIES": r["caustic"]}, "STYRENE": {"PAINTS": r["sty_paints"]},
        "PE": {"PACKAGING": r["pe"]},
        "PP": {"PACKAGING": r["pp"] * PP_TO_PACKAGING, "CONSUMER_GOODS": r["pp"] * (1 - PP_TO_PACKAGING)},
        "PVC": {"CONSTRUCTION": r["pvc"]}, "PS": {"CONSUMER_GOODS": r["ps"]},
    }
    cover = {(site, t["material"]): t["cover_days"] for site, (_, tanks) in spec.items() for t in tanks}
    draw_tank = {(b_, m_): v for m_, bs_ in buyers.items() for b_, v in bs_.items()}
    draw_tank[("CRACKER_FLEX", "LPG")] = r["flx_lpg_out"]
    FREIGHT = {"TRUCK_TANK": 0.10, "TRUCK_PRESS": 0.14, "TRUCK_BULK": 0.10, "BARGE_TANK": 0.025,
               "BARGE_DRY": 0.025, "SHIP_TANK": 0.004, "SHIP_GAS": 0.008, "SHIP_DRY": 0.005}
    need = {c: 0.0 for c in VEH}            # vehicles needed per class
    need_home = {}                          # (class, seller) -> vehicles
    lanes = []
    def best_class(mat, seller, buyer, offer):
        best = None
        for cls, (cap, speed, load, mode, phase) in VEH.items():
            if phase != PHASE[mat] or mode not in MAT_MODES[mat].split():
                continue
            if cls == "SHIP_DRY":
                continue  # no dry-bulk ships in this fleet
            km = dist[mode].get(seller, {}).get(buyer)
            if km is None:
                continue
            # one order: the buyer waits until it wants min(0.8 load, 0.4 of its target stock)
            target_t = 0.7 * cover[(buyer, mat)] * 24 * draw_tank[(buyer, mat)]
            lot = min(MARKET["min_lot_cap_frac"] * cap, MARKET["min_lot_target_frac"] * target_t)
            if lot > offer * 24 * cover[(seller, mat)] * 0.9:
                continue  # the seller can never hold a full lot for this class
            cost = FREIGHT[cls] * km
            if best is None or cost < best[0]:
                best = (cost, cls, km, lot)
        return best

    sold = {}
    for mat, bs in buyers.items():
        for buyer, draw in bs.items():
            options = {s_: best_class(mat, s_, buyer, o) for s_, o in sellers[mat].items()}
            options = {s_: v for s_, v in options.items() if v}
            if not options:
                sys.exit(f"nobody can deliver {mat} to {buyer}")
            supply = sum(sellers[mat][s_] for s_ in options)
            for seller, (_, cls, km, lot) in options.items():
                flow = draw * sellers[mat][seller] / supply
                if flow <= 1e-6:
                    continue
                sold[(mat, seller)] = True
                cap, speed, load, mode, _ = VEH[cls]
                trip_h = 2 * km / min(speed, SPEED[mode]) + 2 * lot / load + 1.0
                # trucks leave nearly full (the hourly gap tops a 20 t minimum up to 25);
                # barges and ships leave at about the minimum lot
                carried = 0.92 * cap if mode == "road" else lot
                n = flow * trip_h / carried
                need[cls] += n
                need_home[(cls, seller)] = need_home.get((cls, seller), 0.0) + n
                lanes.append((mat, seller, buyer, flow, cls, km, lot, trip_h, n))
    for mat, ss in sellers.items():
        for seller in ss:
            if (mat, seller) not in sold:
                sys.exit(f"{seller} has no customer it can reach for {mat}")

    fleet = []
    for cls in VEH:
        if need[cls] <= 0:
            continue
        floor = {"SHIP_TANK": 3, "SHIP_GAS": 2, "BARGE_TANK": 3, "BARGE_DRY": 2}.get(cls, 2)
        total = max(floor, math.ceil(need[cls] * FLEET_SPARE))
        homes = sorted(((v, s) for (c, s), v in need_home.items() if c == cls), reverse=True)
        share = [max(1, round(total * v / need[cls])) for v, _ in homes]
        while sum(share) > total and max(share) > 1:
            share[share.index(max(share))] -= 1
        while sum(share) < total:
            share[share.index(max(share))] += 1
        for (v, s), cnt in zip(homes, share):
            fleet.append({"class": cls, "home": s, "count": cnt})

    # ---------------- pipelines ----------------
    pipe_cap = {
        ("OIL_FIELD", "REFINERY"): 0.65 * r["crude"], ("OIL_FIELD_B", "REFINERY"): 0.65 * r["crude"],
        ("GAS_FIELD", "GAS_PLANT"): 1.15 * r["G"], ("GAS_PLANT", "GAS_GRID"): 1.2 * r["methane"],
        ("GAS_PLANT", "CRACKER_ETHANE"): 1.3 * r["E1"], ("GAS_PLANT", "CRACKER_FLEX"): 1.5 * r["e"],
        ("CRACKER_ETHANE", "POLYETHYLENE"): 1.3 * 1.015 * r["pe"],
        ("CRACKER_FLEX", "VINYLS"): 1.3 * 0.465 * r["vcm"],
        ("CRACKER_FLEX", "STYRENICS"): 1.5 * 0.285 * r["styrene"],
    }
    pipelines = []
    for c in layout["connections"]:
        a, b = key_of[c["from"]], key_of[c["to"]]
        pipelines.append({"material": c["material"], "from": a, "to": b,
                          "cap_t_h": round(pipe_cap[(a, b)], 2), "points": c["points"]})
    assert len(pipelines) == len(pipe_cap)

    sites = []
    for i in sorted(by_id):
        s = by_id[i]
        key, bays = SITES[i]
        procs, tanks = spec[key]
        sites.append({"key": key, "name": s["name"], "preset": s["preset"], "x": s["x"], "y": s["y"],
                      "bays": {"road": bays[0], "river": bays[1], "sea": bays[2]},
                      "processes": procs, "tanks": tanks})

    network = [s for s in layout["network"] if s["mode"] in ("road", "river", "sea")]
    world = {"format": 1, "name": "erwin-world-v1", "wKm": layout["wKm"], "hKm": layout["hKm"],
             "cellKm": layout["cellKm"], "water": layout["water"], "sites": sites,
             "pipelines": pipelines, "network": network, "fleet": fleet,
             "contracts": [], "stranded_materials": [], "market": MARKET,
             "warm_start": True, "smooth_km": SMOOTH_KM}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(world, separators=(",", ":")) + "\n")

    # ---------------- report ----------------
    p = lambda *a: print(*a)
    p(f"raw gas {r['G']:.0f}  crude {r['crude']:.1f}  ethane cracker {r['E1']:.1f}  flex {FLEX_DESIGN:.0f} "
      f"(e {r['e']:.1f} / l {r['l']:.1f} / n {r['n']:.1f})")
    p(f"PE {r['pe']:.1f}  PP {r['pp']:.1f}  PVC {r['pvc']:.1f}  PS {r['ps']:.1f}  styrene {r['styrene']:.1f}  "
      f"chlorine {r['chlorine']:.1f}  salt {r['salt']:.1f}  caustic {r['caustic']:.1f}")
    p(f"gasoline {r['gasoline']:.1f}  diesel {r['ref']['DIESEL']:.1f}  jet {r['ref']['JET']:.1f}  "
      f"fuel oil {r['fuel_oil']:.1f}  LPG to depot {r['lpg_to_depot']:.1f}  methane {r['methane']:.0f}  "
      f"benzene {r['benzene']:.2f}  propylene {r['propylene']:.2f}  solvent {r['solvent']:.2f}")
    p("\nlane                                              t/h   class        km    lot   trip h  vehicles")
    for mat, seller, buyer, flow, cls, km, lot, trip_h, n in sorted(lanes, key=lambda x: (x[4], -x[3])):
        p(f"{mat:10s} {seller:15s} -> {buyer:18s} {flow:6.2f}  {cls:11s} {km:5.0f} {lot:6.0f}  {trip_h:6.1f}  {n:5.2f}")
    p("\nfleet:", {c: (round(need[c], 1), sum(f['count'] for f in fleet if f['class'] == c)) for c in VEH if need[c] > 0})
    p("total vehicles:", sum(f["count"] for f in fleet))
    for mode in modes:
        p(f"{mode}: {len(attached[mode])} sites attached")
    p(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    main()
