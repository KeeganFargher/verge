import { Group, Mesh, MeshBasicMaterial, type BufferGeometry, type Vector2 } from 'three';
import { layer } from './layers';
import { MeshBuilder, ribbon } from './meshing';

const H = 0.09;

/**
 * Editor feedback drawn on the ground: hover and selection highlights, the road being drawn,
 * snap handles, the calibration ruler. Each named slot holds one mesh that is replaced as the
 * thing it shows changes.
 */
export class OverlayView {
  readonly group = new Group();
  private readonly slots = new Map<string, Mesh<BufferGeometry, MeshBasicMaterial>>();

  private put(name: string, mb: MeshBuilder, color: number, opacity: number, order: number): void {
    this.clear(name);
    if (mb.empty) return;
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
      ...layer('overlay'),
    });
    const mesh = new Mesh(mb.build(), material);
    mesh.renderOrder = order;
    this.slots.set(name, mesh);
    this.group.add(mesh);
  }

  clear(name: string): void {
    const old = this.slots.get(name);
    if (old === undefined) return;
    this.group.remove(old);
    old.geometry.dispose();
    old.material.dispose();
    this.slots.delete(name);
  }

  /** A strip along a polyline, `halfWidth` either side. */
  strip(name: string, points: readonly Vector2[], halfWidth: number, color: number, opacity: number, order = 2): void {
    const mb = new MeshBuilder();
    if (points.length >= 2) ribbon(mb, points, -halfWidth, halfWidth, H + order * 0.005);
    this.put(name, mb, color, opacity, order);
  }

  /** An annulus around a point. */
  ring(name: string, center: Vector2, inner: number, outer: number, color: number, opacity: number, order = 2): void {
    const mb = new MeshBuilder();
    const n = 64;
    const h = H + order * 0.005;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = [
        mb.vertex(center.x + Math.cos(a0) * inner, center.y + Math.sin(a0) * inner, h),
        mb.vertex(center.x + Math.cos(a0) * outer, center.y + Math.sin(a0) * outer, h),
        mb.vertex(center.x + Math.cos(a1) * outer, center.y + Math.sin(a1) * outer, h),
        mb.vertex(center.x + Math.cos(a1) * inner, center.y + Math.sin(a1) * inner, h),
      ];
      mb.tri(p[0], p[1], p[2]);
      mb.tri(p[0], p[2], p[3]);
    }
    this.put(name, mb, color, opacity, order);
  }

  /** Filled discs at several points (snap handles, ruler ends). */
  discs(name: string, centers: readonly Vector2[], radius: number, color: number, opacity: number, order = 3): void {
    const mb = new MeshBuilder();
    const n = 24;
    const h = H + order * 0.005;
    for (const c of centers) {
      const mid = mb.vertex(c.x, c.y, h);
      let prev = mb.vertex(c.x + radius, c.y, h);
      for (let i = 1; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const cur = mb.vertex(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius, h);
        mb.tri(mid, prev, cur);
        prev = cur;
      }
    }
    this.put(name, mb, color, opacity, order);
  }
}
