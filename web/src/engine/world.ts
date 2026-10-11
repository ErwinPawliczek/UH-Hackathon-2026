// Static world data the client renders against. Outline §7.3: "the static
// world JSON maps every index to its name, geometry and catalog entry" —
// WorldSpec is that shape as the TypeScript client expects it. The HTTP
// backend parses it from GET /api/sim/{id}/world (§7.4); the stub builds one
// deterministic world per seed. Array positions match snapshot indices:
// sites[i], tanks[i], vehicles[i], pipelines[i].

export type GlyphKind =
  | 'column'
  | 'furnace'
  | 'reactor'
  | 'compressor_house'
  | 'extruder_hall'
  | 'tank'
  | 'flare'
  | 'jetty'
  | 'pipe_rack'
  | 'truck_rack'
  | 'silo'
  | 'cell_room'
  | 'exchanger_bank';

export type RouteMode = 'road' | 'river' | 'sea';

export interface TerrainGrid {
  cols: number;
  rows: number;
  /** km between grid samples */
  cellKm: number;
  /** row-major heights in metres, rows × cols, sampled at (col*cellKm, row*cellKm) */
  height: Float32Array;
  seaLevelM: number;
}

export interface RouteSpec {
  mode: RouteMode;
  /** display names of the two ends (e.g. site names, or "Overseas" off-map) */
  ends: [string, string];
  /** site indices at each end, null for off-map ends and network junctions */
  sites: [number | null, number | null];
  /**
   * True where the end is a junction of the drawn network rather than a site
   * (hand-drawn map worlds: a route is one stretch of road, river or sea lane
   * between two junctions). Absent on worlds whose routes all join sites.
   */
  junction?: [boolean, boolean];
  /** km points in map coordinates (0..w, 0..h) */
  points: [number, number][];
}

/**
 * One stream into or out of a unit or a process, at design rate. A
 * "material" stream moves between the unit and a tank (`tank` is the index
 * into WorldSpec.tanks); an "internal" stream joins one unit's out to
 * another unit's in by key, inside one process; a "utility" stream (water,
 * fuel gas, losses) has no tank and is shown as a note, not a line.
 */
export interface StreamSpec {
  key: string;
  /** the stream in plain words, when the engine gives one ("ethylene dichloride" for `edc`) */
  name?: string;
  /** tonnes per hour at design rate */
  tph: number;
  kind: 'material' | 'internal' | 'utility';
  tank: number | null;
}

export interface UnitSpec {
  key: string;
  name: string;
  glyph: GlyphKind;
  trains: number;
  // Flowsheet data (engine worlds; absent on the stub world):
  /** global unit index — the unit's slot in snapshot array 3 (trains online) */
  index?: number;
  /** throughput one train can take, in t/h of everything the unit takes in */
  capPerTrainTph?: number;
  in?: StreamSpec[];
  out?: StreamSpec[];
  /** heat duty and electrical load at design rate */
  heatGjH?: number;
  powerMw?: number;
}

export interface ProcessSpec {
  key: string;
  name: string;
  designRateTph: number;
  units: UnitSpec[];
  // Flowsheet data (engine worlds; absent on the stub world):
  /** global process index — the process's slot in snapshot arrays 1 and 2 */
  index?: number;
  /** the stream the design rate is quoted in */
  basis?: string;
  /** "source" makes material from nothing, "sink" consumes it; "none" is a plant process */
  boundary?: 'source' | 'sink' | 'none';
  modes?: string[];
  modeShare?: number[];
  turndown?: number;
  restartH?: number;
  /** net streams of the whole process at design rate */
  in?: StreamSpec[];
  out?: StreamSpec[];
}

export type TankRole = 'feed' | 'product' | 'internal' | 'both';

export interface TankSpec {
  site: number;
  material: string;
  role: TankRole;
  capacityT: number;
  /** design draw by the processes that consume from it (t/h); 0 = none — days of cover is "—" */
  drawTph: number;
}

export type VehicleClassKey =
  | 'TRUCK_TANK'
  | 'TRUCK_PRESS'
  | 'TRUCK_BULK'
  | 'BARGE_TANK'
  | 'BARGE_DRY'
  | 'SHIP_TANK'
  | 'SHIP_GAS'
  | 'SHIP_DRY';

