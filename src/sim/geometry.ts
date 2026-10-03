import { CubicBezierCurve, Vector2, type Curve } from 'three';

/*
 * Plan coordinates are screen-like: x grows east and y grows south (y maps to world z).
 * Every "left/right", "clockwise" and "near/far side" computation in the simulation is
 * written against that convention, so keep it in mind when reading cross products:
 * cross(a, b) > 0 means b points to the right of (clockwise from) a.
 */

export interface Pose {
  x: number;
  y: number;
  /** Unit tangent in the direction of travel. */
  tx: number;
  ty: number;
}

export function makePose(): Pose {
  return { x: 0, y: 0, tx: 1, ty: 0 };
}

export function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wraps an angle into [0, 2π). */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}

/**
 * Polyline with cumulative arc length. It is the single geometry type vehicles move on:
 * every lane, turn path and ring arc is sampled into one of these, so the hot simulation
 * loop only ever does a binary search plus a lerp.
 */
export class Path {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;

  constructor(points: readonly Vector2[]) {
    const pts: Vector2[] = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (last === undefined || last.distanceTo(p) > 1e-6) pts.push(p);
    }
    if (pts.length < 2) throw new Error('Path needs at least two distinct points');
    const n = pts.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.cum = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i > 0) acc += p.distanceTo(pts[i - 1]);
      this.xs[i] = p.x;
      this.ys[i] = p.y;
      this.cum[i] = acc;
    }
    this.length = acc;
  }

  get pointCount(): number {
    return this.xs.length;
  }

  /** Index i of the segment [i, i+1] containing arc length s (clamped to the first/last segment). */
  segmentIndex(s: number): number {
    const cum = this.cum;
    const last = cum.length - 2;
    if (s <= 0) return 0;
    if (s >= this.length) return last;
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Position and tangent at arc length s. Outside [0, length] it extrapolates along the end
   * tangent on purpose: vehicle bodies overhang the start of the track they just entered.
   */
  pose(s: number, out: Pose): Pose {
    const i = this.segmentIndex(s);
    const x0 = this.xs[i];
    const y0 = this.ys[i];
    const dx = this.xs[i + 1] - x0;
    const dy = this.ys[i + 1] - y0;
    const seg = this.cum[i + 1] - this.cum[i];
    const tx = dx / seg;
    const ty = dy / seg;
    const d = s - this.cum[i];
    out.x = x0 + tx * d;
    out.y = y0 + ty * d;
    out.tx = tx;
    out.ty = ty;
    return out;
  }

  pointAt(s: number): Vector2 {
    const p = this.pose(s, makePose());
    return new Vector2(p.x, p.y);
  }

  /** Closest point on the polyline to (px, py). */
  closest(px: number, py: number): { s: number; distance: number } {
    let best = Infinity;
    let bestS = 0;
    const n = this.xs.length;
    for (let i = 0; i < n - 1; i++) {
      const x0 = this.xs[i];
      const y0 = this.ys[i];
      const dx = this.xs[i + 1] - x0;
      const dy = this.ys[i + 1] - y0;
      const len2 = dx * dx + dy * dy;
      const t = clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1);
      const cx = x0 + dx * t;
      const cy = y0 + dy * t;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      if (d2 < best) {
        best = d2;
        bestS = this.cum[i] + t * Math.sqrt(len2);
      }
    }
    return { s: bestS, distance: Math.sqrt(best) };
  }

  points(): Vector2[] {
    const out: Vector2[] = [];
    for (let i = 0; i < this.xs.length; i++) out.push(new Vector2(this.xs[i], this.ys[i]));
    return out;
  }

  /** Evenly spaced samples (inclusive of both ends), used for conflict detection and meshing. */
  resample(step: number): Vector2[] {
    const n = Math.max(1, Math.ceil(this.length / step));
    const out: Vector2[] = [];
    const pose = makePose();
    for (let i = 0; i <= n; i++) {
      this.pose((this.length * i) / n, pose);
      out.push(new Vector2(pose.x, pose.y));
    }
    return out;
  }
}

/**
 * Samples a curve between two arc lengths with a constant lateral offset (positive = right of
 * travel). Sampling from a larger to a smaller arc length walks the curve backwards, which is
 * how the lanes of the reverse direction of a road are produced.
 */
