// Site labels: above every site cluster, always on, a small hexagon badge
// with the icon of the site's kind (ui/siteIcons) and the site's name. The
// badge also carries the plant's state: alarm red with a white icon while a
// plant is shut down, a red outline while it restarts, blue while it holds
// at minimum. Rendered with CSS2DRenderer so text stays crisp; the overlay
// and every label are pointer-events: none; the scene's picking reads the label boxes
// (data-site) so a click on a badge or a name selects that site. Labels hide past a camera
// distance threshold to avoid clutter when zoomed out, and a label that
// would cover a neighbour's steps one row up or down (or hides if no row is
// free) so a dense corner of the map stays readable.
//
// Type per the v3 style: Mono 12px, uppercase, letter-spacing 0.14em, muted.

import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { WorldSpec } from '../engine/world';
import { useSim } from '../store/sim';
import { siteBadgeSvg } from '../ui/siteIcons';
import type { SiteAnchor } from './siteClusters';

/** Hide labels beyond this camera distance to the orbit target (default; see setMaxDistance). */
const LABEL_MAX_DISTANCE = 90;
/** Re-place labels every this many frames — the camera moves slowly against label size. */
const DECLUTTER_EVERY = 6;
/** Rows a label may take, in label heights above its anchor, in order of preference. */
const LABEL_ROWS = [0, 1, -1, 2, -2] as const;
/** Icon size inside a label's badge, in pixels. */
const BADGE_ICON_PX = 16;

const LABEL_CSS =
  'font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;' +
  'font-size:12px;line-height:1;font-weight:500;text-transform:uppercase;' +
  'letter-spacing:0.14em;color:#5f656c;background:rgba(255,255,255,0.85);' +
  'border:1px solid #e4e7ea;border-radius:4px;padding:1px 7px 1px 2px;' +
  'display:inline-flex;align-items:center;gap:5px;white-space:nowrap;';

/**
 * Label look per site state (the snapshot's site status: 0 running, 1/2
 * holding, 3 shut down, 4 restarting), as CSS custom properties the badge
 * SVG reads, plus the label's own border and text colour.
 */
const STATE_STYLE: Record<number, { fill: string; line: string; ink: string; accent: string; border: string; text: string }> = {
  0: { fill: '#ffffff', line: '#0a0a0a', ink: '#0a0a0a', accent: '#1764d6', border: '#e4e7ea', text: '#5f656c' },
  1: { fill: '#e8f0fc', line: '#1764d6', ink: '#0a0a0a', accent: '#1764d6', border: '#79aef2', text: '#5f656c' },
  2: { fill: '#e8f0fc', line: '#1764d6', ink: '#0a0a0a', accent: '#1764d6', border: '#79aef2', text: '#5f656c' },
  3: { fill: '#d1372f', line: '#d1372f', ink: '#ffffff', accent: '#ffffff', border: '#d1372f', text: '#d1372f' },
  4: { fill: '#ffffff', line: '#d1372f', ink: '#0a0a0a', accent: '#d1372f', border: '#d1372f', text: '#5f656c' },
  // limited: running, but with its output or demand cut by a shock — blue like holding, with blue text to set it apart from running
  5: { fill: '#e8f0fc', line: '#1764d6', ink: '#0a0a0a', accent: '#1764d6', border: '#1764d6', text: '#1764d6' },
};

export class SiteLabels {
  private readonly renderer: CSS2DRenderer;
  private readonly group = new THREE.Group();
  private readonly labels: CSS2DObject[] = [];
  private readonly target = new THREE.Vector3();
  private scene: THREE.Scene | null = null;
  private maxDistance = LABEL_MAX_DISTANCE;
  private width = 0;
  private height = 0;
  private frame = 0;
  private readonly projected = new THREE.Vector3();
  /** Site index of each label, and the state its badge currently shows. */
  private readonly labelSite: number[] = [];
  private readonly shown: number[] = [];
  /** The styled box inside each label: badge and name in a row. */
  private readonly boxes: HTMLElement[] = [];

  constructor(container: HTMLElement, world: WorldSpec, anchors: SiteAnchor[]) {
    this.renderer = new CSS2DRenderer();
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.inset = '0';
    this.renderer.domElement.style.pointerEvents = 'none';
    // CSS2DRenderer gives every label its own z-index by depth; without a
    // stacking context of its own the overlay lets near labels climb above
    // the inspector and timeline panels.
    this.renderer.domElement.style.zIndex = '0';
    // the overlay is absolutely positioned — the host must be a positioning context
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.renderer.domElement);

