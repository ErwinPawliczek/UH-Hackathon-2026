// MapScene: three.js scene assembly and frame driver — instanced hex terrain
// board, per-unit site clusters, CSS2D site labels, mode-styled route lines,
// instanced vehicles, map camera with OrbitControls, click-picking for sites
// and vehicles, and the selection ring. The React component only feeds it
// snapshots and forwards pointer events.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Selection } from '../store/sim';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { buildHexBoard, deckYAt, surfaceYAt, mapToWorld, SCALE } from './terrainMesh';
import { buildFlowLine, resizeFlowLines, setFlowLineColor, tickFlowLines, type FlowLine } from './lines';
import { MODE_LINE_STYLE, PIPELINE_WIDTH, V3, flowColor, routeLineColor } from './palette';
import { SiteLabels } from './siteLabels';
import { buildSiteLayer, updateInstances, type SiteLayer } from './siteClusters';
import { buildVehicleLayer, lerpPose, updateVehicleCargo, updateVehicles, type VehicleLayer } from './instances';

export interface PickHit {
  kind: 'site' | 'vehicle';
  index: number;
}

/** Screen pixels the top bar and the timeline panel cover — the map is framed between them. */
const TOP_INSET_PX = 64;
const BOTTOM_INSET_PX = 176;
/** Default view direction from the orbit target to the camera (tilted, looking north). */
const VIEW_DIR = new THREE.Vector3(0, 42, 38).normalize();