/** §3.4 vehicle classes; sceneLength is the 3D glyph size in scene units (km), sized for visibility. */
export const VEHICLE_CLASSES: Record<
  VehicleClassKey,
  { label: string; capacityT: number; speedKmh: number; /** t/h a bay loads or unloads it at (catalog load_t_h) */ loadTph: number; sceneLength: number; sceneWidth: number }
> = {
  TRUCK_TANK: { label: 'Truck (tank)', capacityT: 25, speedKmh: 70, loadTph: 50, sceneLength: 5, sceneWidth: 2.2 },
  TRUCK_PRESS: { label: 'Truck (pressurised)', capacityT: 20, speedKmh: 70, loadTph: 40, sceneLength: 5, sceneWidth: 2.2 },
  TRUCK_BULK: { label: 'Truck (bulk)', capacityT: 25, speedKmh: 70, loadTph: 50, sceneLength: 5, sceneWidth: 2.2 },
  BARGE_TANK: { label: 'Barge (tank)', capacityT: 2000, speedKmh: 12, loadTph: 400, sceneLength: 11, sceneWidth: 3.5 },
  BARGE_DRY: { label: 'Barge (dry)', capacityT: 1500, speedKmh: 12, loadTph: 300, sceneLength: 10, sceneWidth: 3.5 },
  SHIP_TANK: { label: 'Ship (tanker)', capacityT: 40000, speedKmh: 26, loadTph: 2500, sceneLength: 20, sceneWidth: 5 },
  SHIP_GAS: { label: 'Ship (gas)', capacityT: 12000, speedKmh: 30, loadTph: 800, sceneLength: 18, sceneWidth: 5 },
  SHIP_DRY: { label: 'Ship (bulk)', capacityT: 20000, speedKmh: 24, loadTph: 1000, sceneLength: 18, sceneWidth: 5 },
};

export interface VehicleSpec {
  cls: VehicleClassKey;
  /** representative cargo material key; the cargo on board is snapshot state */
  cargo: string;
  /** site index the vehicle is based at (engine worlds) */
  home?: number;
  /** index into routes[] the vehicle shuttles along. Stub-producer-only: the
   * engine's world JSON carries no schedule — live movement (route, progress,
   * ETA) comes from snapshot arrays 12-14. The stub still needs these to
   * animate its placeholder loop. */
  route?: number;
  /** ticks for one leg (one-way traversal) — stub-producer-only, see route */
  loopTicks?: number;
  /** 0..1 offset into the loop — stub-producer-only, see route */
  phase?: number;
}

export interface PipelineSpec {
  fromSite: number;
  toSite: number;
  material: string;
  capTph: number;
  points: [number, number][];
}

export interface SiteSpec {
  /** engine site key (e.g. CRACKER_ETHANE) — what commands address a site by; absent on the stub world */
  key?: string;
  name: string;
  preset: string;
  x: number;
  y: number;
  processes: ProcessSpec[];
}

export interface WorldSpec {
  /** world name as the engine reports it ('sixsite', a named map world, …) */
  world?: string;
  /**
   * Engine material keys in snapshot index order (the catalog's list, which
   * also carries site-internal streams). Absent on the stub world, whose
   * snapshot indexes MATERIALS.
   */
  materials?: string[];
  seed: number;
  wKm: number;
  hKm: number;
  terrain: TerrainGrid;
  sites: SiteSpec[];
  tanks: TankSpec[];
  routes: RouteSpec[];
  pipelines: PipelineSpec[];
  vehicles: VehicleSpec[];
}

export const TICKS_PER_DAY = 96;

/** The 22 traded materials of §3.1, in snapshot index order. */
export const MATERIALS: readonly string[] = [
  'CRUDE', 'RAW_GAS', 'SALT', 'METHANE', 'ETHANE', 'LPG', 'NAPHTHA', 'GASOLINE',
  'JET', 'DIESEL', 'FUEL_OIL', 'SOLVENT', 'BENZENE', 'ETHYLENE', 'PROPYLENE',
  'CHLORINE', 'CAUSTIC', 'STYRENE', 'PE', 'PP', 'PVC', 'PS',
];

