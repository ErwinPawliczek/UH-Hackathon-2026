// MapScene: three.js scene assembly and frame driver — instanced hex terrain
// board, per-unit site clusters, CSS2D site labels, mode-styled route lines,
// instanced vehicles, map camera with OrbitControls, click-picking for sites
// and vehicles, and the selection ring. The React component only feeds it
// snapshots and forwards pointer events.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { useSim, type Selection } from '../store/sim';

/** Lines that are not part of the damage view. */
const FADED = 0xd9dce0;
import type { Snapshot } from '../engine/snapshot';
import { VEHICLE_CLASSES, routePointAt, sampleHeight, type WorldSpec } from '../engine/world';
import { buildHexBoard, deckYAt, surfaceYAt, mapToWorld, SCALE } from './terrainMesh';
import { buildFlowLine, resizeFlowLines, setFlowLineColor, tickFlowLines, type FlowLine } from './lines';
import { MODE_LINE_STYLE, PIPELINE_WIDTH, V3, flowColor, routeLineColor } from './palette';
import { SiteLabels } from './siteLabels';
import { PipelineLabels } from './pipelineLabels';
import { TripOverlay, type VehicleTrip } from './tripOverlay';
import { buildBridges } from './bridges';
import { buildSiteLayer, updateInstances, type SiteLayer } from './siteClusters';
import {
  buildVehicleLayer, classMode, updateVehicleCargo, updateVehicles, waterSpan,
  type VehicleLayer, type VehiclePose, type WaterSpan,
} from './instances';
import { RouteNet, VehicleMotion, type DrawTarget } from './vehicleMotion';

export interface PickHit {
  kind: 'site' | 'vehicle';
  index: number;
}

/** Screen pixels the top bar covers, and a margin at the bottom — the map is framed between them. */
const TOP_INSET_PX = 64;
const BOTTOM_INSET_PX = 16;
/** Vehicle statuses (§4.4 VehStatus) at which a vehicle stands at a site: idle, queueing, loading, unloading. */
const AT_SITE = new Set([0, 2, 3, 5, 6]);
/**
 * Idle vehicles are not drawn. The engine leaves a vehicle where it last
 * unloaded and about a third of the fleet is idle at any moment, so drawn
 * idle trucks read as a car park beside every plant. A vehicle shows only
 * while it is travelling, queueing for a bay, loading or unloading; it
 * appears at its site when dispatched and fades out when its job is done.
 * Set true to draw idle vehicles parked in their rows again.
 */
const DRAW_IDLE_VEHICLES = false;
/** §4.4 VehStatus values: no job, driving to load, driving to deliver. */
const VEH_IDLE = 0;
const VEH_TO_PICKUP = 1;
const VEH_TO_DROPOFF = 4;
/** Screen pixels within which a click picks a moving vehicle, and one standing at a site. */
const PICK_MOVING_PX = 18;
const PICK_STANDING_PX = 9;
/** Vehicles on one route within this many km of each other, heading the same way, are one convoy. */
const CONVOY_SAME_KM = 1;
/** Spacing between the members of a convoy, in km: enough to tell them apart and pick each at the default view. */
const CONVOY_GAP_ROAD_KM = 5;
const CONVOY_GAP_WATER_KM = 10;
/** How far past the framed view the camera may pull back. */
const ZOOM_OUT_LIMIT = 1.25;
/** A frame longer than this is slow; a finger's reach round a site centre, in pixels. */
const SLOW_FRAME_S = 0.03;
const PICK_SITE_TOUCH_PX = 44;
/** The build hand-over: how long the camera takes to stand the map up, and how near straight down it starts (radians). */
const INTRO_MS = 2600;
const INTRO_POLAR = 0.02;
/** The framed map should fill this share of the free height; steeper looks to try when it does not (radians from vertical). */
const FRAME_FILL = 0.74;
const STEEPER_POLAR = [0.68, 0.62, 0.56, 0.5];
/** Right on a vehicle: within this many pixels it wins even over a site. */
const PICK_EXACT_PX = 8;
/** Seconds a vehicle takes to appear or fade out. */
const VEHICLE_FADE_S = 0.25;
/** Seconds a truck's or barge's cargo takes to grow onto its bed, or shrink off it. */
const CARGO_GROW_S = 0.3;
/** Trucks standing at a site park in rows on its near side, this many per row. */
const PARK_PER_ROW = 9;

/** Where a river or sea vessel lies when it is at a site: on that site's lane, at the water's edge. */
interface Berth {
  route: number;
  /** arc length (km) of the berth along the route */
  s: number;
  /** direction along the route that leads away from the site */
  away: 1 | -1;
}

/** Default view direction from the orbit target to the camera (tilted, looking north). */
const VIEW_DIR = new THREE.Vector3(0, 42, 38).normalize();

/**
 * A starting camera view from the `?view=x,y,dist` URL parameter: the map
 * point (km) to look at and the camera distance in scene units (10 km each).
 * Lets a link — or a capture script — open straight onto one corner of the
 * map. Null when absent or malformed.
 */
