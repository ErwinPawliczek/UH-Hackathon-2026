// Pipeline names: a small "<Material> pipeline" lying along each pipeline,
// about halfway, lined up with the line and set just beside it.
//
// The text is HTML over the canvas, so it stays crisp and the same size at
// any zoom; each frame it is moved to the pipeline's point on screen and
// turned to the direction the line runs there (never upside down). Where
// two pipelines share a stretch the name goes on a part only its own
// pipeline uses, and a name that would land on a site label or on another
// pipeline's name moves along its pipeline to the next best place, or hides
// until the view changes.

import * as THREE from 'three';
import type { PipelineSpec, WorldSpec } from '../engine/world';
import { mapToWorld } from './terrainMesh';

type Pt = [number, number];

/** A place a pipeline's name can go: map km, with the unit direction of the line there. */
export interface LabelSpot {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
}

/** Plain-words names; anything else is the material key in sentence case. */
const MATERIAL_WORDS: Record<string, string> = {
  CRUDE: 'Crude oil',
  RAW_GAS: 'Raw gas',
  METHANE: 'Methane',
  ETHANE: 'Ethane',
  ETHYLENE: 'Ethylene',
  PROPYLENE: 'Propylene',
  LPG: 'LPG',
  NAPHTHA: 'Naphtha',
  CHLORINE: 'Chlorine',
};