const MATERIAL_COLORS: Record<string, number> = {
  CRUDE: 0x33302b, RAW_GAS: 0xfcd34d, SALT: 0xf1f5f9, METHANE: 0xf59e0b,
  ETHANE: 0xfbbf24, LPG: 0xd97706, NAPHTHA: 0xeab308, GASOLINE: 0x84cc16,
  JET: 0xa3e635, DIESEL: 0x22c55e, FUEL_OIL: 0x57534e, SOLVENT: 0x14b8a6,
  BENZENE: 0x06b6d4, ETHYLENE: 0xf472b6, PROPYLENE: 0xfb7185, CHLORINE: 0xfacc15,
  CAUSTIC: 0x60a5fa, STYRENE: 0xa78bfa, PE: 0xe2e8f0, PP: 0xc4b5fd,
  PVC: 0xfda4af, PS: 0x93c5fd,
};

/** Material key for a snapshot material index in this world, or null when out of range. */
export function materialKeyAt(world: WorldSpec, index: number): string | null {
  const list = world.materials ?? MATERIALS;
  return index >= 0 && index < list.length ? list[index] : null;
}

export function materialColor(key: string): number {
  return MATERIAL_COLORS[key] ?? 0x94a3b8;
}

/** Total km arc length of a polyline. */
export function routeLength(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/** Position and unit direction at arc length `dist` along a polyline, clamped to its ends. */
export function routePointAt(
  points: [number, number][],
  dist: number,
): { x: number; y: number; dirX: number; dirY: number } {
  let remaining = Math.max(0, Math.min(dist, routeLength(points)));
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (remaining <= len || i === points.length - 1) {
      const t = len === 0 ? 0 : remaining / len;
      return {
        x: ax + (bx - ax) * t,
        y: ay + (by - ay) * t,
        dirX: len === 0 ? 1 : (bx - ax) / len,
        dirY: len === 0 ? 0 : (by - ay) / len,
      };
    }
    remaining -= len;
  }
  const [x, y] = points[points.length - 1];
  return { x, y, dirX: 1, dirY: 0 };
}

/** Bilinear terrain height in metres at map coordinates; outside the grid clamps to the edge. */
export function sampleHeight(grid: TerrainGrid, xKm: number, yKm: number): number {
  const fx = Math.max(0, Math.min(grid.cols - 1, xKm / grid.cellKm));
  const fy = Math.max(0, Math.min(grid.rows - 1, yKm / grid.cellKm));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(grid.cols - 1, x0 + 1);
  const y1 = Math.min(grid.rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const h = grid.height;
  const top = h[y0 * grid.cols + x0] * (1 - tx) + h[y0 * grid.cols + x1] * tx;
  const bottom = h[y1 * grid.cols + x0] * (1 - tx) + h[y1 * grid.cols + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Flattened snapshot index ranges for one site (site-major layout, §7.3). */
export interface SiteRanges {
  procStart: number;
  procCount: number;
  unitStart: number;
  unitCount: number;
  /**
   * Indexes into world.tanks — and therefore the snapshot tank slots, which
   * join by the same index — owned by this site, in array order. Not assumed
   * contiguous: the engine's stub world orders tanks round-robin by site
   * (site = i % nSites), so a per-site slice of the array would attach the
   * wrong tanks and fills.
   */
  tankIndices: number[];
}

/**
 * Per-site index ranges into the flattened snapshot arrays. The stub encoder
 * flattens sites in order (processes site-major, then units), and so does the
 * engine — inspectors slice arrays with these ranges. Tanks are collected per
 * site by their actual site assignment.
 */
export function siteRanges(world: WorldSpec): SiteRanges[] {
  const out: SiteRanges[] = [];
  let proc = 0;
  let unit = 0;
  for (let i = 0; i < world.sites.length; i++) {
    const site = world.sites[i];
    const procCount = site.processes.length;
    const unitCount = site.processes.reduce((n, p) => n + p.units.length, 0);
    out.push({ procStart: proc, procCount, unitStart: unit, unitCount, tankIndices: [] });
    proc += procCount;
    unit += unitCount;
  }
  world.tanks.forEach((t, idx) => {
    if (t.site >= 0 && t.site < out.length) out[t.site].tankIndices.push(idx);
  });
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (x: number, lo: number, hi: number) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Wiggled polyline from a to b with the endpoints pinned; `amtKm` is the max perpendicular offset. */
function wiggle(
  a: [number, number],
  b: [number, number],
  segs: number,
  amtKm: number,
  rand: () => number,
): [number, number][] {
  const pts: [number, number][] = [];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const envelope = Math.sin(Math.PI * t);
    const off = amtKm === 0 ? 0 : (rand() - 0.5) * 2 * amtKm * envelope;
    pts.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off]);
  }
  return pts;
}

/**
 * Seeded stub terrain standing in for crx_terrain (§7.1): 2-octave value noise
 * with land toward the south-west and sea in the north-east corner, where the
 * port sits. Heights in metres; the sea floor dips below 0.
 */
function makeTerrain(seed: number): TerrainGrid {
  const cols = 61;
  const rows = 41;
  const cellKm = 10; // 600 × 400 km
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const octave = (cell: number): ((x: number, y: number) => number) => {
    const gw = Math.ceil(600 / cell) + 2;
    const gh = Math.ceil(400 / cell) + 2;
    const lattice = Array.from({ length: gw * gh }, () => rand());
    return (x, y) => {
      const fx = x / cell;
      const fy = y / cell;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smoothstep(fx - x0, 0, 1);
      const ty = smoothstep(fy - y0, 0, 1);
      const g = (gx: number, gy: number) => lattice[gy * gw + gx];
      const top = g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx;
      const bottom = g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx;
      return top * (1 - ty) + bottom * ty;
    };
  };
  const base = octave(90);
  const detail = octave(30);

  const height = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellKm;
      const y = r * cellKm;
      // sea in the NE beyond the line x + 0.9y ≈ 620; smooth 120 km beach band
      const land = 1 - smoothstep(x + 0.9 * y, 560, 680);
      const highlands = Math.pow(1 - x / 600, 2); // mountains toward the west
      const n = 0.65 * base(x, y) + 0.35 * detail(x, y);
      height[r * cols + c] = -6 + land * (5 + 26 * n + 12 * highlands);
    }
  }
  return { cols, rows, cellKm, height, seaLevelM: 0 };
}