export function sampleOffset(curve: Curve<Vector2>, from: number, to: number, offset: number, step: number): Vector2[] {
  const total = curve.getLength();
  const span = to - from;
  const dir = span >= 0 ? 1 : -1;
  const n = Math.max(1, Math.ceil(Math.abs(span) / step));
  const pts: Vector2[] = [];
  const p = new Vector2();
  const t = new Vector2();
  for (let i = 0; i <= n; i++) {
    const s = from + (span * i) / n;
    const u = clamp(s / total, 0, 1);
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    const tx = t.x * dir;
    const ty = t.y * dir;
    pts.push(new Vector2(p.x - ty * offset, p.y + tx * offset));
  }
  return pts;
}

/** Point and unit direction of a curve at an arc length. */
export function curveFrame(curve: Curve<Vector2>, s: number): { p: Vector2; t: Vector2 } {
  const u = clamp(s / curve.getLength(), 0, 1);
  return { p: curve.getPointAt(u, new Vector2()), t: curve.getTangentAt(u, new Vector2()).normalize() };
}

/** Solves p + d·t = q + e·u. Returns null for parallel rays. */
export function rayIntersection(p: Vector2, d: Vector2, q: Vector2, e: Vector2): { t: number; u: number } | null {
  const den = cross(d.x, d.y, e.x, e.y);
  if (Math.abs(den) < 1e-9) return null;
  const wx = q.x - p.x;
  const wy = q.y - p.y;
  return { t: cross(wx, wy, e.x, e.y) / den, u: cross(wx, wy, d.x, d.y) / den };
}

/**
 * Turning path between the end of one lane and the start of another. Where the two lane
 * directions meet we place the Bézier handles at ~0.55 of the legs, which approximates a
 * circular arc — the shape a driver actually steers. Nearly parallel lanes (straight through,
 * slight bends) fall back to a symmetric S-curve with thirds-of-distance handles.
 */
export function connectorCurve(p0: Vector2, d0: Vector2, p3: Vector2, d3: Vector2): CubicBezierCurve {
  const dist = p0.distanceTo(p3);
  let h0 = dist / 3;
  let h3 = dist / 3;
  const hit = rayIntersection(p0, d0, p3, d3.clone().negate());
  if (hit !== null && hit.t > 0.05 && hit.u > 0.05 && hit.t < dist * 2 && hit.u < dist * 2) {
    h0 = Math.min(hit.t * 0.55, dist * 0.75);
    h3 = Math.min(hit.u * 0.55, dist * 0.75);
  }
  return new CubicBezierCurve(
    p0.clone(),
    new Vector2(p0.x + d0.x * h0, p0.y + d0.y * h0),
    new Vector2(p3.x - d3.x * h3, p3.y - d3.y * h3),
    p3.clone(),
  );
}

/** Smallest turning radius along a path, measured over windows long enough to ignore sampling noise. */
export function minTurnRadius(path: Path, window = 4): number {
  if (path.length < window) return Infinity;
  const steps = Math.max(2, Math.ceil(path.length / 1));
  const a = makePose();
  const b = makePose();
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    const s = (path.length * i) / steps;
    if (s + window > path.length) break;
    path.pose(s + 0.01, a);
    path.pose(s + window - 0.01, b);
    const turn = Math.abs(Math.atan2(cross(a.tx, a.ty, b.tx, b.ty), a.tx * b.tx + a.ty * b.ty));
    if (turn > 1e-4) best = Math.min(best, window / turn);
  }
  return best;
}

export interface Zone {
  aEnter: number;
  aExit: number;
  bEnter: number;
  bExit: number;
}

/** Points along a path with the arc length (on the owning path) each one stands for. */
export interface Samples {
  pts: Vector2[];
  ss: number[];
}

export function centerSamples(path: Path, step = 0.5): Samples {
  const pts = path.resample(step);
  const ds = path.length / (pts.length - 1);
  return { pts, ss: pts.map((_, i) => i * ds) };
}

/**
 * Where the middle of a long rigid body sits while its front and rear follow the path: on a
 * curve the body cuts inside by the sagitta of its length (off-tracking). Conflict zones are
 * computed against this too, so a turning truck doesn't clip cars waiting at the zone's edge.
 */