/** "Ethylene pipeline", "Crude oil pipeline", … */
export function pipelineName(material: string): string {
  const words =
    MATERIAL_WORDS[material] ??
    material.charAt(0) + material.slice(1).toLowerCase().replace(/_/g, ' ');
  return `${words} pipeline`;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

function distToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

/** Another pipeline within this many km makes a stretch shared. */
const SHARED_KM = 7;
/** Names keep this far (km) from a site, clear of its markers, bars and label. */
const SITE_CLEAR_KM = 22;
/** A straight run counts up to this many km either side of the spot. */
const STRAIGHT_CAP_KM = 30;
const STEP_KM = 2;

/**
 * The places each pipeline's name can go, best first. A good place is on a
 * stretch no other pipeline runs along, near the middle of the pipeline, on
 * a long straight run (so the text follows the line), and away from sites.
 */
export function pipelineLabelSpots(
  pipelines: Pick<PipelineSpec, 'points'>[],
  sites: { x: number; y: number }[],
  keep = 8,
): LabelSpot[][] {
  return pipelines.map((pipe, index) => {
    const pts = pipe.points;
    if (pts.length < 2) return [];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[cum.length - 1];
    if (total <= 0) return [];
    const scored: { spot: LabelSpot; score: number; arc: number }[] = [];
    for (let seg = 1; seg < pts.length; seg++) {
      const segLen = cum[seg] - cum[seg - 1];
      if (segLen <= 0) continue;
      const dirX = (pts[seg][0] - pts[seg - 1][0]) / segLen;
      const dirY = (pts[seg][1] - pts[seg - 1][1]) / segLen;
      const n = Math.max(1, Math.floor(segLen / STEP_KM));
      for (let k = 0; k <= n; k++) {
        const along = (segLen * (k + 0.5)) / (n + 1);
        const p: Pt = [pts[seg - 1][0] + dirX * along, pts[seg - 1][1] + dirY * along];
        const arc = cum[seg - 1] + along;
        const straight = Math.min(STRAIGHT_CAP_KM, along, segLen - along);
        let others = Infinity;
        pipelines.forEach((other, j) => {
          if (j !== index) others = Math.min(others, distToPolyline(p, other.points));
        });
        let site = Infinity;
        for (const s of sites) site = Math.min(site, Math.hypot(s.x - p[0], s.y - p[1]));
        let score = straight - 0.3 * Math.abs(arc - total / 2);
        if (others < SHARED_KM) score -= 200; // a shared stretch is the last resort
        if (site < SITE_CLEAR_KM) score -= 2 * (SITE_CLEAR_KM - site);
        scored.push({ spot: { x: p[0], y: p[1], dirX, dirY }, score, arc });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    // the best place, then alternatives well apart from the ones already chosen
    const chosen: typeof scored = [];
    for (const c of scored) {
      if (chosen.length >= keep) break;
      if (chosen.every((o) => Math.abs(o.arc - c.arc) > Math.max(8, total * 0.08))) chosen.push(c);
    }
    return chosen.map((c) => c.spot);
  });
}

const LABEL_CSS =
  'position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;user-select:none;' +
  'font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;' +
  'font-size:10.5px;line-height:1;font-weight:500;letter-spacing:0.03em;color:#3f454c;' +
  'text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff,0 0 4px #fff;will-change:transform;';

/** Pixels the text sits off the line, to the side it reads above. */
const OFFSET_PX = 8;
/** Text sizes to try, as a share of full size: a name shrinks before it hides. */
const SHRINK_STEPS = [1, 0.86, 0.74] as const;
/** Smallest share of full size a name is drawn at when the camera pulls back. */
const MIN_ZOOM_SCALE = 0.7;
/** Re-choose places every this many frames (the camera moves slowly against text size). */
const PLACE_EVERY = 8;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export class PipelineLabels {
  private readonly overlay: HTMLDivElement;
  private readonly items: { el: HTMLSpanElement; spots: LabelSpot[]; choice: number; width: number; scale: number }[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private width = 0;
  private height = 0;
  private frame = 0;

  constructor(
    private readonly container: HTMLElement,
    world: WorldSpec,
    /** world Y of the pipeline at a map point */
    private readonly heightAt: (xKm: number, yKm: number) => number,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pipeline-labels';
    this.overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.overlay);
    const spots = pipelineLabelSpots(world.pipelines, world.sites);
    world.pipelines.forEach((pipe, i) => {
      if (spots[i].length === 0) return;
      const el = document.createElement('span');
      el.className = 'pipeline-label';
      el.style.cssText = LABEL_CSS;
      el.textContent = pipelineName(pipe.material);
      el.style.visibility = 'hidden';
      this.overlay.appendChild(el);
      this.items.push({ el, spots: spots[i], choice: 0, width: 0, scale: 1 });
    });
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.frame = 0;
  }

  /** Screen position and angle of a spot, or null when it is off screen or behind the camera. */
  private project(spot: LabelSpot, camera: THREE.Camera): { x: number; y: number; angle: number } | null {
    const reach = 3; // km either side of the spot, to read the line's direction on screen
    const [ax, az] = mapToWorld(spot.x - spot.dirX * reach, spot.y - spot.dirY * reach);
    const [bx, bz] = mapToWorld(spot.x + spot.dirX * reach, spot.y + spot.dirY * reach);
    this.a.set(ax, this.heightAt(spot.x - spot.dirX * reach, spot.y - spot.dirY * reach), az).project(camera);
    this.b.set(bx, this.heightAt(spot.x + spot.dirX * reach, spot.y + spot.dirY * reach), bz).project(camera);
    if (this.a.z > 1 || this.b.z > 1) return null;
    const x0 = (this.a.x * 0.5 + 0.5) * this.width;
    const y0 = (-this.a.y * 0.5 + 0.5) * this.height;
    const x1 = (this.b.x * 0.5 + 0.5) * this.width;
    const y1 = (-this.b.y * 0.5 + 0.5) * this.height;
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    if (x < -40 || y < -40 || x > this.width + 40 || y > this.height + 40) return null;
    let angle = Math.atan2(y1 - y0, x1 - x0);
    // never upside down: read left to right
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle <= -Math.PI / 2) angle += Math.PI;
    return { x, y, angle };
  }

  /**
   * The screen area a label of `width` px would cover at a projected spot, as
   * a few small boxes along the text — one box round slanted text would
   * claim far more of the screen than the text does.
   */
  private static boxes(p: { x: number; y: number; angle: number }, width: number, scale = 1): Rect[] {
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    // the text sits OFFSET_PX off the line, on its upper side
    const cx = p.x + sin * OFFSET_PX;
    const cy = p.y - cos * OFFSET_PX;
    const parts = Math.max(1, Math.round(width / 22));
    const half = 8 * scale;
    const out: Rect[] = [];
    for (let i = 0; i < parts; i++) {
      const along = ((i + 0.5) / parts - 0.5) * width;
      const x = cx + cos * along;
      const y = cy + sin * along;
      out.push({ x0: x - half - 3, y0: y - half, x1: x + half + 3, y1: y + half });
    }
    return out;
  }

  /** Move every name to its pipeline on screen; call once per rendered frame. */
  update(camera: THREE.Camera, zoom = 1): void {
    if (this.width <= 0 || this.height <= 0) return;
    // pulled back, the map is smaller on screen: the names shrink with it (never grow past full size)
    const zoomScale = Math.min(1, Math.max(MIN_ZOOM_SCALE, zoom));
    const replace = this.frame++ % PLACE_EVERY === 0;
    let taken: Rect[] = [];
    if (replace) {
      // site labels are laid out by the scene's own overlay: keep clear of the ones showing
      const host = this.container.getBoundingClientRect();
      taken = Array.from(this.container.querySelectorAll<HTMLElement>('.site-label'))
        .filter((el) => el.style.display !== 'none' && el.offsetWidth > 0)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x0: r.left - host.left - 2, y0: r.top - host.top - 2, x1: r.right - host.left + 2, y1: r.bottom - host.top + 2 };
        });
    }
    for (const item of this.items) {
      if (replace) {
        const full = item.el.offsetWidth || 7 * (item.el.textContent?.length ?? 12);
        let picked = -1;
        // full size first; a name that fits nowhere tries again smaller before it hides
        shrink: for (const step of SHRINK_STEPS) {
          const scale = step * zoomScale;
          for (let c = 0; c < item.spots.length; c++) {
            const p = this.project(item.spots[c], camera);
            if (p === null) continue;
            const boxes = PipelineLabels.boxes(p, full * scale, scale);
            if (boxes.some((box) => taken.some((t) => overlaps(box, t)))) continue;
            taken.push(...boxes);
            picked = c;
            item.scale = scale;
            item.width = full * scale;
            break shrink;
          }
        }
        item.choice = picked;
      }
      const p = item.choice >= 0 ? this.project(item.spots[item.choice], camera) : null;
      if (p === null) {
        item.el.style.visibility = 'hidden';
        continue;
      }
      item.el.style.visibility = 'visible';
      item.el.style.transform =
        `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-50%) ` +
        `rotate(${p.angle.toFixed(4)}rad) translate(0,${-OFFSET_PX}px) scale(${item.scale.toFixed(3)})`;
    }
  }

  dispose(): void {
    this.overlay.remove();
  }
}
