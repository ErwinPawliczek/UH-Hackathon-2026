// Site labels: the site's name above every site cluster, always on. Rendered
// with CSS2DRenderer so text stays crisp; the overlay and every label are
// pointer-events: none, so picking is untouched. Labels hide past a camera
// distance threshold to avoid clutter when zoomed out.
//
// Type per the v3 style: Mono 12px, uppercase, letter-spacing 0.14em, muted.

import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { WorldSpec } from '../engine/world';
import type { SiteAnchor } from './siteClusters';

/** Hide labels beyond this camera distance to the orbit target. */
const LABEL_MAX_DISTANCE = 90;

const LABEL_CSS =
  'font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;' +
  'font-size:12px;line-height:1;font-weight:500;text-transform:uppercase;' +
  'letter-spacing:0.14em;color:#5f656c;background:rgba(255,255,255,0.85);' +
  'border:1px solid #e4e7ea;border-radius:4px;padding:2px 5px 1px 6px;' +
  'pointer-events:none;white-space:nowrap;user-select:none;';

export class SiteLabels {
  private readonly renderer: CSS2DRenderer;
  private readonly group = new THREE.Group();
  private readonly labels: CSS2DObject[] = [];
  private readonly target = new THREE.Vector3();
  private scene: THREE.Scene | null = null;

  constructor(container: HTMLElement, world: WorldSpec, anchors: SiteAnchor[]) {
    this.renderer = new CSS2DRenderer();
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.inset = '0';
    this.renderer.domElement.style.pointerEvents = 'none';
    // the overlay is absolutely positioned — the host must be a positioning context
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.renderer.domElement);

    world.sites.forEach((site, s) => {
      const anchor = anchors[s];
      if (anchor === undefined) return;
      const el = document.createElement('span');
      el.className = 'site-label';
      el.style.cssText = LABEL_CSS;
      el.textContent = site.name;
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
    const visible = camera.position.distanceTo(this.target) <= LABEL_MAX_DISTANCE;
    for (const label of this.labels) label.visible = visible;
    this.renderer.render(this.scene, camera);
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  dispose(): void {
    this.renderer.domElement.remove();
  }
}
