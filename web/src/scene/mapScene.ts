// MapScene: three.js scene assembly and frame driver — terrain, draped
// routes/pipelines, instanced sites/vehicles, map camera with OrbitControls,
// click-picking for sites and vehicles, and a selection ring. The React
// component only feeds it snapshots and forwards pointer events.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Selection } from '../store/sim';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { buildTerrain, terrainYAt, mapToWorld, SCALE } from './terrainMesh';
import { buildFlowLine, tickFlowLines, type FlowLine } from './lines';
import { EDGE_COLORS } from './palette';
import {
  buildSiteLayer, buildVehicleLayer, lerpPose, updateInstances, updateVehicles,
  type SiteLayer, type VehicleLayer,
} from './instances';

export interface PickHit {
  kind: 'site' | 'vehicle';
  index: number;
}

const ROUTE_STYLE: Record<string, { color: number; dash: number; gap: number }> = {
  road: { color: EDGE_COLORS.road, dash: 0.6, gap: 0.3 },
  river: { color: EDGE_COLORS.river, dash: 0.9, gap: 0.15 },
  sea: { color: EDGE_COLORS.sea, dash: 1.2, gap: 0.4 },
};

export class MapScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly world: WorldSpec;
  private readonly siteLayer: SiteLayer;
  private readonly vehicleLayer: VehicleLayer;
  private readonly flowLines: FlowLine[] = [];
  private readonly ring: THREE.Mesh;
  private readonly ringPivot: THREE.Group;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement, world: WorldSpec) {
    this.world = world;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1220);
    this.scene.fog = new THREE.Fog(0x0b1220, 90, 220);

    const w = world.wKm * SCALE;
    const h = world.hKm * SCALE;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 600);
    this.camera.position.set(w / 2, 42, h / 2 + 38);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x1a2433, 1.1));
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.6);
    sun.position.set(-40, 60, 30);
    this.scene.add(sun);

    this.scene.add(buildTerrain(world));

    for (const route of world.routes) {
      const style = ROUTE_STYLE[route.mode] ?? ROUTE_STYLE.road;
      const flow = buildFlowLine(route.points, world.terrain, { ...style, speed: 0, lift: 0.08 });
      this.flowLines.push(flow);
      this.scene.add(flow.line);
    }
    for (const pipe of world.pipelines) {
      const flow = buildFlowLine(pipe.points, world.terrain, {
        color: EDGE_COLORS.pipeline, dash: 0.5, gap: 0.45, speed: 2.5, lift: 0.12, opacity: 0.95,
      });
      this.flowLines.push(flow);
      this.scene.add(flow.line);
    }

    this.siteLayer = buildSiteLayer(world);
    this.scene.add(this.siteLayer.glyphs, this.siteLayer.tanks);
    this.vehicleLayer = buildVehicleLayer(world);
    for (const mesh of this.vehicleLayer.meshes) this.scene.add(mesh);

    // selection ring: flat annulus, nudged to the picked entity each frame
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
    );
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
    this.controls.update();
  }

  /** Push a snapshot into the layers; `f` (0..1) interpolates from `prev`. */
  applySnapshot(cur: Snapshot, prev: Snapshot | null, f: number, selection: Selection): void {
    updateInstances(this.siteLayer, cur, prev, f);
    const poses: { x: number; y: number; dirX: number; dirY: number }[] = [];
    for (let v = 0; v < cur.nVeh; v++) poses.push(lerpPose(cur, prev, v, f));
    updateVehicles(this.vehicleLayer, poses, (x, y) => terrainYAt(this.world, x, y));
    this.syncRing(selection, poses);
  }

  private syncRing(selection: Selection, poses: { x: number; y: number }[]): void {
    if (selection === null) {
      this.ring.visible = false;
      return;
    }
    let xKm: number;
    let yKm: number;
    let groundY: number;
    if (selection.kind === 'site') {
      const site = this.world.sites[selection.index];
      if (site === undefined) {
        this.ring.visible = false;
        return;
      }
      xKm = site.x;
      yKm = site.y;
      groundY = terrainYAt(this.world, xKm, yKm);
      this.ring.scale.setScalar(2.4);
    } else {
      const pose = poses[selection.index];
      if (pose === undefined) {
        this.ring.visible = false;
        return;
      }
      xKm = pose.x;
      yKm = pose.y;
      groundY = terrainYAt(this.world, xKm, yKm);
      this.ring.scale.setScalar(1.2);
    }
    const [x, z] = mapToWorld(xKm, yKm);
    this.ringPivot.position.set(x, groundY + 0.15, z);
    this.ring.visible = true;
  }

  /** Raycast the pointer against site glyphs and vehicle meshes. */
  pick(clientX: number, clientY: number): PickHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      [this.siteLayer.glyphs, ...this.vehicleLayer.meshes],
      false,
    );
    for (const hit of hits) {
      if (hit.object === this.siteLayer.glyphs && hit.instanceId !== undefined) {
        return { kind: 'site', index: this.siteLayer.glyphSite[hit.instanceId] };
      }
      const meshIdx = this.vehicleLayer.meshes.indexOf(hit.object as THREE.InstancedMesh);
      if (meshIdx >= 0 && hit.instanceId !== undefined) {
        return { kind: 'vehicle', index: this.vehicleLayer.classStart[meshIdx] + hit.instanceId };
      }
    }
    return null;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Advance flow-dash animation; dt in seconds. */
  animate(dtSec: number): void {
    tickFlowLines(this.flowLines, dtSec);
  }

  dispose(): void {
    this.controls.dispose();
    this.scene.traverse((obj) => {
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
