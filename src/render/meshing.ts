import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';

/**
 * Collects flat, upward-facing triangles in plan coordinates (x, y) at given heights and turns
 * them into one BufferGeometry. Plan y maps to world z. Every triangle is wound to face up,
 * whatever order the caller passes its corners in.
 */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly indices: number[] = [];

  vertex(x: number, y: number, h: number, nx = 0, ny = 1, nz = 0): number {
    this.positions.push(x, h, y);
    this.normals.push(nx, ny, nz);
    return this.positions.length / 3 - 1;
  }

  /** Triangle facing up (+world y). */
  tri(a: number, b: number, c: number): void {
    const p = this.positions;
    const ux = p[b * 3] - p[a * 3];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    if (uz * vx - ux * vz >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  /** Triangle with explicit winding (for vertical faces). */
  rawTri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    return g;
  }
}

/** Unit normals (right of travel) at each point of a polyline, averaged at joints so ribbons don't crack. */
export function pointNormals(points: readonly Vector2[]): Vector2[] {
  const n = points.length;
  const out: Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    // Coincident neighbours leave the direction undefined; dividing would quietly emit NaN vertices.
    if (len === 0) throw new Error(`Polyline has no direction at point ${i} of ${n}: its neighbours coincide`);
    out.push(new Vector2(-dy / len, dx / len));
  }
  return out;
}

/** Strip along a polyline between lateral offsets `from` and `to` (positive = right of travel). */
export function ribbon(mb: MeshBuilder, points: readonly Vector2[], from: number, to: number, h: number): void {
  const normals = pointNormals(points);
  let prevA = -1;
  let prevB = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const n = normals[i];
    const a = mb.vertex(p.x + n.x * from, p.y + n.y * from, h);
    const b = mb.vertex(p.x + n.x * to, p.y + n.y * to, h);
    if (i > 0) {
      mb.tri(prevA, prevB, a);
      mb.tri(prevB, b, a);
    }
    prevA = a;
    prevB = b;
  }
}

/** Vertical face along a polyline at a lateral offset, from height h0 up to h1 (a kerb). */
export function wall(mb: MeshBuilder, points: readonly Vector2[], offset: number, h0: number, h1: number, facing: 1 | -1): void {
  const normals = pointNormals(points);
  let prevLow = -1;
  let prevHigh = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const n = normals[i];
    const x = p.x + n.x * offset;
    const y = p.y + n.y * offset;
    const nx = -n.x * facing;
    const nz = -n.y * facing;
    const low = mb.vertex(x, y, h0, nx, 0, nz);
    const high = mb.vertex(x, y, h1, nx, 0, nz);
    if (i > 0) {
      if (facing === 1) {
        mb.rawTri(prevLow, prevHigh, low);
        mb.rawTri(prevHigh, high, low);
      } else {
        mb.rawTri(prevLow, low, prevHigh);
        mb.rawTri(prevHigh, low, high);
      }
    }
    prevLow = low;
    prevHigh = high;
  }
}

/** Filled polygon (any simple outline, convex or not). */
export function polygon(mb: MeshBuilder, outline: readonly Vector2[], h: number): void {
  if (outline.length < 3) return;
  const pts = outline.map((p) => p.clone());
  const tris = ShapeUtils.triangulateShape(pts, []);
  const base = pts.map((p) => mb.vertex(p.x, p.y, h));
  for (const [a, b, c] of tris) mb.tri(base[a], base[b], base[c]);
}

/** Dashed line along a polyline. */
export function dashed(mb: MeshBuilder, points: readonly Vector2[], offset: number, width: number, dash: number, gap: number, h: number): void {
  const segs = resampleAlong(points);
  let s = gap / 2;
  while (s < segs.length) {
    const e = Math.min(s + dash, segs.length);
    // A piece shorter than the line is wide is a sliver where the line ends, not a dash.
    if (e - s >= width) ribbon(mb, segs.slice(s, e), offset - width / 2, offset + width / 2, h);
    s = e + gap;
  }
}

/** Arc-length lookup over a polyline, sliceable by distance. */
function resampleAlong(points: readonly Vector2[]) {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  const length = cum[cum.length - 1];
  const at = (s: number) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    return points[i - 1].clone().lerp(points[i], Math.min(1, Math.max(0, t)));
  };
  return {
    length,
    slice(from: number, to: number): Vector2[] {
      const out = [at(from)];
      // A vertex within a micrometre of a cut is the cut itself; keeping both would be a zero-length step.
      const eps = 1e-6;
      for (let i = 0; i < cum.length; i++) if (cum[i] > from + eps && cum[i] < to - eps) out.push(points[i].clone());
      out.push(at(to));
      return out;
    },
  };
}