export function viewFromParams(params: URLSearchParams): { xKm: number; yKm: number; dist: number } | null {
  const raw = params.get('view');
  if (raw === null) return null;
  const [xKm, yKm, dist] = raw.split(',').map(Number);
  if (![xKm, yKm, dist].every(Number.isFinite) || dist <= 0) return null;
  return { xKm, yKm, dist };
}

export class MapScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private turnTimer = 0;

  private readonly world: WorldSpec;
  private readonly siteLayer: SiteLayer;
  private readonly vehicleLayer: VehicleLayer;
  private readonly labels: SiteLabels;
  private readonly pipelineLabels: PipelineLabels;
  private readonly trip: TripOverlay;
  private readonly flowLines: FlowLine[] = [];
  /** flowLines[i] for i < routeLineCount is world.routes[i]; pipelines follow. */
  private routeLineCount = 0;
  /** False until the visitor moves the camera; until then resizes re-frame the map. */
  private userMoved = false;
  /** Viewport height at the last resize, and the camera distance that frames the whole map there. */
  /** the camera's ease from top-down into the framed view, while it runs (see playIntro) */
  private intro: { t0: number; ms: number; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromDist: number; toDist: number; toPolar: number } | null = null;
  /** seconds of consecutive slow frames (see watchFrameTime) */
  private slowFor = 0;
  private viewHeight = 0;
  private framedDist = 0;
  private readonly ring: THREE.Mesh;
  private readonly ringPivot: THREE.Group;
  private readonly mineRing: THREE.Mesh;
  private mine = -1;
  /** Wet stretch per route (river and sea lanes only; null for roads and dry spurs). */
  private readonly routeSpans: (WaterSpan | null)[];
  /** Berth per `${site}:${mode}`. */
  private readonly berths = new Map<string, Berth>();
  /** Last snapshot the vehicle cargo colours were taken from. */
  private cargoSnap: Snapshot | null = null;
  /** The routes as a graph, and the drive of every vehicle between snapshots. */
  private readonly net: RouteNet;
  private readonly motion: VehicleMotion;
  private readonly poses: VehiclePose[] = [];
  /** How much of each vehicle is drawn, 0 (hidden) to 1; eases as it appears or fades. */
  private readonly shown: number[] = [];
  /** How much of each vehicle's cargo part is drawn, 0 (empty) to 1; eases as it loads and unloads. */
  private readonly loaded: number[] = [];
  private lastFrameMs = 0;
  /** Snapshot and run the vehicles are currently heading for. */
  private motionSnap: Snapshot | null = null;
  private motionEpoch = -1;
  /** Parking slot per standing vehicle, kept while it stays at its site. */
  private readonly slots = new Map<number, { key: string; slot: number }>();
  /** Per vehicle: the last draw target and the site it stood at then (-1 when it was not standing). */
  private lastTargets: DrawTarget[] = [];
  private lastStoodAt: number[] = [];
  /** Site index by position, for telling which site a standing vehicle is at. */
  private readonly siteAtCache = new Map<string, number>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(
    canvas: HTMLCanvasElement,
    world: WorldSpec,
    initialView: { xKm: number; yKm: number; dist: number } | null = null,
  ) {
    this.world = world;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(V3.white);

    const w = world.wKm * SCALE;
    const h = world.hKm * SCALE;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1200);
    this.camera.position.set(w / 2, 42, h / 2 + 38);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe3e8, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-40, 60, 30);
    this.scene.add(sun);

    this.scene.add(buildHexBoard(world));

    // routes: line style by transport mode. Roads cross water at deck level
    // (bridges); river and sea lanes lie on the water surface.
    const deck = (x: number, y: number) => deckYAt(world, x, y);
    const surface = (x: number, y: number) => surfaceYAt(world, x, y);
    for (let i = 0; i < world.routes.length; i++) {
      const route = world.routes[i];
      const style = MODE_LINE_STYLE[route.mode] ?? MODE_LINE_STYLE.road;
      const flow = buildFlowLine(route.points, route.mode === 'road' ? deck : surface, {
        color: routeLineColor(world, i),
        dash: style.dash,
        gap: style.gap,
        width: style.width,
        lift: 0.06,
      });
      this.flowLines.push(flow);
      this.scene.add(flow.line);
    }
    this.routeLineCount = world.routes.length;
    // pipelines: solid lines in the carried material's flow colour, drawn
    // after the routes so a pipeline stays visible where it follows a road
    for (const pipe of world.pipelines) {
      const flow = buildFlowLine(pipe.points, deck, {
        color: flowColor(pipe.material),
        dash: 0, // solid
        gap: 0,
        width: PIPELINE_WIDTH,
        lift: 0.1,
      });
      flow.line.renderOrder += 0.5;
      this.flowLines.push(flow);
      this.scene.add(flow.line);
    }

    // Vessels are drawn on the wet stretch of their lane only; each site's
    // berth is the water's edge on a lane that ends at it.
    const isWater = (x: number, y: number) => sampleHeight(world.terrain, x, y) < world.terrain.seaLevelM;
    this.routeSpans = world.routes.map((r) => (r.mode === 'road' ? null : waterSpan(r.points, isWater)));
    world.routes.forEach((route, r) => {
      const span = this.routeSpans[r];
      if (span === null) return;
      route.sites.forEach((site, end) => {
        if (site === null) return;
        const berth: Berth = { route: r, s: end === 0 ? span.s0 : span.s1, away: end === 0 ? 1 : -1 };
        const key = `${site}:${route.mode}`;
        const known = this.berths.get(key);
        // several lanes may end at one site: keep the berth nearest to it
        const dist = (b: Berth) => {
          const at = routePointAt(world.routes[b.route].points, b.s);
          return Math.hypot(at.x - world.sites[site].x, at.y - world.sites[site].y);
        };
        if (known === undefined || dist(berth) < dist(known)) this.berths.set(key, berth);
      });
    });

    // roads over water are carried on small bridges
    const bridges = buildBridges(world, isWater, deck, surface);
    if (bridges !== null) this.scene.add(bridges);

    this.net = new RouteNet(world);
    this.motion = new VehicleMotion(
      this.net,
      world.vehicles.map((v) => ({ mode: classMode(v.cls), speedKmh: VEHICLE_CLASSES[v.cls]?.speedKmh ?? 70 })),
      isWater,
    );

    this.siteLayer = buildSiteLayer(world);
    this.scene.add(this.siteLayer.pads, this.siteLayer.rings, this.siteLayer.tanks);
    for (const glyphs of this.siteLayer.glyphs) this.scene.add(glyphs);

    this.vehicleLayer = buildVehicleLayer(world);
    for (const mesh of this.vehicleLayer.meshes) this.scene.add(mesh);
    for (const mesh of this.vehicleLayer.cargo) if (mesh !== null) this.scene.add(mesh);
    this.trip = new TripOverlay(this.scene, this.siteLayer.siteAnchors);

    // canvas is always in the DOM here; a detached canvas just gets an
    // off-screen host so labels exist but render nowhere
    const container = canvas.parentElement ?? document.createElement('div');
    // pipeline names first, so the site labels' overlay sits above them
    this.pipelineLabels = new PipelineLabels(container, world, (x, y) => deckYAt(world, x, y) + 0.1);
    this.labels = new SiteLabels(container, world, this.siteLayer.siteAnchors);
    this.labels.addTo(this.scene);

    // selection ring: flat hexagonal annulus on the picked site cluster
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.02, 6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: V3.blue, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.ring.rotation.y = Math.PI / 6; // align the ring's corners with the hex pads
    this.ring.renderOrder = 2;
    this.ring.visible = false;
    this.ringPivot = new THREE.Group();
    this.ringPivot.add(this.ring);
    this.scene.add(this.ringPivot);

    // "yours" in a multiplayer room: a second, heavier blue ring that stays on the player's own plant
    this.mineRing = new THREE.Mesh(
      new THREE.RingGeometry(1.08, 1.3, 6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: V3.blue, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.mineRing.rotation.y = Math.PI / 6;
    this.mineRing.renderOrder = 1.9;
    this.mineRing.visible = false;
    this.scene.add(this.mineRing);

    this.controls = new OrbitControls(this.camera, canvas);
    // touch: one finger moves the map, two pinch to zoom and twist to turn
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.target.set(w / 2, 0, h / 2);
    this.controls.maxPolarAngle = Math.PI * 0.42; // tilt limit ~75°
    this.controls.minPolarAngle = Math.PI * 0.12;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 160;
    // The map turns slowly by itself to show the model off; any touch, drag or
    // zoom stops it, and it starts again ten seconds after the last one.
    const still = new URLSearchParams(window.location.search).has('still')
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    this.controls.autoRotate = !still;
    this.controls.autoRotateSpeed = 0.5; // about two minutes a turn
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.controls.autoRotate = false;
      window.clearTimeout(this.turnTimer);
    });
    this.controls.addEventListener('end', () => {
      window.clearTimeout(this.turnTimer);
      if (!still) this.turnTimer = window.setTimeout(() => { this.controls.autoRotate = true; }, 10_000);
    });
    if (initialView !== null) {
      // An explicit view wins over the whole-map framing.
      const [tx, tz] = mapToWorld(initialView.xKm, initialView.yKm);
      const dist = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, initialView.dist));
      this.controls.target.set(tx, 0, tz);
      this.camera.position.set(tx + VIEW_DIR.x * dist, VIEW_DIR.y * dist, tz + VIEW_DIR.z * dist);
      this.userMoved = true;
    }
    this.controls.update();
  }

  /**
   * Frame the whole map below the top bar: the closest
   * camera distance (along the default tilt) at which all four map corners
   * are on screen, with the map centred in the free band. Runs on every
   * resize until the visitor moves the camera.
   */
  private frameMap(height: number): void {
    // On a tall viewport the default tilt leaves wide bands above and below
    // the map: look down more steeply, step by step, until it fills most of
    // the free height.
    let framed = this.frameAt(height, VIEW_DIR);
    for (const polar of STEEPER_POLAR) {
      if (framed === null || framed.fill >= FRAME_FILL) break;
      framed = this.frameAt(height, new THREE.Vector3(0, Math.cos(polar), Math.sin(polar))) ?? framed;
    }
    if (framed === null) return;
    const { dist } = framed;
    // Zooming out stops a little past the framed view, so the map stays the
    // subject of the screen, and site names stay on all the way out.
    this.framedDist = dist;
    this.controls.maxDistance = dist * ZOOM_OUT_LIMIT;
    this.labels.setMaxDistance(dist * ZOOM_OUT_LIMIT * 1.05);
    this.controls.update();
  }

  /** Frame the map looking along `dir`; returns the distance and the share of the free height the map fills. */
  private frameAt(height: number, dir: THREE.Vector3): { dist: number; fill: number } | null {
    const w = this.world.wKm * SCALE;
    const h = this.world.hKm * SCALE;
    const top = 1 - (2 * TOP_INSET_PX) / Math.max(1, height);
    const bottom = -1 + (2 * BOTTOM_INSET_PX) / Math.max(1, height);
    if (top - bottom < 0.2) return null; // viewport too short to frame anything
    const side = 0.985;
    const corners = [[0, 0], [w, 0], [0, h], [w, h]];
    const v = new THREE.Vector3();
    const bounds = (dist: number, targetZ: number) => {
      this.camera.position.set(w / 2 + dir.x * dist, dir.y * dist, targetZ + dir.z * dist);
      this.camera.lookAt(w / 2, 0, targetZ);
      this.camera.updateMatrixWorld();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, z] of corners) {
        v.set(x, 0, z).project(this.camera);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
      return { minX, maxX, minY, maxY };
    };
    // Sliding the target south moves the map up the screen: centre it in the band.
    const centredZ = (dist: number) => {
      let lo = h / 2 - 60, hi = h / 2 + 60;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const b = bounds(dist, mid);
        if ((b.minY + b.maxY) / 2 < (top + bottom) / 2) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    const fitsAt = (dist: number) => {
      const b = bounds(dist, centredZ(dist));
      return b.minX >= -side && b.maxX <= side && b.minY >= bottom && b.maxY <= top;
    };
    let lo = 8, hi = 600;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) hi = mid;
      else lo = mid;
    }
    const dist = hi;
    const targetZ = centredZ(dist);
    const b = bounds(dist, targetZ); // leaves the camera at the chosen pose
    this.controls.target.set(w / 2, 0, targetZ);
    return { dist, fill: (b.maxY - b.minY) / (top - bottom) };
  }

  /** Back to the framed start view: the whole map, centred under the top bar. */
  resetView(): void {
    if (this.viewHeight <= 0) return;
    this.userMoved = false;
    this.frameMap(this.viewHeight);
  }

  /**
   * The hand-over from the map builder's build animation: start looking
   * straight down at the whole map, as the flat drawing was seen, and ease
   * into the framed view, so the drawing reads as standing up into the
   * world. Runs once; the camera cannot be moved until it ends.
   */
  playIntro(durationMs = INTRO_MS): void {
    if (this.viewHeight <= 0 || this.framedDist <= 0) return;
    this.userMoved = false;
    this.frameMap(this.viewHeight);
    const w = this.world.wKm * SCALE;
    const h = this.world.hKm * SCALE;
    const to = this.camera.position.clone().sub(this.controls.target);
    const half = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.intro = {
      t0: performance.now(),
      ms: durationMs,
      fromTarget: new THREE.Vector3(w / 2, 0, h / 2),
      toTarget: this.controls.target.clone(),
      // far enough, looking straight down, for the whole map with a margin
      fromDist: Math.max((h * 1.2) / (2 * half), (w * 1.06) / (2 * half * this.camera.aspect)),
      toDist: to.length(),
      toPolar: Math.acos(to.y / to.length()),
    };
    this.controls.enabled = false;
    this.stepIntro(performance.now());
  }

  /** Place the camera along the intro; true while it is still running. */
  private stepIntro(now: number): boolean {
    const it = this.intro;
    if (it === null) return false;
    const k = Math.min(1, (now - it.t0) / it.ms);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in and out
    const polar = INTRO_POLAR + (it.toPolar - INTRO_POLAR) * e;
    const dist = it.fromDist + (it.toDist - it.fromDist) * e;
    const target = it.fromTarget.clone().lerp(it.toTarget, e);
    this.camera.position.set(target.x, target.y + Math.cos(polar) * dist, target.z + Math.sin(polar) * dist);
    this.camera.lookAt(target);
    this.controls.target.copy(target);
    if (k >= 1) {
      this.intro = null;
      this.controls.enabled = true;
      this.controls.update();
      return false;
    }
    return true;
  }

  /** Keep the point the camera orbits on the map, so a pan cannot carry the map off the screen. */
  private clampPan(): void {
    const t = this.controls.target;
    const x = Math.min(this.world.wKm * SCALE, Math.max(0, t.x));
    const z = Math.min(this.world.hKm * SCALE, Math.max(0, t.z));
    if (x === t.x && z === t.z && t.y === 0) return;
    this.camera.position.x += x - t.x;
    this.camera.position.z += z - t.z;
    this.camera.position.y -= t.y;
    t.set(x, 0, z);
  }

  /**
   * Push a snapshot into the layers. `f` (0..1) interpolates tank levels from
   * `prev`; vehicles drive on their own clock (`nowMs`), see vehicleMotion.ts.
   * `epoch` changes whenever the run is replaced or taken back in time:
   * vehicles are then placed at once instead of driving to where they are.
   * `stepMs` is the real time between snapshots the step loop aims for.
   */
  applySnapshot(
    cur: Snapshot,
    prev: Snapshot | null,
    f: number,
    selection: Selection,
    nowMs: number = performance.now(),
    epoch = 0,
    stepMs = 250,
  ): void {
    const selectedSite = selection !== null && selection.kind === 'site' ? selection.index : null;
    updateInstances(this.siteLayer, cur, prev, f, selectedSite);
    const damage = useSim.getState().damageView;
    // closed routes (array 10) turn alarm red until they reopen
    for (let i = 0; i < this.routeLineCount && i < cur.edgeOpen.length; i++) {
      const line = this.flowLines[i];
      setFlowLineColor(line, cur.edgeOpen[i] === 0 ? V3.alarm : damage !== null ? FADED : line.color);
    }
    // the damage view: the pipelines that stopped carrying stand out in red, the rest fade
    for (let i = this.routeLineCount; i < this.flowLines.length; i++) {
      const line = this.flowLines[i];
      setFlowLineColor(line, damage === null ? line.color : damage.pipelines.includes(i - this.routeLineCount) ? V3.alarm : FADED);
    }
    let instantPlaced = false;
    if (cur !== this.motionSnap) {
      const last = this.motionSnap;
      const instant =
        last === null || epoch !== this.motionEpoch || cur.tick <= last.tick || cur.nVeh !== last.nVeh;
      instantPlaced = instant;
      if (instant) this.slots.clear();
      const ticks = last === null ? 0 : Number(cur.tick - last.tick);
      if (instant) this.lastTargets = [];
      this.motion.retarget(this.drawTargets(cur), nowMs, ticks, instant, stepMs);
      this.motionSnap = cur;
      this.motionEpoch = epoch;
    }
    this.motion.sample(nowMs, this.poses);
    const fade = Math.min(1, Math.max(0, (nowMs - this.lastFrameMs) / 1000) / VEHICLE_FADE_S);
    this.lastFrameMs = nowMs;
    for (let v = 0; v < cur.nVeh; v++) {
      const want = DRAW_IDLE_VEHICLES || cur.vehStatus[2 * v] !== VEH_IDLE ? 1 : 0;
      const now = this.shown[v];
      this.shown[v] = now === undefined || instantPlaced ? want : now + Math.sign(want - now) * Math.min(fade, Math.abs(want - now));
    }
    this.shown.length = cur.nVeh;
    const grow = fade * (VEHICLE_FADE_S / CARGO_GROW_S);
    for (let v = 0; v < cur.nVeh; v++) {
      const want = cur.vehPos[5 * v + 4] > 0.02 ? 1 : 0; // array 6: cargo on board over capacity
      const now = this.loaded[v];
      this.loaded[v] = now === undefined || instantPlaced ? want : now + Math.sign(want - now) * Math.min(grow, Math.abs(want - now));
    }
    this.loaded.length = cur.nVeh;
    updateVehicles(
      this.vehicleLayer,
      this.poses,
      // trucks keep to the road deck over water; vessels ride the water surface
      (x, y, v) => this.vehicleY(v, x, y),
      (v) => this.shown[v] ?? 1,
      (v) => this.loaded[v] ?? 1,
    );
    if (cur !== this.cargoSnap) {
      updateVehicleCargo(this.vehicleLayer, this.world, cur);
      this.cargoSnap = cur;
    }
    this.syncRing(selection, this.poses);
  }

  /** World Y of what vehicle `v` stands on at a map point: the road deck for trucks, the water for vessels. */
  private vehicleY(v: number, x: number, y: number): number {
    return classMode(this.world.vehicles[v]?.cls ?? '') === 'road'
      ? deckYAt(this.world, x, y)
      : surfaceYAt(this.world, x, y);
  }

  /**
   * Draw the selected vehicle's trip: the way ahead of it and rings on the
   * sites it runs between. `trip` is what the UI fetched for the selected
   * vehicle, or null; it is ignored unless it is for the vehicle selected
   * now and that vehicle is on the map.
   */
  showTrip(trip: VehicleTrip | null, selection: Selection): void {
    const v = selection !== null && selection.kind === 'vehicle' ? selection.index : -1;
    const pose = v >= 0 ? this.poses[v] : undefined;
    const active = trip !== null && pose !== undefined && trip.index === v && (this.shown[v] ?? 1) >= 0.5;
    this.trip.update(active ? trip : null, active ? pose : null, (x, y) => this.vehicleY(v, x, y));
  }

  /** Where every vehicle is drawn this frame (map km) — for the selection ring, picking and checks. */
  vehiclePoses(): readonly VehiclePose[] {
    return this.poses;
  }

  /** Keep a vessel's drawn progress on the wet stretch of its lane. */
  private readonly clampToWater = (routeId: number, p: number): number => {
    const span = this.routeSpans[routeId];
    if (span === null || span === undefined || span.length <= 0) return p;
    return Math.min(span.s1, Math.max(span.s0, p * span.length)) / span.length;
  };

  /** Index of the site at a map position (within 1 km), or -1. */
  private siteAt(x: number, y: number): number {
    const key = `${Math.round(x)}:${Math.round(y)}`;
    let site = this.siteAtCache.get(key);
    if (site === undefined) {
      site = this.world.sites.findIndex((s) => Math.abs(s.x - x) < 1 && Math.abs(s.y - y) < 1);
      this.siteAtCache.set(key, site);
    }
    return site;
  }

  /** A standing vehicle's parking slot: kept while it stays, else the lowest free one. */
  private slotFor(v: number, key: string): number {
    const held = this.slots.get(v);
    if (held !== undefined && held.key === key) return held.slot;
    const taken = new Set<number>();
    for (const other of this.slots.values()) if (other.key === key) taken.add(other.slot);
    let slot = 0;
    while (taken.has(slot)) slot++;
    this.slots.set(v, { key, slot });
    return slot;
  }

  /**
   * Where every vehicle of a snapshot is to be drawn. Vehicles standing at a
   * site all report the site's own position: trucks are parked in rows on
   * the site's near side, vessels moored one behind another at its berth.
   * The rest are on their route, or at a junction.
   */
  private drawTargets(snap: Snapshot): DrawTarget[] {
    const world = this.world;
    const targets: DrawTarget[] = [];
    const stoodAt: number[] = [];
    const convoy = new Map<string, number>();
    for (let v = 0; v < snap.nVeh; v++) {
      const x = snap.vehPos[5 * v];
      const y = snap.vehPos[5 * v + 1];
      const dir: [number, number] = [snap.vehPos[5 * v + 2] || 0, snap.vehPos[5 * v + 3] || 1];
      const mode = classMode(world.vehicles[v]?.cls ?? '');
      const status = snap.vehStatus[2 * v];
      const site = AT_SITE.has(status) && v < world.vehicles.length ? this.siteAt(x, y) : -1;
      const standing = site >= 0 && (DRAW_IDLE_VEHICLES || status !== VEH_IDLE);
      if (standing) {
        const parked = this.parkTarget(v, site, this.slotFor(v, `${site}:${mode}`), dir);
        if (parked !== null) {
          targets.push(parked);
          stoodAt.push(site);
          continue;
        }
      }
      this.slots.delete(v);
      // A hidden idle vehicle gives up its slot but stays where it stood, so
      // it fades out in place and later drives off from there.
      const held = this.lastTargets[v];
      if (site >= 0 && held !== undefined && this.lastStoodAt[v] === site) {
        targets.push(held);
        stoodAt.push(site);
        continue;
      }
      stoodAt.push(-1);
      const routeId = snap.vehRoute?.[v];
      const progress = snap.vehProgress?.[v];
      if (routeId !== undefined && progress !== undefined && routeId < world.routes.length) {
        const length = this.net.routes[routeId].length;
        const lead = this.clampToWater(routeId, progress) * length;
        // Vehicles sent out together share a position: line them up behind the first.
        const a = this.net.pointAt(routeId, Math.max(0, lead - 0.5));
        const b = this.net.pointAt(routeId, Math.min(length, lead + 0.5));
        const forward = (b.x - a.x) * dir[0] + (b.y - a.y) * dir[1] >= 0 ? 1 : -1;
        const key = `${routeId}:${forward}:${Math.round(lead / CONVOY_SAME_KM)}`;
        const rank = convoy.get(key) ?? 0;
        convoy.set(key, rank + 1);
        const gap = mode === 'road' ? CONVOY_GAP_ROAD_KM : CONVOY_GAP_WATER_KM;
        const s = this.clampToWater(routeId, Math.min(length, Math.max(0, lead - forward * rank * gap)) / Math.max(length, 1e-6)) * length;
        const at = this.net.pointAt(routeId, s);
        targets.push({ x: at.x, y: at.y, net: { kind: 'route', route: routeId, s }, dir, restDir: null, standoffKm: 0 });
        continue;
      }
      const node = this.net.nodeNear(mode, x, y, 1.5);
      targets.push({ x, y, net: node >= 0 ? { kind: 'node', node } : null, dir, restDir: null, standoffKm: 0 });
    }
    this.lastTargets = targets;
    this.lastStoodAt = stoodAt;
    return targets;
  }

  /** The standing place of vehicle `v` at `site`, in parking slot `slot`. */
  private parkTarget(v: number, site: number, slot: number, dir: [number, number]): DrawTarget | null {
    const world = this.world;
    const cls = world.vehicles[v].cls;
    const mode = classMode(cls);
    if (mode === 'road') {
      const anchor = this.siteLayer.siteAnchors[site];
      const row = Math.floor(slot / PARK_PER_ROW);
      const col = slot % PARK_PER_ROW;
      // an arc on the south side of the cluster (towards the default camera)
      const angle = Math.PI / 2 + (col / (PARK_PER_ROW - 1) - 0.5) * Math.PI * 0.8;
      const radiusKm = (anchor.clusterR + 0.42 + 0.56 * row) / SCALE;
      const node = this.net.siteNode(site, 'road');
      return {
        x: world.sites[site].x + Math.cos(angle) * radiusKm,
        y: world.sites[site].y + Math.sin(angle) * radiusKm,
        net: node >= 0 ? { kind: 'node', node } : null,
        dir,
        restDir: [Math.cos(angle), Math.sin(angle)],
        // leave the road where the cluster begins and pull over to the row
        standoffKm: (anchor.clusterR + 0.3) / SCALE,
      };
    }
    const berth = this.berths.get(`${site}:${mode}`);
    if (berth === undefined) return null; // no wet lane ends here: leave the engine pose
    const span = this.routeSpans[berth.route];
    if (span === null) return null;
    // half a hull out from the water's edge so the bow is not on the bank,
    // then one hull and a gap per vessel already moored here
    const hullKm = VEHICLE_CLASSES[cls]?.sceneLength ?? 12;
    const offsetKm = hullKm / 2 + 4 + slot * (hullKm + 4);
    const s = Math.min(span.s1, Math.max(span.s0, berth.s + berth.away * offsetKm));
    const at = this.net.pointAt(berth.route, s);
    return {
      x: at.x,
      y: at.y,
      net: { kind: 'route', route: berth.route, s },
      dir,
      // bow towards the site
      restDir: [-berth.away * at.dirX, -berth.away * at.dirY],
      standoffKm: 0,
    };
  }

  /** Ring the player's own plant (a multiplayer room), or none with null. */
  setMine(site: number | null): void {
    const index = site ?? -1;
    if (index === this.mine) return;
    this.mine = index;
    const anchor = this.siteLayer.siteAnchors[index];
    this.mineRing.visible = anchor !== undefined;
    if (anchor === undefined) return;
    this.mineRing.position.set(anchor.x, anchor.topY + 0.025, anchor.z);
    this.mineRing.scale.setScalar((anchor.clusterR + 0.15) / 1.02);
  }

  private syncRing(selection: Selection, poses: readonly { x: number; y: number }[]): void {
    if (selection === null) {
      this.ring.visible = false;
      return;
    }
    if (selection.kind === 'site') {
      const anchor = this.siteLayer.siteAnchors[selection.index];
      if (anchor === undefined) {
        this.ring.visible = false;
        return;
      }
      this.ringPivot.position.set(anchor.x, anchor.topY + 0.03, anchor.z);
      this.ring.scale.setScalar((anchor.clusterR + 0.15) / 1.02);
    } else {
      const pose = poses[selection.index];
      // no ring round a vehicle that is not drawn
      if (pose === undefined || (this.shown[selection.index] ?? 1) < 0.5) {
        this.ring.visible = false;
        return;
      }
      const [x, z] = mapToWorld(pose.x, pose.y);
      this.ringPivot.position.set(x, this.vehicleY(selection.index, pose.x, pose.y) + 0.15, z);
      this.ring.scale.setScalar(1.2);
    }
    this.ring.visible = true;
  }

  /** Raycast the pointer against unit pads and vehicle meshes. */
  pick(clientX: number, clientY: number, coarse = false): PickHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // A site's label (badge and name) is that site, whatever passes under it.
    const labelled = this.labelAt(clientX, clientY);
    if (labelled >= 0) return { kind: 'site', index: labelled };
    // Right on a vehicle: the vehicle, even over a site.
    const exact = this.vehicleNearAny(px, py, rect, PICK_EXACT_PX);
    if (exact >= 0) return { kind: 'vehicle', index: exact };
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      [this.siteLayer.pads, ...this.vehicleLayer.meshes],
      false,
    );
    // A site cluster wins over anything merely near the pointer.
    for (const hit of hits) {
      if (hit.object === this.siteLayer.pads && hit.instanceId !== undefined) {
        return { kind: 'site', index: this.siteLayer.glyphSite[hit.instanceId] };
      }
    }
    // Small pads on a large map miss raycasts by a few pixels: the projected
    // site centre within a click tolerance counts as the cluster.
    const v = new THREE.Vector3();
    let bestSite = -1;
    let bestDist = coarse ? PICK_SITE_TOUCH_PX : 24; // px: a finger gets a wider target
    this.siteLayer.siteAnchors.forEach((anchor, i) => {
      v.set(anchor.x, anchor.topY + 0.85, anchor.z).project(this.camera);
      if (v.z > 1) return; // behind the camera
      const d = Math.hypot((v.x * 0.5 + 0.5) * rect.width - px, (-v.y * 0.5 + 0.5) * rect.height - py);
      if (d < bestDist) {
        bestDist = d;
        bestSite = i;
      }
    });
    if (bestSite >= 0) return { kind: 'site', index: bestSite };
    for (const hit of hits) {
      const meshIdx = this.vehicleLayer.meshes.indexOf(hit.object as THREE.InstancedMesh);
      if (meshIdx >= 0 && hit.instanceId !== undefined) {
        const index = this.vehicleLayer.members[meshIdx][hit.instanceId];
        // a vehicle that is not drawn cannot be picked
        if (index !== undefined && (this.shown[index] ?? 1) >= 0.5) return { kind: 'vehicle', index };
      }
    }
    // Away from any site, a moving vehicle is a small, fast target: near is enough.
    const moving = this.vehicleNear(px, py, rect, PICK_MOVING_PX, true);
    if (moving >= 0) return { kind: 'vehicle', index: moving };
    const standing = this.vehicleNear(px, py, rect, PICK_STANDING_PX, false);
    return standing >= 0 ? { kind: 'vehicle', index: standing } : null;
  }

  /** Site whose visible label box (badge and name) holds a client point, or -1. */
  private labelAt(clientX: number, clientY: number): number {
    const host = this.renderer.domElement.parentElement;
    if (host === null) return -1;
    for (const el of host.querySelectorAll<HTMLElement>('.site-label[data-site]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
      return Number(el.dataset.site);
    }
    return -1;
  }

  /** The nearest drawn vehicle within `radiusPx`, moving or standing, or -1. */
  private vehicleNearAny(px: number, py: number, rect: DOMRect, radiusPx: number): number {
    const moving = this.vehicleNear(px, py, rect, radiusPx, true);
    return moving >= 0 ? moving : this.vehicleNear(px, py, rect, radiusPx, false);
  }

  /**
   * The drawn vehicle nearest to a canvas point, within `radiusPx`, or -1.
   * `moving` picks among vehicles on the road or water; otherwise among the
   * ones standing at a site.
   */
  private vehicleNear(px: number, py: number, rect: DOMRect, radiusPx: number, moving: boolean): number {
    const snap = this.motionSnap;
    if (snap === null) return -1;
    const v3 = new THREE.Vector3();
    let best = -1;
    let bestD = radiusPx;
    for (let v = 0; v < this.poses.length; v++) {
      if ((this.shown[v] ?? 1) < 0.5) continue;
      const status = snap.vehStatus[2 * v];
      if ((status === VEH_TO_PICKUP || status === VEH_TO_DROPOFF) !== moving) continue;
      const pose = this.poses[v];
      const [x, z] = mapToWorld(pose.x, pose.y);
      v3.set(x, this.vehicleY(v, pose.x, pose.y) + 0.15, z).project(this.camera);
      if (v3.z > 1) continue;
      const d = Math.hypot((v3.x * 0.5 + 0.5) * rect.width - px, (-v3.y * 0.5 + 0.5) * rect.height - py);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.labels.setSize(width, height);
    this.pipelineLabels.setSize(width, height);
    resizeFlowLines(this.flowLines, width, height);
    this.trip.resize(width, height);
    this.viewHeight = height;
    if (this.intro !== null) {
      // the viewport changed mid-intro: start it again for the new shape
      this.frameMap(height);
      this.playIntro(Math.max(400, this.intro.ms - (performance.now() - this.intro.t0)));
    } else if (!this.userMoved) this.frameMap(height);
    else {
      // keep the zoom-out limit in step with the new viewport without moving the visitor's view
      const pos = this.camera.position.clone();
      const target = this.controls.target.clone();
      this.frameMap(height);
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
    }
  }

  render(): void {
    if (!this.stepIntro(performance.now())) {
      this.controls.update();
      this.clampPan();
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.update(
      this.camera,
      this.controls.target.x,
      this.controls.target.y,
      this.controls.target.z,
    );
    this.pipelineLabels.update(
      this.camera,
      this.framedDist > 0 ? this.framedDist / this.camera.position.distanceTo(this.controls.target) : 1,
    );
  }

  /** Advance flow-dash animation; dt in seconds. Kept for the render loop API. */
  animate(dtSec: number): void {
    tickFlowLines(this.flowLines, dtSec);
    this.watchFrameTime(dtSec);
  }

  /**
   * A phone that cannot keep up gets fewer pixels: when frames have taken
   * over 30 ms for a second running, the pixel ratio steps down from 2 to
   * 1.5 and stays there.
   */
  private watchFrameTime(dtSec: number): void {
    if (dtSec > SLOW_FRAME_S && dtSec < 1) this.slowFor += dtSec;
    else this.slowFor = 0;
    if (this.slowFor < 1) return;
    this.slowFor = 0;
    const now = this.renderer.getPixelRatio();
    const next = now > 1.5 ? 1.5 : now; // no lower: at 1 the map goes soft on a phone
    if (next === now) return;
    this.renderer.setPixelRatio(next);
    const size = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setSize(size.x, size.y, false);
    resizeFlowLines(this.flowLines, size.x, size.y);
  }

  dispose(): void {
    this.labels.dispose();
    this.pipelineLabels.dispose();
    this.trip.dispose();
    window.clearTimeout(this.turnTimer);
    this.controls.dispose();
    this.scene.traverse((obj) => {
      // (Line2 is a Mesh, so the fat route lines are covered too.)
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.InstancedMesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else mat.dispose();
      }
    });
    this.renderer.dispose();
  }
}
