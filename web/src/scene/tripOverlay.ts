// The selected vehicle's trip, drawn over the network: the way still ahead of
// it as a heavy blue line, and a ring round the site it loaded at and the
// site it is going to. The trip itself (who ordered what, the path along the
// route polylines) is fetched by the UI and handed in; this only draws it.
//
// The line is built once per fetched path and shortened from the vehicle's
// end as the vehicle moves, so it always starts at the vehicle as drawn.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { V3 } from './palette';
import { LINE_RENDER_ORDER } from './renderOrder';
import type { SiteAnchor } from './siteClusters';
import { mapToWorld } from './terrainMesh';

type Pt = [number, number];

/** What the scene needs of the selected vehicle's trip (the UI's record carries more). */
export interface VehicleTrip {
  /** fleet index of the vehicle */
  index: number;
  /** the order it is serving: where the cargo comes from and goes to */
  order?: { from?: { site?: number | null } | null; to?: { site?: number | null } | null } | null;
  /** where its current leg ends, when it has no order to read that from */
  legDestination?: { site?: number | null } | null;
  /** km points from the vehicle to the end of its current leg, along the routes */
  path?: Pt[] | null;
}

/** Longest stretch (km) between two points of the drawn line — the grain it shortens by. */
const GRAIN_KM = 2;

/** A path cut into steps of at most `grain` km, keeping every corner. */
export function densify(path: Pt[], grain = GRAIN_KM): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const [ax, ay] = path[i - 1];
      const [bx, by] = path[i];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / grain);
      for (let k = 1; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    out.push(path[i]);
  }
  return out;
}

/**
 * How many points of `pts` the vehicle at (x, y) has passed: the index of
 * the point nearest to it, looking only a little ahead of where it last was
 * so a path that doubles back does not skip.
 */
export function passedIndex(pts: Pt[], x: number, y: number, from: number, window = 40): number {
  let best = from;
  let bestD = Infinity;
  const end = Math.min(pts.length - 1, from + window);
  for (let i = from; i <= end; i++) {
    const d = Math.hypot(pts[i][0] - x, pts[i][1] - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function ring(inner: number, color: number, opacity: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, 1.02, 6).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
  );
  mesh.rotation.y = Math.PI / 6; // corners in line with the hex pads
  mesh.renderOrder = 2;
  mesh.visible = false;
  return mesh;
}

export class TripOverlay {
  private readonly group = new THREE.Group();
  private readonly material: LineMaterial;
  private line: Line2 | null = null;
  /** the path as drawn, from the vehicle to the end of its leg */
  private pts: Pt[] = [];
  private passed = 0;
  private shownTrip: VehicleTrip | null = null;
  /** where the cargo was loaded: a thin ring; where it is going: a heavy one */
  private readonly origin = ring(0.93, V3.blue, 0.9);
  private readonly destination = ring(0.8, V3.blue, 0.95);

  constructor(
    scene: THREE.Scene,
    private readonly anchors: SiteAnchor[],
  ) {
    this.material = new LineMaterial({
      color: V3.blue,
      linewidth: 4,
      worldUnits: false,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.group.add(this.origin, this.destination);
    scene.add(this.group);
  }

  resize(width: number, height: number): void {
    this.material.resolution.set(width, height);
  }

  private placeRing(mesh: THREE.Mesh, site: number | null | undefined): void {
    const anchor = site === null || site === undefined ? undefined : this.anchors[site];
    if (anchor === undefined) {
      mesh.visible = false;
      return;
    }
    mesh.position.set(anchor.x, anchor.topY + 0.04, anchor.z);
    mesh.scale.setScalar((anchor.clusterR + 0.32) / 1.02);
    mesh.visible = true;
  }

  private clearLine(): void {
    if (this.line !== null) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
      this.line = null;
    }
    this.pts = [];
    this.passed = 0;
  }

  /**
   * Show `trip` (null hides everything). `pose` is where the vehicle is
   * drawn this frame, in map km; `heightAt` the world Y its lane lies at.
   */
  update(
    trip: VehicleTrip | null,
    pose: { x: number; y: number } | null,
    heightAt: (xKm: number, yKm: number) => number,
  ): void {
    if (trip === null || pose === null) {
      if (this.shownTrip !== null) {
        this.clearLine();
        this.origin.visible = false;
        this.destination.visible = false;
        this.shownTrip = null;
      }
      return;
    }
    if (trip !== this.shownTrip) {
      this.shownTrip = trip;
      this.clearLine();
      const from = trip.order?.from?.site;
      const to = trip.order?.to?.site ?? trip.legDestination?.site;
      this.placeRing(this.origin, from === to ? null : from);
      this.placeRing(this.destination, to);
      const path = (trip.path ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (path.length >= 2) {
        this.pts = densify(path);
        // stored from the far end back to the vehicle, so drawing fewer
        // segments shortens the line at the vehicle's end
        const positions: number[] = [];
        for (let i = this.pts.length - 1; i >= 0; i--) {
          const [x, z] = mapToWorld(this.pts[i][0], this.pts[i][1]);
          positions.push(x, heightAt(this.pts[i][0], this.pts[i][1]) + 0.12, z);
        }
        const geometry = new LineGeometry();
        geometry.setPositions(positions);
        this.line = new Line2(geometry, this.material);
        this.line.renderOrder = LINE_RENDER_ORDER + 0.8; // above routes and pipelines
        this.line.frustumCulled = false;
        this.group.add(this.line);
      }
    }
    if (this.line !== null) {
      this.passed = passedIndex(this.pts, pose.x, pose.y, this.passed);
      const segments = this.pts.length - 1 - this.passed;
      this.line.geometry.instanceCount = Math.max(0, segments);
      this.line.visible = segments > 0;
    }
  }

  dispose(): void {
    this.clearLine();
    this.material.dispose();
  }
}
