import { Vector2, type Curve } from 'three';
import { roadCurve } from '../sim/compile';
import {
  cloneDesign,
  defaultDemand,
  defaultPriority,
  findNode,
  findRoad,
  nodeDegree,
  type Design,
  type DesignNode,
  type DesignRoad,
} from '../sim/design';
import { segmentIntersection, splitQuadratic } from '../sim/geometry';

/*
 * Design edits as pure functions: each takes a design and returns a new one, so the editor
 * can try an edit, compile it, and simply drop it if it doesn't make a valid network.
 */

/** Where a road being drawn starts or ends. */
export type Anchor =
  | { kind: 'node'; id: number }
  | { kind: 'road'; id: number; x: number; y: number }
  | { kind: 'free'; x: number; y: number };

export interface RoadDraft {
  lanesAB: number;
  lanesBA: number;
  speed: number;
}

/** Closer than this (m) to an existing node, a crossing joins that node instead of making a new one. */
const NODE_MERGE = 8;

export function anchorPoint(d: Design, a: Anchor): Vector2 {
  if (a.kind === 'node') {
    const n = findNode(d, a.id);
    return new Vector2(n.x, n.y);
  }
  return new Vector2(a.x, a.y);
}

function newNode(d: Design, x: number, y: number): DesignNode {
  const n: DesignNode = { id: d.nextId++, x, y, control: defaultPriority(), demand: defaultDemand() };
  d.nodes.push(n);
  return n;
}

function curveOf(d: Design, r: DesignRoad): Curve<Vector2> {
  return roadCurve(r, findNode(d, r.a), findNode(d, r.b));
}

/** Samples a road's centre line, returning points with the curve parameter t of each. */
function sampleRoad(d: Design, r: DesignRoad, step = 1): { pts: Vector2[]; ts: number[] } {
  const curve = curveOf(d, r);
  const len = curve.getLength();
  const n = r.curve === null ? 1 : Math.max(2, Math.ceil(len / step));
  const pts: Vector2[] = [];
  const ts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const t = r.curve === null ? u : curve.getUtoTmapping(u, 0);
    pts.push(curve.getPoint(t, new Vector2()));
    ts.push(t);
  }
  return { pts, ts };
}

/** Nearest point on a road: distance, curve parameter, position. */
export function nearestOnRoad(d: Design, r: DesignRoad, p: Vector2): { distance: number; t: number; point: Vector2 } {
  const { pts, ts } = sampleRoad(d, r, 0.5);
  let best = { distance: Infinity, t: 0, point: pts[0] };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ab = b.clone().sub(a);
    const len2 = ab.lengthSq();
    const k = len2 === 0 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
    const q = a.clone().addScaledVector(ab, k);
    const dist = q.distanceTo(p);
    if (dist < best.distance) best = { distance: dist, t: ts[i] + (ts[i + 1] - ts[i]) * k, point: q };
  }
  return best;
}

/** Splits a road at curve parameter t with a new node; returns the new node id. */
export function splitRoad(d: Design, roadId: number, t: number): number {
  const r = findRoad(d, roadId);
  const a = findNode(d, r.a);
  const b = findNode(d, r.b);
  const pa = new Vector2(a.x, a.y);
  const pb = new Vector2(b.x, b.y);
  let p: Vector2;
  let c1: Vector2 | null = null;
  let c2: Vector2 | null = null;
  if (r.curve === null) {
    p = pa.clone().lerp(pb, t);
  } else {
    const [first, second] = splitQuadratic(pa, new Vector2(r.curve.x, r.curve.y), pb, t);
    p = first[2];
    c1 = first[1];
    c2 = second[1];
  }
  const n = newNode(d, p.x, p.y);
  d.roads = d.roads.filter((x) => x.id !== roadId);
  d.roads.push(
    { ...r, id: d.nextId++, a: r.a, b: n.id, curve: c1 === null ? null : { x: c1.x, y: c1.y } },
    { ...r, id: d.nextId++, a: n.id, b: r.b, curve: c2 === null ? null : { x: c2.x, y: c2.y } },
  );
  return n.id;
}