/**
 * The stub reference world: the four M0 sites on fixed positions, a road
 * network, a river with a barge branch, a sea lane to "Overseas", three
 * pipelines and a six-vehicle fleet. Seed varies terrain, route wiggles and
 * (via the encoder) all animated data.
 */
export function stubWorld(seed: number): WorldSpec {
  const rand = mulberry32(seed ^ 0x51ed270b);
  const road = (a: [number, number], b: [number, number]): [number, number][] =>
    wiggle(a, b, 8, 6, rand);
  // river: hand path blended with a seeded wiggle so it curves but stays put
  const riverWiggle = wiggle([60, 300], [545, 172], 7, 10, rand);
  const riverPath: [number, number][] = [
    [60, 300], [150, 270], [260, 215], [300, 180], [340, 150], [420, 140], [500, 160], [545, 172],
  ];
  const riverPts: [number, number][] = riverPath.map(([x, y], i) => [
    (x + riverWiggle[i][0]) / 2,
    (y + riverWiggle[i][1]) / 2,
  ]);
  const routes: RouteSpec[] = [
    { mode: 'road', ends: ['Oil Field', 'Refinery'], sites: [0, 1], points: road([120, 260], [260, 210]) },
    { mode: 'road', ends: ['Refinery', 'Steam Cracker'], sites: [1, 2], points: road([260, 210], [340, 150]) },
    { mode: 'road', ends: ['Steam Cracker', 'Port Terminal'], sites: [2, 3], points: road([340, 150], [480, 90]) },
    { mode: 'road', ends: ['Oil Field', 'Steam Cracker'], sites: [0, 2], points: road([120, 260], [340, 150]) },
    { mode: 'road', ends: ['Refinery', 'Port Terminal'], sites: [1, 3], points: road([260, 210], [480, 90]) },
    {
      mode: 'river',
      ends: ['Refinery', 'Steam Cracker'],
      sites: [1, 2],
      points: riverPts,
    },
    {
      mode: 'sea',
      ends: ['Port Terminal', 'Overseas'],
      sites: [3, null],
      points: wiggle([540, 95], [588, 12], 4, 0, rand),
    },
    {
      mode: 'river',
      ends: ['Steam Cracker', 'Port Terminal'],
      sites: [2, 3],
      points: wiggle([340, 150], [530, 110], 5, 8, rand),
    },
  ];

  const sites: SiteSpec[] = [
    {
      name: 'Oil Field', preset: 'OIL_FIELD', x: 120, y: 260,
      processes: [
        {
          key: 'OIL_PRODUCTION', name: 'Oil production', designRateTph: 1125,
          units: [{ key: 'OIL-WELLS', name: 'Wellhead pad', glyph: 'reactor', trains: 4 }],
        },
      ],
    },
    {
      name: 'Refinery', preset: 'REFINERY', x: 260, y: 210,
      processes: [
        {
          key: 'CRUDE_DISTILLATION', name: 'Crude distillation', designRateTph: 1125,
          units: [
            { key: 'RF-CDU', name: 'Atmospheric column', glyph: 'column', trains: 1 },
            { key: 'RF-VDU', name: 'Vacuum column', glyph: 'column', trains: 1 },
          ],
        },
        {
          key: 'REFORMING', name: 'Catalytic reforming', designRateTph: 950,
          units: [
            { key: 'RF-NHT', name: 'Naphtha hydrotreater', glyph: 'reactor', trains: 1 },
            { key: 'RF-CCR', name: 'CCR platformer', glyph: 'reactor', trains: 1 },
            { key: 'RF-BTX', name: 'BTX splitter', glyph: 'column', trains: 1 },
          ],
        },
        {
          key: 'FCC', name: 'Fluid catalytic cracking', designRateTph: 800,
          units: [
            { key: 'RF-FCC', name: 'FCC reactor', glyph: 'reactor', trains: 1 },
            { key: 'RF-FRAC', name: 'Main fractionator', glyph: 'column', trains: 1 },
          ],
        },
        {
          key: 'DIESEL_HDT', name: 'Diesel hydrotreating', designRateTph: 500,
          units: [{ key: 'RF-DHT', name: 'Diesel hydrotreater', glyph: 'reactor', trains: 2 }],
        },
      ],
    },
    {
      name: 'Steam Cracker', preset: 'STEAM_CRACKER', x: 340, y: 150,
      processes: [
        {
          key: 'OLEFINS_FLEX', name: 'Olefins (flex)', designRateTph: 229,
          units: [
            { key: 'SC-FURN', name: 'Pyrolysis furnaces', glyph: 'furnace', trains: 8 },
            { key: 'SC-QUENCH', name: 'Quench and primary frac', glyph: 'column', trains: 1 },
            { key: 'SC-CGC', name: 'Cracked-gas compressor', glyph: 'compressor_house', trains: 1 },
            { key: 'SC-COLD', name: 'Chilling train', glyph: 'column', trains: 1 },
            { key: 'SC-BTX', name: 'Pygas hydrotreating', glyph: 'reactor', trains: 1 },
          ],
        },
      ],
    },
    {
      name: 'Port Terminal', preset: 'PORT_TERMINAL', x: 480, y: 90,
      processes: [],
    },
  ];

  const tanks: TankSpec[] = [
    { site: 0, material: 'CRUDE', role: 'product', capacityT: 80000, drawTph: 0 },
    { site: 1, material: 'CRUDE', role: 'feed', capacityT: 150000, drawTph: 1125 },
    { site: 1, material: 'GASOLINE', role: 'product', capacityT: 50000, drawTph: 0 },
    { site: 2, material: 'NAPHTHA', role: 'feed', capacityT: 60000, drawTph: 229 },
    { site: 2, material: 'ETHYLENE', role: 'internal', capacityT: 30000, drawTph: 0 },
    { site: 2, material: 'PE', role: 'product', capacityT: 40000, drawTph: 0 },
    { site: 3, material: 'DIESEL', role: 'product', capacityT: 40000, drawTph: 350 },
    { site: 3, material: 'GASOLINE', role: 'product', capacityT: 40000, drawTph: 300 },
  ];

  const pipelines: PipelineSpec[] = [
    { fromSite: 0, toSite: 1, material: 'CRUDE', capTph: 1125, points: [[120, 260], [190, 235], [260, 210]] },
    { fromSite: 1, toSite: 2, material: 'NAPHTHA', capTph: 240, points: [[260, 210], [300, 180], [340, 150]] },
    { fromSite: 1, toSite: 3, material: 'GASOLINE', capTph: 350, points: [[260, 210], [370, 150], [480, 90]] },
  ];

  const vehicles: VehicleSpec[] = [
    { cls: 'TRUCK_TANK', cargo: 'DIESEL', route: 0, loopTicks: 64, phase: 0.0 },
    { cls: 'TRUCK_TANK', cargo: 'GASOLINE', route: 4, loopTicks: 88, phase: 0.35 },
    { cls: 'TRUCK_BULK', cargo: 'PE', route: 2, loopTicks: 72, phase: 0.6 },
    { cls: 'BARGE_TANK', cargo: 'GASOLINE', route: 5, loopTicks: 384, phase: 0.2 },
    { cls: 'SHIP_TANK', cargo: 'CRUDE', route: 6, loopTicks: 1728, phase: 0.1 },
    { cls: 'TRUCK_PRESS', cargo: 'LPG', route: 1, loopTicks: 80, phase: 0.8 },
  ];

  return { seed, wKm: 600, hKm: 400, terrain: makeTerrain(seed), sites, tanks, routes, pipelines, vehicles };
}