export class MapScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly world: WorldSpec;
  private readonly siteLayer: SiteLayer;
  private readonly vehicleLayer: VehicleLayer;
  private readonly labels: SiteLabels;
  private readonly flowLines: FlowLine[] = [];
  /** flowLines[i] for i < routeLineCount is world.routes[i]; pipelines follow. */
  private routeLineCount = 0;
  /** False until the visitor moves the camera; until then resizes re-frame the map. */
  private userMoved = false;
  private readonly ring: THREE.Mesh;
  private readonly ringPivot: THREE.Group;
  /** Last snapshot the vehicle cargo colours were taken from. */
  private cargoSnap: Snapshot | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement, world: WorldSpec) {
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

    this.siteLayer = buildSiteLayer(world);
    this.scene.add(this.siteLayer.pads, this.siteLayer.rings, this.siteLayer.tanks);
    for (const glyphs of this.siteLayer.glyphs) this.scene.add(glyphs);

    this.vehicleLayer = buildVehicleLayer(world);
    for (const mesh of this.vehicleLayer.meshes) this.scene.add(mesh);

    // canvas is always in the DOM here; a detached canvas just gets an
    // off-screen host so labels exist but render nowhere
    const container = canvas.parentElement ?? document.createElement('div');
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

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(w / 2, 0, h / 2);
    this.controls.maxPolarAngle = Math.PI * 0.42; // tilt limit ~75°
    this.controls.minPolarAngle = Math.PI * 0.12;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 160;
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
    });
    this.controls.update();
  }

  /**
   * Frame the whole map between the top bar and the timeline: the closest
   * camera distance (along the default tilt) at which all four map corners
   * are on screen, with the map centred in the free band. Runs on every
   * resize until the visitor moves the camera.
   */
  private frameMap(height: number): void {
    const w = this.world.wKm * SCALE;
    const h = this.world.hKm * SCALE;
    const top = 1 - (2 * TOP_INSET_PX) / Math.max(1, height);
    const bottom = -1 + (2 * BOTTOM_INSET_PX) / Math.max(1, height);
    if (top - bottom < 0.2) return; // viewport too short to frame anything
    const side = 0.96;
    const corners = [[0, 0], [w, 0], [0, h], [w, h]];
    const v = new THREE.Vector3();
    const bounds = (dist: number, targetZ: number) => {
      this.camera.position.set(w / 2 + VIEW_DIR.x * dist, VIEW_DIR.y * dist, targetZ + VIEW_DIR.z * dist);
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
    bounds(dist, targetZ); // leaves the camera at the chosen pose
    this.controls.target.set(w / 2, 0, targetZ);
    this.controls.maxDistance = Math.max(160, dist * 1.6);
    this.labels.setMaxDistance(Math.max(90, dist * 1.8));
    this.controls.update();
  }

  /** Push a snapshot into the layers; `f` (0..1) interpolates from `prev`. */
  applySnapshot(cur: Snapshot, prev: Snapshot | null, f: number, selection: Selection): void {
    const selectedSite = selection !== null && selection.kind === 'site' ? selection.index : null;
    updateInstances(this.siteLayer, cur, prev, f, selectedSite);
    // closed routes (array 10) turn alarm red until they reopen
    for (let i = 0; i < this.routeLineCount && i < cur.edgeOpen.length; i++) {
      const line = this.flowLines[i];
      setFlowLineColor(line, cur.edgeOpen[i] === 0 ? V3.alarm : line.color);
    }
    const poses: { x: number; y: number; dirX: number; dirY: number }[] = [];
    for (let v = 0; v < cur.nVeh; v++) poses.push(lerpPose(this.world, cur, prev, v, f));
    updateVehicles(this.vehicleLayer, poses, (x, y) => surfaceYAt(this.world, x, y));
    if (cur !== this.cargoSnap) {
      updateVehicleCargo(this.vehicleLayer, this.world, cur);
      this.cargoSnap = cur;
    }
    this.syncRing(selection, poses);
  }

  private syncRing(selection: Selection, poses: { x: number; y: number }[]): void {
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
      if (pose === undefined) {
        this.ring.visible = false;
        return;
      }
      const [x, z] = mapToWorld(pose.x, pose.y);
      this.ringPivot.position.set(x, surfaceYAt(this.world, pose.x, pose.y) + 0.15, z);
      this.ring.scale.setScalar(1.2);
    }
    this.ring.visible = true;
  }

  /** Raycast the pointer against unit pads and vehicle meshes. */
  pick(clientX: number, clientY: number): PickHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      [this.siteLayer.pads, ...this.vehicleLayer.meshes],
      false,
    );
    for (const hit of hits) {
      if (hit.object === this.siteLayer.pads && hit.instanceId !== undefined) {
        return { kind: 'site', index: this.siteLayer.glyphSite[hit.instanceId] };
      }
      const meshIdx = this.vehicleLayer.meshes.indexOf(hit.object as THREE.InstancedMesh);
      if (meshIdx >= 0 && hit.instanceId !== undefined) {
        const index = this.vehicleLayer.members[meshIdx][hit.instanceId];
        if (index !== undefined) return { kind: 'vehicle', index };
      }
    }
    // Small pads on a large map miss raycasts by a few pixels — fall back
    // to the projected site centre within a click tolerance.
    const v = new THREE.Vector3();
    let bestSite = -1;
    let bestDist = 24; // px
    this.siteLayer.siteAnchors.forEach((anchor, i) => {
      v.set(anchor.x, anchor.topY + 0.85, anchor.z).project(this.camera);
      if (v.z > 1) return; // behind the camera
      const px = (v.x * 0.5 + 0.5) * rect.width;
      const py = (-v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(px - (clientX - rect.left), py - (clientY - rect.top));
      if (d < bestDist) {
        bestDist = d;
        bestSite = i;
      }
    });
    return bestSite >= 0 ? { kind: 'site', index: bestSite } : null;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.labels.setSize(width, height);
    resizeFlowLines(this.flowLines, width, height);
    if (!this.userMoved) this.frameMap(height);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.update(
      this.camera,
      this.controls.target.x,
      this.controls.target.y,
      this.controls.target.z,
    );
  }

  /** Advance flow-dash animation; dt in seconds. Kept for the render loop API. */
  animate(dtSec: number): void {
    tickFlowLines(this.flowLines, dtSec);
  }

  dispose(): void {
    this.labels.dispose();
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