/** Turns an anchor into a node of the design (splitting a road when the anchor lies on one). */
function resolve(d: Design, a: Anchor): number {
  switch (a.kind) {
    case 'node':
      findNode(d, a.id);
      return a.id;
    case 'free':
      return newNode(d, a.x, a.y).id;
    case 'road': {
      // The road may have been split already by an earlier step: snap to whichever piece is nearest.
      const p = new Vector2(a.x, a.y);
      let best: { road: DesignRoad; t: number; distance: number } | null = null;
      for (const r of d.roads) {
        const near = nearestOnRoad(d, r, p);
        if (best === null || near.distance < best.distance) best = { road: r, t: near.t, distance: near.distance };
      }
      if (best === null || best.distance > 1) throw new Error('The road to connect to no longer exists');
      const ends = [findNode(d, best.road.a), findNode(d, best.road.b)];
      for (const e of ends) if (Math.hypot(e.x - p.x, e.y - p.y) < NODE_MERGE) return e.id;
      return splitRoad(d, best.road.id, best.t);
    }
  }
}

function hasRoad(d: Design, a: number, b: number): boolean {
  return d.roads.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
}

interface Crossing {
  /** Arc-length position along the new road. */
  s: number;
  roadId: number;
  t: number;
  point: Vector2;
}

/**
 * Adds a road from `from` to `to` (straight, or a quadratic Bézier through `control`). Where it
 * crosses existing roads, both are split and a junction is created — as in city builders.
 */
export function drawRoad(source: Design, from: Anchor, to: Anchor, control: Vector2 | null, draft: RoadDraft): { design: Design; end: number } {
  const d = cloneDesign(source);
  const p0 = anchorPoint(d, from);
  const p1 = anchorPoint(d, to);
  if (p0.distanceTo(p1) < 1) throw new Error('The road needs some length');

  // Sample the new road and find where it crosses existing roads (before anything is split).
  const newPts: Vector2[] = [];
  const newTs: number[] = [];
  const n = control === null ? 1 : Math.max(8, Math.ceil(p0.distanceTo(p1) / 2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    newTs.push(t);
    if (control === null) newPts.push(p0.clone().lerp(p1, t));
    else {
      const a = p0.clone().lerp(control, t);
      const b = control.clone().lerp(p1, t);
      newPts.push(a.lerp(b, t));
    }
  }
  const cum = [0];
  for (let i = 1; i < newPts.length; i++) cum.push(cum[i - 1] + newPts[i].distanceTo(newPts[i - 1]));
  const total = cum[cum.length - 1];
  const crossings: Crossing[] = [];
  const endpointIds = new Set<number>();
  if (from.kind === 'node') endpointIds.add(from.id);
  if (to.kind === 'node') endpointIds.add(to.id);
  for (const r of d.roads) {
    const { pts, ts } = sampleRoad(d, r);
    for (let i = 0; i + 1 < newPts.length; i++) {
      for (let j = 0; j + 1 < pts.length; j++) {
        const hit = segmentIntersection(newPts[i], newPts[i + 1], pts[j], pts[j + 1]);
        if (hit === null) continue;
        const s = cum[i] + (cum[i + 1] - cum[i]) * hit.t;
        // Crossings at the new road's own ends are the anchors themselves.
        if (s < 3 || s > total - 3) continue;
        const point = newPts[i].clone().lerp(newPts[i + 1], hit.t);
        if ((endpointIds.has(r.a) || endpointIds.has(r.b)) && Math.min(point.distanceTo(p0), point.distanceTo(p1)) < 3) continue;
        crossings.push({ s, roadId: r.id, t: ts[j] + (ts[j + 1] - ts[j]) * hit.u, point });
      }
    }
  }
  crossings.sort((x, y) => x.s - y.s);

  const start = resolve(d, from);
  const stops: { node: number; s: number }[] = [{ node: start, s: 0 }];
  for (const c of crossings) {
    const node = resolve(d, { kind: 'road', id: c.roadId, x: c.point.x, y: c.point.y });
    if (stops[stops.length - 1].node !== node) stops.push({ node, s: c.s });
  }
  const end = resolve(d, to);
  if (stops[stops.length - 1].node !== end) stops.push({ node: end, s: total });
  else stops[stops.length - 1] = { node: end, s: total };

  // Pieces of the new road between consecutive stops; curved roads keep their shape per piece.
  const tAt = (s: number) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const k = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    return newTs[i - 1] + (newTs[i] - newTs[i - 1]) * Math.max(0, Math.min(1, k));
  };
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i].node;
    const b = stops[i + 1].node;
    if (a === b) continue;
    if (hasRoad(d, a, b)) throw new Error('Those two points are already connected');
    let curve: { x: number; y: number } | null = null;
    if (control !== null) {
      // Control point of the sub-curve between t0 and t1 of the original quadratic.
      const t0 = tAt(stops[i].s);
      const t1 = tAt(stops[i + 1].s);
      const q = (t: number) => {
        const u = 1 - t;
        return new Vector2(u * u * p0.x + 2 * u * t * control.x + t * t * p1.x, u * u * p0.y + 2 * u * t * control.y + t * t * p1.y);
      };
      const dq = (t: number) => new Vector2(2 * (1 - t) * (control.x - p0.x) + 2 * t * (p1.x - control.x), 2 * (1 - t) * (control.y - p0.y) + 2 * t * (p1.y - control.y));
      const qa = q(t0);
      const da = dq(t0).multiplyScalar((t1 - t0) / 2);
      curve = { x: qa.x + da.x, y: qa.y + da.y };
    }
    d.roads.push({ id: d.nextId++, a, b, lanesAB: draft.lanesAB, lanesBA: draft.lanesBA, speed: draft.speed, curve });
  }
  return { design: normalize(d), end };
}