// ---- Engine world reconciliation (M0 stub ↔ WorldSpec) ----
//
// §7.4 says GET /world returns the static world description, and §7.3 that it
// maps every index to name, geometry and catalog entry. The M0 stub engine
// publishes only a minimal subset ({world:"stub", materials, sites[{i,name,x,y}],
// tanks[{i,site,material}]}) — not enough to render the map. Until the engine
// ships the full world (M1+), the client fills static geometry from its own
// deterministic stubWorld(seed) — the same four-site M0 layout the engine
// reports — and lets engine facts win wherever it provides them, by index.
// A payload that already is a full WorldSpec passes through untouched, so the
// upgrade path needs no client change.

/** True when `w` already carries every array a scene needs (full §7.3 world). */
export function isFullWorldSpec(w: unknown): w is WorldSpec {
  if (typeof w !== 'object' || w === null) return false;
  const r = w as Record<string, unknown>;
  const terrain = r.terrain;
  if (typeof terrain !== 'object' || terrain === null) return false;
  const t = terrain as Record<string, unknown>;
  const heightOk = Array.isArray(t.height) || t.height instanceof Float32Array;
  return (
    typeof t.cols === 'number' &&
    typeof t.rows === 'number' &&
    heightOk &&
    Array.isArray(r.sites) &&
    Array.isArray(r.tanks) &&
    Array.isArray(r.routes) &&
    Array.isArray(r.pipelines) &&
    Array.isArray(r.vehicles)
  );
}

