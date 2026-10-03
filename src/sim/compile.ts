import { LineCurve, QuadraticBezierCurve, Vector2, type Curve } from 'three';
import { LANE_WIDTH, MAX_LANES, type Design, type DesignNode, type DesignRoad, type RoundaboutControl } from './design';
import {
  Path,
  connectorCurve,
  cross,
  curveFrame,
  makePose,
  minTurnRadius,
  centerSamples,
  proximityZone,
  rayIntersection,
  sampleOffset,
  sweptSamples,
  unionZones,
  wrapAngle,
  type Samples,
} from './geometry';
import { assignLanes, mapLanes } from './lanes';
import {
  CompiledRoad,
  Conflict,
  Connector,
  Gateway,
  Junction,
  Lane,
  Link,
  Movement,
  Network,
  Roundabout,
  type Arm,
  type JunctionKind,
  type RingArm,
  type RingRole,
  type Turn,
} from './network';
import { bindControls } from './controls';

/** A design that cannot be turned into a drivable network. Carries what to highlight in the editor. */
export class CompileError extends Error {
  constructor(
    message: string,
    readonly nodeId: number | null = null,
    readonly roadId: number | null = null,
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

/** Space (m) between where two road edges meet and the stop line. */
const JUNCTION_MARGIN = 2;
/** Roads meeting more sharply than this cannot form a sensible junction. */
const MIN_ANGLE = (15 * Math.PI) / 180;
/** Shortest drivable lane left between two junctions. */
const MIN_LANE_LENGTH = 6;
/** Distance (m) between the roundabout's outer edge and the yield line; room for a gentle entry curve. */
const RING_APPROACH = 6;
/** Paths closer than this (centre to centre) collide. Wider than a truck, narrower than a lane. */
const CONFLICT_DISTANCE = 2.4;
/**
 * Body length (m) whose off-tracking widens conflict zones. Shorter than the longest truck on
 * purpose: zones sized for the worst case would make every junction needlessly cautious.
 */
const DESIGN_VEHICLE_LENGTH = 9;
/** Lateral acceleration (m/s²) drivers accept through junction turns. */
const LATERAL_ACCEL = 3;
const RING_LATERAL_ACCEL = 2.2;

interface RoadEnd {
  road: DesignRoad;
  node: DesignNode;
  atA: boolean;
  /** Unit direction pointing away from the node along the road. */
  dir: Vector2;
  angle: number;
  halfWidth: number;
  /** Lanes arriving at / leaving the node. */
  lanesIn: number;
  lanesOut: number;
  curveLength: number;
  trim: number;
  inLink: Link | null;
  outLink: Link | null;
}

class Ids {
  private n = 1;
  next(): number {
    return this.n++;
  }
}

export function roadCurve(road: DesignRoad, a: DesignNode, b: DesignNode): Curve<Vector2> {
  const pa = new Vector2(a.x, a.y);
  const pb = new Vector2(b.x, b.y);
  if (road.curve === null) return new LineCurve(pa, pb);
  const curve = new QuadraticBezierCurve(pa, new Vector2(road.curve.x, road.curve.y), pb);
  curve.arcLengthDivisions = 400;
  return curve;
}

function validateDesign(d: Design): Map<number, DesignNode> {
  const nodes = new Map<number, DesignNode>();
  for (const n of d.nodes) {
    if (nodes.has(n.id)) throw new CompileError(`Duplicate node id ${n.id}`, n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw new CompileError(`Node ${n.id} has no position`, n.id);
    nodes.set(n.id, n);
  }
  const roadIds = new Set<number>();
  for (const r of d.roads) {
    if (roadIds.has(r.id)) throw new CompileError(`Duplicate road id ${r.id}`, null, r.id);
    roadIds.add(r.id);
    if (!nodes.has(r.a) || !nodes.has(r.b)) throw new CompileError(`Road ${r.id} references a missing node`, null, r.id);
    if (r.a === r.b) throw new CompileError(`Road ${r.id} starts and ends at the same node`, r.a, r.id);
    for (const lanes of [r.lanesAB, r.lanesBA]) {
      if (!Number.isInteger(lanes) || lanes < 0 || lanes > MAX_LANES) {
        throw new CompileError(`Road ${r.id} has an invalid lane count (${lanes})`, null, r.id);
      }
    }
    if (r.lanesAB + r.lanesBA === 0) throw new CompileError(`Road ${r.id} has no lanes`, null, r.id);
    if (!(r.speed >= 5 && r.speed <= 200)) throw new CompileError(`Road ${r.id} has an invalid speed limit`, null, r.id);
  }
  return nodes;
}

export function compileNetwork(design: Design): Network {
  const nodes = validateDesign(design);
  const side: 1 | -1 = design.drivingSide === 'right' ? 1 : -1;
  const net = new Network(design.drivingSide, side);
  const ids = new Ids();

  // Road ends grouped by node; the tangent at the node decides how roads meet.
  const curves = new Map<number, Curve<Vector2>>();
  const endsByNode = new Map<number, RoadEnd[]>();
  const endsByRoad = new Map<number, { a: RoadEnd; b: RoadEnd }>();
  for (const road of design.roads) {
    const na = nodes.get(road.a)!;
    const nb = nodes.get(road.b)!;
    const curve = roadCurve(road, na, nb);
    curves.set(road.id, curve);
    const length = curve.getLength();
    const halfWidth = ((road.lanesAB + road.lanesBA) * LANE_WIDTH) / 2;
    const dirA = curveFrame(curve, 0).t;
    const dirB = curveFrame(curve, length).t.negate();
    const endA: RoadEnd = {
      road,
      node: na,
      atA: true,
      dir: dirA,
      angle: Math.atan2(dirA.y, dirA.x),
      halfWidth,
      lanesIn: road.lanesBA,
      lanesOut: road.lanesAB,
      curveLength: length,
      trim: 0,
      inLink: null,
      outLink: null,
    };
    const endB: RoadEnd = {
      ...endA,
      node: nb,
      atA: false,
      dir: dirB,
      angle: Math.atan2(dirB.y, dirB.x),
      lanesIn: road.lanesAB,
      lanesOut: road.lanesBA,
    };
    endsByRoad.set(road.id, { a: endA, b: endB });
    for (const e of [endA, endB]) {
      const list = endsByNode.get(e.node.id) ?? [];
      list.push(e);
      endsByNode.set(e.node.id, list);
    }
  }
  for (const list of endsByNode.values()) list.sort((p, q) => p.angle - q.angle);

  for (const [nodeId, ends] of endsByNode) computeTrims(nodes.get(nodeId)!, ends);

  for (const road of design.roads) {
    const { a, b } = endsByRoad.get(road.id)!;
    const usable = a.curveLength - a.trim - b.trim;
    if (usable < MIN_LANE_LENGTH) {
      throw new CompileError(
        `Road ${road.id} is too short: only ${Math.max(0, usable).toFixed(1)} m remain between its junctions`,
        null,
        road.id,
      );
    }
    buildRoad(net, ids, road, curves.get(road.id)!, a, b);
  }

  for (const [nodeId, ends] of endsByNode) {
    const node = nodes.get(nodeId)!;
    if (ends.length === 1) buildGateway(net, node, ends[0]);
    else if (ends.length >= 3 && node.control.type === 'roundabout') buildRoundabout(net, ids, node, ends, node.control);
    else buildJunction(net, ids, node, ends);
  }

  for (const j of net.junctions) {
    const list = net.junctionsByNode.get(j.nodeId) ?? [];
    list.push(j);
    net.junctionsByNode.set(j.nodeId, list);
  }
  for (const g of net.gateways) net.gatewaysByNode.set(g.nodeId, g);
  for (const r of net.roads) net.roadsById.set(r.design.id, r);

  computeReachability(net);
  bindControls(net, design);
  return net;
}

/**
 * How far each road is cut back from the node so the junction has room. For two roads meeting
 * at angle α with half-widths hᵢ, hⱼ, their facing edges cross at distance (hⱼ + hᵢ·cos α)/sin α
 * along road i; the stop line sits a small margin beyond that.
 */
function computeTrims(node: DesignNode, ends: RoadEnd[]): void {
  const n = ends.length;
  if (n === 1) {
    ends[0].trim = 0;
    return;
  }
  if (n >= 3 && node.control.type === 'roundabout') {
    const rOuter = node.control.radius + (node.control.lanes * LANE_WIDTH) / 2;
    for (const e of ends) e.trim = rOuter + RING_APPROACH;
    return;
  }
  const corner = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const gap = wrapAngle(ends[j].angle - ends[i].angle);
    if (gap < MIN_ANGLE) {
      throw new CompileError(`Roads meet at too sharp an angle at node ${node.id}`, node.id);
    }
    if (gap < Math.PI - 0.35) {
      const hi = ends[i].halfWidth;
      const hj = ends[j].halfWidth;
      corner[i] = Math.max(corner[i], (hj + hi * Math.cos(gap)) / Math.sin(gap));
      corner[j] = Math.max(corner[j], (hi + hj * Math.cos(gap)) / Math.sin(gap));
    }
  }
  if (n === 2) {
    // A bend or a change in lane count: just enough room to taper the lanes into each other.
    const change = Math.max(Math.abs(ends[0].lanesIn - ends[1].lanesOut), Math.abs(ends[1].lanesIn - ends[0].lanesOut));
    const taper = 1 + 5 * change;
    for (let i = 0; i < n; i++) ends[i].trim = Math.max(corner[i] + 0.5, taper);
    return;
  }
  for (let i = 0; i < n; i++) ends[i].trim = Math.max(corner[i] + JUNCTION_MARGIN, 4);
}

function buildRoad(net: Network, ids: Ids, road: DesignRoad, curve: Curve<Vector2>, a: RoadEnd, b: RoadEnd): void {
  const side = net.side;
  const W = LANE_WIDTH;
  const L = a.curveLength;
  const step = road.curve === null ? Infinity : 2;
  const divider = (side * (road.lanesBA - road.lanesAB) * W) / 2;
  const center = new Path(sampleOffset(curve, a.trim, L - b.trim, 0, step));
  const compiled = new CompiledRoad(road, center, (road.lanesAB + road.lanesBA) * W, divider);
  const speed = road.speed / 3.6;

  if (road.lanesAB > 0) {
    const link = new Link(ids.next(), road.id, null, road.a, road.b);
    for (let i = 0; i < road.lanesAB; i++) {
      const u = divider + side * (i + 0.5) * W;
      link.lanes.push(new Lane(ids.next(), new Path(sampleOffset(curve, a.trim, L - b.trim, u, step)), speed, link, i));
    }
    compiled.ab = link;
    a.outLink = link;
    b.inLink = link;
    registerLink(net, link);
  }
  if (road.lanesBA > 0) {
    const link = new Link(ids.next(), road.id, null, road.b, road.a);
    for (let i = 0; i < road.lanesBA; i++) {
      const u = divider - side * (i + 0.5) * W;
      link.lanes.push(new Lane(ids.next(), new Path(sampleOffset(curve, L - b.trim, a.trim, -u, step)), speed, link, i));
    }
    compiled.ba = link;
    b.outLink = link;
    a.inLink = link;
    registerLink(net, link);
  }
  net.roads.push(compiled);
}

function registerLink(net: Network, link: Link): void {
  link.freeFlowTime = link.length / link.lanes[0].speed;
  link.observedTime = link.freeFlowTime;
  net.links.push(link);
  net.lanes.push(...link.lanes);
}

function buildGateway(net: Network, node: DesignNode, end: RoadEnd): void {
  const g = new Gateway(node.id, new Vector2(node.x, node.y), end.outLink, end.inLink);
  if (end.outLink !== null) end.outLink.source = g;
  if (end.inLink !== null) end.inLink.sink = g;
  net.gateways.push(g);
}

function makeArms(node: DesignNode, ends: RoadEnd[]): Arm[] {
  return ends.map((e, index) => ({
    index,
    roadId: e.road.id,
    dir: e.dir.clone(),
    end: new Vector2(node.x + e.dir.x * e.trim, node.y + e.dir.y * e.trim),
    halfWidth: e.halfWidth,
    in: e.inLink,
    out: e.outLink,
  }));
}

function attach(j: Junction): void {
  for (const arm of j.arms) {
    if (arm.in !== null) {
      j.incoming.push(arm.in);
      arm.in.endJunction = j;
    }
    if (arm.out !== null) {
      j.outgoing.push(arm.out);
      arm.out.startJunction = j;
    }
  }
}

function buildJunction(net: Network, ids: Ids, node: DesignNode, ends: RoadEnd[]): void {
  const side = net.side;
  const j = new Junction(ids.next(), node.id, junctionKind(node, ends.length), node.control, new Vector2(node.x, node.y), null);
  j.arms = makeArms(node, ends);
  attach(j);

  for (const arm of j.arms) {
    if (arm.in === null) continue;
    const ix = -arm.dir.x;
    const iy = -arm.dir.y;
    const candidates: { arm: Arm; out: Link; beta: number; turn: Turn }[] = [];
    for (const other of j.arms) {
      if (other === arm || other.out === null) continue;
      const d = other.dir;
      // Signed turn angle, positive towards the near side (right in right-hand traffic).
      const beta = side * Math.atan2(cross(ix, iy, d.x, d.y), ix * d.x + iy * d.y);
      let turn: Turn;
      if (j.arms.length === 2) turn = 'straight';
      else if (Math.abs(beta) > (160 * Math.PI) / 180) continue;
      else turn = Math.abs(beta) < (35 * Math.PI) / 180 ? 'straight' : beta > 0 ? 'near' : 'far';
      candidates.push({ arm: other, out: other.out, beta, turn });
    }
    candidates.sort((p, q) => p.beta - q.beta);
    if (candidates.length === 0) {
      net.warnings.push(`Traffic on road ${arm.roadId} cannot continue at node ${node.id}`);
      continue;
    }
    const laneSets = assignLanes(
      arm.in.lanes.length,
      candidates.map((c) => c.turn),
    );
    candidates.forEach((c, k) => {
      const m = new Movement(ids.next(), j, arm.in!, c.out, c.turn, arm.index, c.arm.index);
      for (const li of laneSets[k]) m.lanes.push(arm.in!.lanes[li]);
      const pairs = mapLanes(m.lanes.length, c.out.lanes.length, c.turn === 'near' ? 'outer' : 'inner', c.turn === 'straight');
      pairs.forEach((outs, p) => {
        for (const q of outs) makeConnector(net, ids, j, m, m.lanes[p], c.out.lanes[q], null, null);
      });
      registerMovement(j, m);
    });
  }
  computeConflicts(j);
  j.polygon = junctionPolygon(j.arms);
  net.junctions.push(j);
}

function junctionKind(node: DesignNode, degree: number): JunctionKind {
  if (degree === 2) return 'none';
  if (node.control.type === 'roundabout') throw new Error(`Node ${node.id}: roundabouts compile through buildRoundabout`);
  return node.control.type;
}

function registerMovement(j: Junction, m: Movement): void {
  const mean = m.connectors.reduce((acc, c) => acc + c.length / c.speed, 0) / m.connectors.length;
  m.freeFlowTime = mean;
  j.movements.push(m);
  m.from.out.push(m);
}

function makeConnector(
  net: Network,
  ids: Ids,
  j: Junction,
  m: Movement,
  from: Lane,
  to: Lane,
  role: RingRole | null,
  path: Path | null,
): Connector {
  let p = path;
  if (p === null) {
    const a = from.path.pose(from.length, makePose());
    const b = to.path.pose(0, makePose());
    const curve = connectorCurve(new Vector2(a.x, a.y), new Vector2(a.tx, a.ty), new Vector2(b.x, b.y), new Vector2(b.tx, b.ty));
    p = new Path(curve.getSpacedPoints(Math.max(2, Math.ceil(curve.getLength()))));
  }
  const speed = Math.min(from.speed, to.speed, Math.sqrt(LATERAL_ACCEL * minTurnRadius(p)));
  const c = new Connector(ids.next(), p, speed, j, m, from, to, role);
  from.out.push(c);
  to.in.push(c);
  m.connectors.push(c);
  j.connectors.push(c);
  net.connectors.push(c);
  return c;
}

function computeConflicts(j: Junction): void {
  const cs = j.connectors;
  const center = new Map<Connector, Samples>();
  const swept = new Map<Connector, Samples>();
  for (const c of cs) {
    center.set(c, centerSamples(c.path));
    swept.set(c, sweptSamples(c.path, DESIGN_VEHICLE_LENGTH));
  }
  for (let i = 0; i < cs.length; i++) {
    for (let k = i + 1; k < cs.length; k++) {
      const a = cs[i];
      const b = cs[k];
      const ca = center.get(a)!;
      const cb = center.get(b)!;
      // Neighbouring lanes of one approach turn side by side (dual turn lanes), so only their
      // centre lines count; between approaches a long vehicle's swept body counts as well.
      const zone =
        a.from.link === b.from.link
          ? proximityZone(ca, cb, CONFLICT_DISTANCE)
          : unionZones([
              proximityZone(ca, cb, CONFLICT_DISTANCE),
              proximityZone(swept.get(a)!, cb, CONFLICT_DISTANCE),
              proximityZone(ca, swept.get(b)!, CONFLICT_DISTANCE),
            ]);
      if (zone === null) continue;
      const kind = a.from === b.from ? 'diverge' : a.to === b.to ? 'merge' : 'cross';
      const ka = new Conflict(b, kind, zone.aEnter, zone.aExit, zone.bEnter, zone.bExit);
      const kb = new Conflict(a, kind, zone.bEnter, zone.bExit, zone.aEnter, zone.aExit);
      ka.mirror = kb;
      kb.mirror = ka;
      a.conflicts.push(ka);
      b.conflicts.push(kb);
    }
  }
  for (const c of cs) c.conflicts.sort((p, q) => p.enter - q.enter);
}

/**
 * Paved outline of a junction: the trimmed ends of every arm joined by kerb fillets. Each
 * fillet bends towards where the two facing road edges would meet, giving rounded corners.
 */
function junctionPolygon(arms: Arm[]): Vector2[] {
  const pts: Vector2[] = [];
  const n = arms.length;
  for (let i = 0; i < n; i++) {
    const arm = arms[i];
    const next = arms[(i + 1) % n];
    const ni = new Vector2(-arm.dir.y, arm.dir.x);
    const nn = new Vector2(-next.dir.y, next.dir.x);
    const left = arm.end.clone().addScaledVector(ni, -arm.halfWidth);
    const right = arm.end.clone().addScaledVector(ni, arm.halfWidth);
    const nextLeft = next.end.clone().addScaledVector(nn, -next.halfWidth);
    pts.push(left, right);
    const hit = rayIntersection(right, arm.dir, nextLeft, next.dir);
    if (hit !== null && hit.t < 0 && hit.u < 0) {
      const ctrl = right.clone().addScaledVector(arm.dir, hit.t);
      const fillet = new QuadraticBezierCurve(right, ctrl, nextLeft);
      const samples = fillet.getPoints(8);
      for (let s = 1; s < samples.length - 1; s++) pts.push(samples[s]);
    }
  }
  return pts;
}

function buildRoundabout(net: Network, ids: Ids, node: DesignNode, ends: RoadEnd[], control: RoundaboutControl): void {
  const W = LANE_WIDTH;
  const nr = control.lanes;
  const R = control.radius;
  const rInner = R - (nr * W) / 2;
  const rOuter = R + (nr * W) / 2;
  if (rInner < 5) throw new CompileError(`A ${R} m roundabout is too small for ${nr} lane(s)`, node.id);
  // Polar angles grow clockwise on screen (y points south). Right-hand traffic circulates
  // counter-clockwise, i.e. with decreasing angle; left-hand traffic the other way round.
  const circulation: 1 | -1 = net.side === 1 ? -1 : 1;
  const center = new Vector2(node.x, node.y);
  const ring = new Roundabout(node.id, center, control, rInner, rOuter, circulation);

  // ψ is the angle measured along the direction of travel, so arms sort in driving order.
  const arms = ends
    .map((e) => {
      const angle = Math.atan2(e.dir.y, e.dir.x);
      // The arm's junction region extends well past its kerbs so entry and exit paths can join the
      // ring at a shallow angle (realistic entry speeds of ~20 km/h rather than a hairpin).
      return { e, angle, psi: wrapAngle(circulation * angle), halfSpan: (e.halfWidth + 6) / rOuter };
    })
    .sort((p, q) => p.psi - q.psi);
  const n = arms.length;
  for (let i = 0; i < n; i++) {
    const next = arms[(i + 1) % n];
    const gap = next.psi - arms[i].psi + (i === n - 1 ? Math.PI * 2 : 0);
    if (gap - arms[i].halfSpan - next.halfSpan < 5 / R) {
      throw new CompileError(`Roundabout at node ${node.id} is too small for its arms — increase the radius`, node.id);
    }
  }

  const laneRadius = (j: number) => rInner + (j + 0.5) * W;
  const pointAt = (psi: number, r: number) => {
    const phi = circulation * psi;
    return new Vector2(center.x + r * Math.cos(phi), center.y + r * Math.sin(phi));
  };
  const travelDir = (psi: number) => {
    const phi = circulation * psi;
    return new Vector2(-Math.sin(phi) * circulation, Math.cos(phi) * circulation);
  };
  const arcPath = (psi0: number, psi1: number, r: number) => {
    const steps = Math.max(2, Math.ceil(((psi1 - psi0) * r) / 1.5));
    const pts: Vector2[] = [];
    for (let k = 0; k <= steps; k++) pts.push(pointAt(psi0 + ((psi1 - psi0) * k) / steps, r));
    return new Path(pts);
  };
  const armSpeed = Math.max(...ends.map((e) => e.road.speed / 3.6));
  const ringSpeed = (r: number) => Math.min(armSpeed, Math.sqrt(RING_LATERAL_ACCEL * r));

  const arcs: Link[] = arms.map((arm, i) => {
    const next = arms[(i + 1) % n];
    const psi0 = arm.psi + arm.halfSpan;
    let psi1 = next.psi - next.halfSpan;
    if (psi1 <= psi0) psi1 += Math.PI * 2;
    const link = new Link(ids.next(), null, ring, node.id, node.id);
    for (let j = 0; j < nr; j++) link.lanes.push(new Lane(ids.next(), arcPath(psi0, psi1, laneRadius(j)), ringSpeed(laneRadius(j)), link, j));
    registerLink(net, link);
    ring.arcs.push(link);
    return link;
  });

  arms.forEach((arm, i) => {
    const e = arm.e;
    const ringIn = arcs[(i - 1 + n) % n];
    const ringOut = arcs[i];
    const j = new Junction(ids.next(), node.id, 'ring', control, pointAt(arm.psi, R), ring);
    j.arms = [
      {
        index: 0,
        roadId: e.road.id,
        dir: e.dir.clone(),
        end: new Vector2(node.x + e.dir.x * e.trim, node.y + e.dir.y * e.trim),
        halfWidth: e.halfWidth,
        in: e.inLink,
        out: e.outLink,
      },
      {
        index: 1,
        roadId: null,
        dir: travelDir(arm.psi - arm.halfSpan).negate(),
        end: pointAt(arm.psi - arm.halfSpan, R),
        halfWidth: (nr * W) / 2,
        in: ringIn,
        out: null,
      },
      {
        index: 2,
        roadId: null,
        dir: travelDir(arm.psi + arm.halfSpan),
        end: pointAt(arm.psi + arm.halfSpan, R),
        halfWidth: (nr * W) / 2,
        in: null,
        out: ringOut,
      },
    ];
    attach(j);

    const circulate = new Movement(ids.next(), j, ringIn, ringOut, 'straight', 1, 2);
    for (let k = 0; k < nr; k++) {
      circulate.lanes.push(ringIn.lanes[k]);
      makeConnector(net, ids, j, circulate, ringIn.lanes[k], ringOut.lanes[k], 'circulate', arcPath(arm.psi - arm.halfSpan, arm.psi + arm.halfSpan, laneRadius(k)));
    }
    registerMovement(j, circulate);

    if (e.outLink !== null) {
      const exit = new Movement(ids.next(), j, ringIn, e.outLink, 'near', 1, 0);
      exit.lanes.push(...ringIn.lanes);
      mapLanes(nr, e.outLink.lanes.length, 'inner', true).forEach((outs, p) => {
        for (const q of outs) makeConnector(net, ids, j, exit, ringIn.lanes[p], e.outLink!.lanes[q], 'exit', null);
      });
      registerMovement(j, exit);
    }
    if (e.inLink !== null) {
      const entry = new Movement(ids.next(), j, e.inLink, ringOut, 'near', 0, 2);
      entry.lanes.push(...e.inLink.lanes);
      // Nobody changes lanes on the ring, so a single entry lane must reach every ring lane.
      mapLanes(e.inLink.lanes.length, nr, 'inner', true).forEach((outs, p) => {
        for (const q of outs) makeConnector(net, ids, j, entry, e.inLink!.lanes[p], ringOut.lanes[q], 'entry', null);
      });
      registerMovement(j, entry);
    }
    computeConflicts(j);
    net.junctions.push(j);
    ring.junctions.push(j);
  });

  const ringArms: RingArm[] = arms.map((arm) => ({
    roadId: arm.e.road.id,
    angle: arm.angle,
    halfSpan: arm.halfSpan,
    dir: arm.e.dir.clone(),
    end: new Vector2(node.x + arm.e.dir.x * arm.e.trim, node.y + arm.e.dir.y * arm.e.trim),
    halfWidth: arm.e.halfWidth,
  }));
  ring.arms.push(...ringArms);
  net.roundabouts.push(ring);
}

/** Which exits each entry can reach, and which links can never reach an exit. */
function computeReachability(net: Network): void {
  for (const g of net.gateways) {
    if (g.source === null) continue;
    const seen = new Set<Link>([g.source]);
    const queue = [g.source];
    const found = new Set<Gateway>();
    while (queue.length > 0) {
      const link = queue.pop()!;
      if (link.sink !== null && link.sink !== g) found.add(link.sink);
      for (const m of link.out) {
        if (!seen.has(m.to)) {
          seen.add(m.to);
          queue.push(m.to);
        }
      }
    }
    g.reachable = net.gateways.filter((x) => found.has(x));
    if (g.reachable.length === 0) net.warnings.push(`Entry at node ${g.nodeId} cannot reach any exit`);
  }
}