/** Removes a road, and any node left with no roads. */
export function removeRoad(source: Design, roadId: number): Design {
  const d = cloneDesign(source);
  findRoad(d, roadId);
  d.roads = d.roads.filter((r) => r.id !== roadId);
  return normalize(d);
}

/** Removes a node together with every road touching it. */
export function removeNode(source: Design, nodeId: number): Design {
  const d = cloneDesign(source);
  findNode(d, nodeId);
  d.roads = d.roads.filter((r) => r.a !== nodeId && r.b !== nodeId);
  d.nodes = d.nodes.filter((n) => n.id !== nodeId);
  return normalize(d);
}

/** Moves a node; control points of curved roads follow halfway so their shape is kept. */
export function moveNode(source: Design, nodeId: number, x: number, y: number): Design {
  const d = cloneDesign(source);
  const n = findNode(d, nodeId);
  const dx = x - n.x;
  const dy = y - n.y;
  n.x = x;
  n.y = y;
  for (const r of d.roads) {
    if (r.curve !== null && (r.a === nodeId || r.b === nodeId)) r.curve = { x: r.curve.x + dx / 2, y: r.curve.y + dy / 2 };
  }
  return d;
}

export function updateRoad(source: Design, roadId: number, patch: Partial<Omit<DesignRoad, 'id' | 'a' | 'b'>>): Design {
  const d = cloneDesign(source);
  const r = findRoad(d, roadId);
  Object.assign(r, patch);
  return normalize(d);
}

/** Swaps a road's direction (for one-way roads). */
export function reverseRoad(source: Design, roadId: number): Design {
  const d = cloneDesign(source);
  const r = findRoad(d, roadId);
  [r.a, r.b] = [r.b, r.a];
  [r.lanesAB, r.lanesBA] = [r.lanesBA, r.lanesAB];
  return d;
}

/** Edits a node in place on a copy. */
export function updateNode(source: Design, nodeId: number, edit: (n: DesignNode) => void): Design {
  const d = cloneDesign(source);
  edit(findNode(d, nodeId));
  return normalize(d);
}

/**
 * Keeps cross-references valid after edits: nodes without roads disappear, a priority
 * junction's chosen major road must still meet it, and destination weights only name entries
 * that still exist.
 */
export function normalize(d: Design): Design {
  d.nodes = d.nodes.filter((n) => nodeDegree(d, n.id) > 0);
  const ids = new Set(d.nodes.map((n) => String(n.id)));
  for (const n of d.nodes) {
    if (n.control.type === 'priority' && n.control.major !== null) {
      const meets = (rid: number) => d.roads.some((r) => r.id === rid && (r.a === n.id || r.b === n.id));
      if (!meets(n.control.major[0]) || !meets(n.control.major[1])) n.control = { ...n.control, major: null };
    }
    for (const k of Object.keys(n.demand.split)) if (!ids.has(k)) delete n.demand.split[k];
  }
  return d;
}

/** Bounding box of a design's nodes (for framing the camera). */
export function bounds(d: Design): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (d.nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of d.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}