export function sweptSamples(path: Path, bodyLength: number, step = 0.5): Samples {
  const base = centerSamples(path, step);
  const half = bodyLength / 2;
  const a = makePose();
  const b = makePose();
  const pts = base.pts.map((p, i) => {
    const s = base.ss[i];
    path.pose(Math.max(0, s - 3), a);
    path.pose(Math.min(path.length, s + 3), b);
    const turn = Math.atan2(cross(a.tx, a.ty, b.tx, b.ty), a.tx * b.tx + a.ty * b.ty);
    if (Math.abs(turn) < 1e-3) return p.clone();
    const window = Math.min(path.length, s + 3) - Math.max(0, s - 3);
    const r = window / Math.abs(turn);
    const sag = r > half ? r - Math.sqrt(r * r - half * half) : r;
    path.pose(s, a);
    // Positive turn = heading rotating clockwise on screen, whose centre lies to the right.
    const sign = Math.sign(turn);
    return new Vector2(p.x - a.ty * sag * sign, p.y + a.tx * sag * sign);
  });
  return { pts, ss: base.ss };
}

/**
 * Where two sampled paths come closer than `threshold`: the arc-length interval on each. One
 * bounding interval per path is deliberately conservative — a vehicle is kept out of the whole
 * region while another occupies it.
 */
export function proximityZone(a: Samples, b: Samples, threshold: number): Zone | null {
  let minAx = Infinity;
  let minAy = Infinity;
  let maxAx = -Infinity;
  let maxAy = -Infinity;
  for (const p of a.pts) {
    minAx = Math.min(minAx, p.x);
    maxAx = Math.max(maxAx, p.x);
    minAy = Math.min(minAy, p.y);
    maxAy = Math.max(maxAy, p.y);
  }
  let minBx = Infinity;
  let minBy = Infinity;
  let maxBx = -Infinity;
  let maxBy = -Infinity;
  for (const p of b.pts) {
    minBx = Math.min(minBx, p.x);
    maxBx = Math.max(maxBx, p.x);
    minBy = Math.min(minBy, p.y);
    maxBy = Math.max(maxBy, p.y);
  }
  if (minAx - threshold > maxBx || minBx - threshold > maxAx || minAy - threshold > maxBy || minBy - threshold > maxAy) {
    return null;
  }
  const t2 = threshold * threshold;
  let aEnter = Infinity;
  let aExit = -Infinity;
  let bEnter = Infinity;
  let bExit = -Infinity;
  for (let i = 0; i < a.pts.length; i++) {
    const p = a.pts[i];
    for (let j = 0; j < b.pts.length; j++) {
      const q = b.pts[j];
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      if (dx * dx + dy * dy < t2) {
        aEnter = Math.min(aEnter, a.ss[i]);
        aExit = Math.max(aExit, a.ss[i]);
        bEnter = Math.min(bEnter, b.ss[j]);
        bExit = Math.max(bExit, b.ss[j]);
      }
    }
  }
  if (aEnter === Infinity) return null;
  return { aEnter, aExit, bEnter, bExit };
}

/** Smallest zone covering every non-null input. */
export function unionZones(zones: (Zone | null)[]): Zone | null {
  let out: Zone | null = null;
  for (const z of zones) {
    if (z === null) continue;
    if (out === null) out = { ...z };
    else {
      out.aEnter = Math.min(out.aEnter, z.aEnter);
      out.aExit = Math.max(out.aExit, z.aExit);
      out.bEnter = Math.min(out.bEnter, z.bEnter);
      out.bExit = Math.max(out.bExit, z.bExit);
    }
  }
  return out;
}

/** De Casteljau split of a quadratic Bézier at parameter t. */
export function splitQuadratic(p0: Vector2, p1: Vector2, p2: Vector2, t: number): [Vector2[], Vector2[]] {
  const a = p0.clone().lerp(p1, t);
  const b = p1.clone().lerp(p2, t);
  const m = a.clone().lerp(b, t);
  return [
    [p0.clone(), a, m],
    [m.clone(), b, p2.clone()],
  ];
}

/** Intersection point parameters of segments p0→p1 and q0→q1, or null. */
export function segmentIntersection(p0: Vector2, p1: Vector2, q0: Vector2, q1: Vector2): { t: number; u: number } | null {
  const d = new Vector2(p1.x - p0.x, p1.y - p0.y);
  const e = new Vector2(q1.x - q0.x, q1.y - q0.y);
  const hit = rayIntersection(p0, d, q0, e);
  if (hit === null) return null;
  if (hit.t < 0 || hit.t > 1 || hit.u < 0 || hit.u > 1) return null;
  return hit;
}