    world.sites.forEach((site, s) => {
      const anchor = anchors[s];
      if (anchor === undefined) return;
      const el = document.createElement('span');
      el.className = 'site-label';
      el.dataset.site = String(s);
      el.style.cssText = 'pointer-events:none;user-select:none;';
      // CSS2DRenderer owns the root element's display (it toggles it to hide
      // a label), so the row layout lives on a box inside it: the badge (a
      // trusted SVG string from the icon set), then the name as text.
      const box = document.createElement('span');
      box.style.cssText = LABEL_CSS;
      box.innerHTML = siteBadgeSvg(site.preset, BADGE_ICON_PX);
      const name = document.createElement('span');
      name.textContent = site.name;
      box.appendChild(name);
      el.appendChild(box);
      this.boxes.push(box);
      this.labelSite.push(s);
      this.shown.push(0);
      const label = new CSS2DObject(el);
      // anchor above the cluster, clear of the raised pads and glyphs
      label.position.set(anchor.x, anchor.topY + 0.85, anchor.z);
      label.visible = false;
      this.labels.push(label);
      this.group.add(label);
    });
  }

  /** Attach the label group to the scene. */
  addTo(scene: THREE.Scene): void {
    this.scene = scene;
    scene.add(this.group);
  }

  /** Toggle visibility by camera distance and redraw the overlay. */
  update(camera: THREE.Camera, targetX: number, targetY: number, targetZ: number): void {
    if (this.scene === null) return;
    this.target.set(targetX, targetY, targetZ);
    this.syncStates();
    const visible = camera.position.distanceTo(this.target) <= this.maxDistance;
    if (!visible) {
      for (const label of this.labels) label.visible = false;
    } else if (this.frame++ % DECLUTTER_EVERY === 0) {
      this.declutter(camera);
    }
    this.renderer.render(this.scene, camera);
  }

  /** Restyle the badges whose site changed state since the last frame. */
  private syncStates(): void {
    const status = useSim.getState().snap?.siteStatus;
    if (status === undefined) return;
    for (let i = 0; i < this.labels.length; i++) {
      const state = status[this.labelSite[i]] ?? 0;
      if (state === this.shown[i]) continue;
      this.shown[i] = state;
      const look = STATE_STYLE[state] ?? STATE_STYLE[0];
      const el = this.boxes[i];
      el.style.setProperty('--badge-fill', look.fill);
      el.style.setProperty('--badge-line', look.line);
      el.style.setProperty('--icon-ink', look.ink);
      el.style.setProperty('--icon-accent', look.accent);
      el.style.borderColor = look.border;
      el.style.color = look.text;
    }
  }

  /**
   * Labels stay on up to this camera distance. The scene raises it to cover
   * its framed whole-map view, which on a narrow window sits further back
   * than the default threshold.
   */
  setMaxDistance(distance: number): void {
    this.maxDistance = distance;
  }

  /**
   * Place labels without overlap: nearest sites first, each label takes the
   * first free row among its own position, one row up, one row down, two
   * rows up and two rows down; a label with no free row is hidden until the
   * view changes.
   */
  private declutter(camera: THREE.Camera): void {
    const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const order = this.labels
      .map((label, i) => {
        this.projected.copy(label.position).project(camera);
        return { i, x: this.projected.x, y: this.projected.y, z: this.projected.z };
      })
      .sort((a, b) => a.z - b.z); // nearest to the camera first
    for (const p of order) {
      const label = this.labels[p.i];
      if (p.z > 1 || Math.abs(p.x) > 1.2 || Math.abs(p.y) > 1.2) {
        label.visible = false;
        continue;
      }
      const el = label.element;
      // jsdom and not-yet-laid-out labels report 0: fall back to an estimate
      const w = el.offsetWidth || 42 + 9 * (el.textContent?.length ?? 8);
      const h = el.offsetHeight || 26;
      const cx = (p.x * 0.5 + 0.5) * this.width;
      const cy = (-p.y * 0.5 + 0.5) * this.height;
      let placed = false;
      for (const row of LABEL_ROWS) {
        const y = cy - row * (h + 2);
        const box = { x0: cx - w / 2 - 3, y0: y - h / 2 - 1, x1: cx + w / 2 + 3, y1: y + h / 2 + 1 };
        if (boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
        boxes.push(box);
        // CSS2DObject.center is in label heights: 0.5 centres it on the anchor
        label.center.set(0.5, 0.5 + row * ((h + 2) / h));
        placed = true;
        break;
      }
      label.visible = placed;
    }
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.frame = 0; // re-place on the next frame
    this.renderer.setSize(width, height);
  }

  dispose(): void {
    this.renderer.domElement.remove();
  }
}