/** Narrow readers for the M0 stub engine's world JSON; anything else is ignored. */
function engineSites(world: unknown): { i: number; name?: string; x?: number; y?: number }[] {
  if (typeof world !== 'object' || world === null) return [];
  const sites = (world as Record<string, unknown>).sites;
  if (!Array.isArray(sites)) return [];
  return sites.flatMap((s) => {
    if (typeof s !== 'object' || s === null) return [];
    const r = s as Record<string, unknown>;
    if (typeof r.i !== 'number') return [];
    return [{
      i: r.i,
      name: typeof r.name === 'string' ? r.name : undefined,
      x: typeof r.x === 'number' ? r.x : undefined,
      y: typeof r.y === 'number' ? r.y : undefined,
    }];
  });
}

function engineTanks(world: unknown): { i: number; site?: number; material?: string }[] {
  if (typeof world !== 'object' || world === null) return [];
  const tanks = (world as Record<string, unknown>).tanks;
  if (!Array.isArray(tanks)) return [];
  return tanks.flatMap((t) => {
    if (typeof t !== 'object' || t === null) return [];
    const r = t as Record<string, unknown>;
    if (typeof r.i !== 'number') return [];
    return [{
      i: r.i,
      site: typeof r.site === 'number' ? r.site : undefined,
      material: typeof r.material === 'string' ? r.material : undefined,
    }];
  });
}

/**
 * The WorldSpec to render for a session: `payload` when the engine already
 * publishes a full world, otherwise the seeded stub geometry with the engine's
 * site and tank facts merged in by index. Engine facts that would corrupt the
 * render (site out of range, material outside the palette) keep the stub value.
 */
export function resolveWorld(payload: unknown, seed: number): WorldSpec {
  if (isFullWorldSpec(payload)) return payload;
  const base = stubWorld(seed);
  for (const s of engineSites(payload)) {
    if (s.i < 0 || s.i >= base.sites.length) continue;
    if (s.name !== undefined) base.sites[s.i].name = s.name;
    if (s.x !== undefined) base.sites[s.i].x = s.x;
    if (s.y !== undefined) base.sites[s.i].y = s.y;
  }
  for (const t of engineTanks(payload)) {
    if (t.i < 0 || t.i >= base.tanks.length) continue;
    if (t.site !== undefined && t.site >= 0 && t.site < base.sites.length) base.tanks[t.i].site = t.site;
    if (t.material !== undefined && MATERIALS.includes(t.material)) base.tanks[t.i].material = t.material;
  }
  return base;
}
