import { LANE_WIDTH, type Design, type DesignNode } from './design';
import { clamp, makePose } from './geometry';
import type { AnyTrack, Conflict, Connector, Gateway, Lane, Link, Network } from './network';
import { bindControls } from './controls';
import { Metrics } from './metrics';
import { Rng, mixSeed } from './rng';
import { Router } from './routing';
import { gapMargin, yieldMode, type YieldMode } from './rules';
import { Vehicle, freeAccel, interaction, stoppingDistance, timeToCover, type Profile, type WaitReason } from './vehicle';

/** Simulation time step (s). Small enough for stable IDM integration, large enough to run 16× in real time. */
export const DT = 0.1;
/** A driver commits to a junction once within comfortable stopping distance plus this margin (m). */
const COMMIT_MARGIN = 0.5;
/** Drivers stop for an amber light if they can do so braking at this rate (m/s²). */
const AMBER_DECEL = 3.5;
/** How far up a conflicting approach a driver looks for traffic (m). */
const HORIZON = 150;
/** Physical braking limit (m/s²). */
const MAX_DECEL = 9;
/** Seconds stuck at the end of a lane that does not lead onwards before taking another way. */
const STUCK_REROUTE = 15;
/** Seconds an inner-lane car waits on a roundabout for a gap to leave before going round again. */
const RING_GO_AROUND = 3;

const CAR_COLORS = [0xe8eef5, 0x1f2937, 0xc0392b, 0x2e86de, 0xf5f6fa, 0x7f8c8d, 0x34495e, 0xd35400, 0x16a085, 0xf1c40f, 0x8e44ad, 0x95a5a6];
const TRUCK_COLORS = [0xf2f2f0, 0xdfe6e9, 0x2d3436, 0xe17055, 0x0984e3];

export function makeProfile(rng: Rng, truckShare: number): Profile {
  const truck = rng.next() < truckShare;
  const u = rng.next();
  const w = rng.next();
  const z = rng.next();
  if (truck) {
    return {
      kind: 'truck',
      length: 10 + 2.5 * u,
      width: 2.5,
      a: 0.8 + 0.3 * w,
      b: 2.2,
      T: 1.5 + 0.4 * z,
      s0: 3,
      speedFactor: 0.86 + 0.08 * u,
      color: TRUCK_COLORS[rng.int(TRUCK_COLORS.length)],
    };
  }
  return {
    kind: 'car',
    length: 4.2 + 0.6 * u,
    width: 1.8,
    a: 1.3 + 0.7 * w,
    b: 2.5 + 0.5 * z,
    T: 1.0 + 0.5 * w,
    s0: 2,
    speedFactor: 0.92 + 0.16 * z,
    color: CAR_COLORS[rng.int(CAR_COLORS.length)],
  };
}

interface Pending {
  arrival: number;
  dest: Gateway;
  profile: Profile;
  seed: number;
  route: Link[] | null;
}

/** Arrival process and waiting queue of one network entry. */
export class GatewayState {
  readonly rng: Rng;
  rate = 0;
  nextArrival = Infinity;
  readonly queue: Pending[] = [];
  spawned = 0;

  constructor(
    readonly gateway: Gateway,
    seed: number,
  ) {
    this.rng = new Rng(seed);
  }
}

function removeFrom<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

/** Inserts keeping the list ordered front-most (largest s) first. */
function insertSorted(list: Vehicle[], v: Vehicle): void {
  let i = list.length;
  while (i > 0 && list[i - 1].s < v.s) i--;
  list.splice(i, 0, v);
}

/** Rear-bumper position of `w` measured along `track` (0 when its body covers the whole track). */
function rearOn(w: Vehicle, track: AnyTrack): number {
  if (w.track === track) return w.s - w.length;
  return w.rearTrack === track ? w.rearPos : 0;
}

function conflictsWith(a: Connector, b: Connector): boolean {
  for (const k of a.conflicts) if (k.other === b && k.kind !== 'diverge') return true;
  return false;
}

export class Simulation {
  readonly dt = DT;
  t = 0;
  readonly vehicles: Vehicle[] = [];
  readonly metrics = new Metrics();
  readonly gateways: GatewayState[];
  private design!: Design;
  private nodes = new Map<number, DesignNode>();
  private readonly router: Router;
  private readonly side: 1 | -1;
  private nextId = 1;
  private commitCounter = 0;
  /** Most negative IDM interaction found while scanning ahead for the vehicle being decided. */
  private inter = 0;
  private interSource: Vehicle | null = null;
  /** Why the last failed permission/conflict check failed (read right after the check). */
  private reason: WaitReason = 'conflict';
  private blocker: Vehicle | null = null;
  /** Whether the last zone block is a permissive turn's designated wait inside the junction. */
  private waitInside = false;
  private readonly front = makePose();
  private readonly rear = makePose();

  constructor(
    readonly net: Network,
    design: Design,
  ) {
    this.side = net.side;
    this.router = new Router(net);
    this.gateways = net.gateways.map((g) => new GatewayState(g, mixSeed(design.traffic.seed, g.nodeId)));
    this.setDesign(design);
  }

  /** Applies live parameter changes (demand, controls) from a design with unchanged geometry. */
  setDesign(design: Design): void {
    this.design = design;
    this.nodes = new Map(design.nodes.map((n) => [n.id, n]));
    bindControls(this.net, design);
    for (const st of this.gateways) {
      const rate = this.arrivalRate(st.gateway);
      if (rate === st.rate) continue;
      st.rate = rate;
      st.nextArrival = rate > 0 ? this.t + st.rng.exponential(rate) : Infinity;
    }
  }

  private node(id: number): DesignNode {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error(`Simulation has no design node ${id}`);
    return n;
  }

  /** Vehicles per second entering at a gateway, or 0 if nothing can be spawned there. */
  arrivalRate(g: Gateway): number {
    if (g.source === null || g.reachable.length === 0) return 0;
    const node = this.node(g.nodeId);
    let weight = 0;
    for (const d of g.reachable) weight += this.destinationWeight(node, d);
    if (weight <= 0) return 0;
    return (node.demand.inflow * this.design.traffic.demandScale) / 3600;
  }

  private destinationWeight(origin: DesignNode, dest: Gateway): number {
    return origin.demand.split[String(dest.nodeId)] ?? 1;
  }

  queued(): number {
    let n = 0;
    for (const st of this.gateways) n += st.queue.length;
    return n;
  }

  meanSpeed(): number {
    if (this.vehicles.length === 0) return 0;
    let sum = 0;
    for (const v of this.vehicles) sum += v.v;
    return sum / this.vehicles.length;
  }

  run(seconds: number): void {
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) this.step();
  }

  step(): void {
    this.t += DT;
    for (const j of this.net.junctions) if (j.signal !== null) j.signal.step(this.t, DT);
    for (const x of this.vehicles) x.nextAcc = this.decide(x);
    for (const x of this.vehicles) this.move(x);
    this.updateBodies();
    this.checkOrder();
    this.laneChanges();
    this.retire();
    this.spawn();
    for (const x of this.vehicles) {
      x.px = x.x;
      x.py = x.y;
      x.pheading = x.heading;
      this.setPose(x);
    }
    this.metrics.maybeSample(this.t, this.vehicles.length, this.queued(), this.meanSpeed() * 3.6);
  }

  // ---------------------------------------------------------------- decisions

  /** Folds one obstacle (a vehicle ahead, or a standing stop point when `source` is null) into the decision. */
  private consider(x: Vehicle, gap: number, leaderV: number, s0: number, source: Vehicle | null): void {
    const a = interaction(x, gap, leaderV, s0);
    if (a < this.inter) {
      this.inter = a;
      this.interSource = source;
    }
  }

  /**
   * Acceleration for one vehicle from the current (read-only) state: IDM against the nearest
   * vehicle ahead along its planned path, plus virtual standing obstacles wherever it must stop —
   * a red light, a give-way line, a conflict zone someone else is using, the end of a lane that
   * doesn't lead where it is going.
   */
  private decide(x: Vehicle): number {
    const lookahead = Math.min(220, 50 + 8 * x.v);
    const free = freeAccel(x, x.desiredSpeed(x.track));
    this.inter = 0;
    this.interSource = null;
    let limit = Infinity;
    x.pendingCommit = x.committed;
    x.pendingZones.length = 0;
    x.wait = null;
    x.waitFor = null;

    let track: AnyTrack = x.track;
    let base = -x.s;
    let routeIdx = x.routeIdx;
    let first = true;
    let leaderFound = false;

    for (let hop = 0; hop < 8; hop++) {
      if (!leaderFound) leaderFound = first ? this.leaderAhead(x) : this.leaderOn(x, track, base);
      if (!first) {
        // Ease off before a slower stretch (a turn, the ring) instead of braking on entry.
        const vt = x.desiredSpeed(track);
        if (x.v > vt && base > 0) {
          const req = (x.v * x.v - vt * vt) / (2 * Math.max(base, 1));
          if (req > 0.3) limit = Math.min(limit, -req);
        }
      }
      const end = base + track.length;
      if (track.kind === 'lane') {
        if (routeIdx === x.route.length - 1) break;
        if (end > lookahead) break;
        const conn = first ? x.nextConn : this.plan(x, track, routeIdx);
        if (conn === null) {
          this.consider(x, end, 0, 0.5, null);
          x.wait = 'lane-end';
          break;
        }
        // Vehicles on the turn ahead are followed before looking for stop points: a stop
        // inside the junction (a conflict zone) can lie beyond them.
        this.divergeLeaders(x, conn, end);
        this.mergeLeaders(x, conn, end);
        if (!leaderFound) leaderFound = this.leaderOn(x, conn, end);
        const block = this.junctionBlock(x, conn, end, first, lookahead);
        if (block >= 0) {
          this.consider(x, block, 0, block === end ? 1 : 0.5, null);
          x.wait = this.reason;
          x.waitFor = this.blocker;
          break;
        }
        track = conn;
        base = end;
        routeIdx++;
        first = false;
      } else {
        if (first) {
          this.divergeLeaders(x, track, base);
          this.mergeLeaders(x, track, base);
          const block = this.zoneBlock(x, track, base, lookahead, true);
          if (block >= 0) {
            this.consider(x, block, 0, 0.5, null);
            x.wait = this.reason;
            x.waitFor = this.blocker;
            break;
          }
        }
        if (end > lookahead) break;
        track = track.to;
        base = end;
        first = false;
      }
    }
    if (x.track.kind === 'lane') this.mergeCourtesy(x, x.track);
    x.heldBy = this.interSource;
    let acc = free + this.inter;
    if (limit < acc) acc = limit;
    return clamp(acc, -MAX_DECEL, x.a);
  }

  private leaderAhead(x: Vehicle): boolean {
    const vs = x.track.vehicles;
    const i = vs.indexOf(x);
    if (i > 0) {
      const l = vs[i - 1];
      this.consider(x, l.s - l.length - x.s, l.v, x.s0, l);
      return true;
    }
    let found = false;
    for (const w of x.track.tails) {
      if (w === x) continue;
      this.consider(x, rearOn(w, x.track) - x.s, w.v, x.s0, w);
      found = true;
    }
    return found;
  }

  private leaderOn(x: Vehicle, track: AnyTrack, base: number): boolean {
    let found = false;
    const vs = track.vehicles;
    if (vs.length > 0) {
      const l = vs[vs.length - 1];
      if (l !== x) {
        this.consider(x, base + l.s - l.length, l.v, x.s0, l);
        found = true;
      }
    }
    for (const w of track.tails) {
      if (w === x) continue;
      this.consider(x, base + rearOn(w, track), w.v, x.s0, w);
      found = true;
    }
    return found;
  }

  /** Sibling turns from the same lane overlap at first: follow whoever is ahead on them. */
  private divergeLeaders(x: Vehicle, conn: Connector, baseConn: number): void {
    for (const k of conn.conflicts) {
      if (k.kind !== 'diverge') continue;
      for (const w of k.other.vehicles) {
        if (w === x) continue;
        const rear = w.s - w.length;
        if (rear >= k.otherExit) continue;
        if (baseConn + w.s <= 0) continue;
        this.consider(x, baseConn + rear, w.v, x.s0, w);
      }
    }
  }

  /**
   * Converging turns end in the same lane: whoever is closer to the end of their turn is ahead,
   * and the other follows it (zip merging) rather than treating the merge as an exclusive zone.
   */
  private mergeLeaders(x: Vehicle, conn: Connector, baseConn: number): void {
    const toEnd = baseConn + conn.length;
    for (const k of conn.conflicts) {
      if (k.kind !== 'merge') continue;
      const o = k.other;
      for (const w of o.vehicles) {
        if (w === x) continue;
        const wToEnd = o.length - w.s;
        if (wToEnd >= toEnd) continue;
        this.consider(x, toEnd - wToEnd - w.length, w.v, x.s0, w);
      }
    }
  }

  /** Leave a gap for a vehicle ahead on the next lane that urgently needs to merge into ours. */
  private mergeCourtesy(x: Vehicle, lane: Lane): void {
    for (const m of lane.mergeRequests) {
      if (m === x) continue;
      const ms = (m.s * lane.length) / m.track.length;
      const gap = ms - m.length - x.s;
      if (ms > x.s && gap > 3 && gap < 60) this.consider(x, gap, m.v, x.s0, m);
    }
  }

  /**
   * Whether the vehicle must stop for the junction at the end of a lane. Returns the distance
   * to where it must stop (the line or a conflict zone), or −1 when it may continue.
   */
  private junctionBlock(x: Vehicle, conn: Connector, distLine: number, first: boolean, lookahead: number): number {
    if (first && x.committed === conn) return this.zoneBlock(x, conn, distLine, lookahead, true);
    if (!this.linePermitted(x, conn, distLine, first)) return distLine;
    const inside = this.zoneBlock(x, conn, distLine, lookahead, false);
    // Only a permissive turn may enter and wait inside; anyone else who would have to stop in
    // the junction for traffic already committed waits at the line instead.
    if (inside >= 0 && !this.waitInside) return distLine;
    if (first && distLine <= stoppingDistance(x) + COMMIT_MARGIN) x.pendingCommit = conn;
    return inside;
  }

  private linePermitted(x: Vehicle, conn: Connector, distLine: number, first: boolean): boolean {
    const j = conn.junction;
    this.blocker = null;
    switch (j.kind) {
      case 'signal': {
        const signal = j.signal;
        if (signal === null) throw new Error(`Signal at node ${j.nodeId} has no controller`);
        const state = signal.state(conn);
        if (state === 'red') return this.deny('red-light');
        if (state === 'amber' && distLine > (x.v * x.v) / (2 * AMBER_DECEL)) return this.deny('amber-light');
        break;
      }
      case 'stop':
        if (!(first && x.stopDone && x.stopFor === j)) return this.deny('stop-sign');
        if (!this.stopTurn(x, conn)) return this.deny('stop-queue');
        break;
      case 'priority':
        if (this.mustStop(conn) && !(first && x.stopDone && x.stopFor === j)) return this.deny('stop-sign');
        break;
      case 'ring':
      case 'none':
        break;
    }
    for (const k of conn.conflicts) {
      if (k.kind === 'diverge') continue;
      if (yieldMode(conn, k, this.side) !== 'line') continue;
      if (this.conflictBlocks(x, conn, k, distLine + k.enter, false)) return this.deny('give-way');
    }
    if (j.kind !== 'none' && conn.role !== 'circulate' && !this.exitHasRoom(x, conn)) return this.deny('exit-blocked');
    return true;
  }

  private deny(reason: WaitReason): false {
    this.reason = reason;
    return false;
  }

  /** Whether entering on this connector requires coming to a full stop first. */
  private mustStop(conn: Connector): boolean {
    const j = conn.junction;
    if (j.kind === 'stop') return true;
    if (j.kind !== 'priority' || j.control.type !== 'priority' || j.control.minor !== 'stop') return false;
    if (j.majorArms === null) throw new Error(`Priority junction at node ${j.nodeId} has no major road`);
    return !j.majorArms.includes(conn.movement.fromArm);
  }

  /** All-way stop: go in arrival order, and only once conflicting traffic has cleared. */
  private stopTurn(x: Vehicle, conn: Connector): boolean {
    const runtime = conn.junction.stop;
    if (runtime === null) throw new Error(`Stop junction at node ${conn.junction.nodeId} has no queue`);
    for (const w of runtime.queue) {
      if (w === x) break;
      if (w.nextConn !== null && conflictsWith(conn, w.nextConn)) return false;
    }
    for (const k of conn.conflicts) {
      if (k.kind === 'diverge') continue;
      const o = k.other;
      for (const w of o.vehicles) if (w !== x && w.s - w.length < k.otherExit) return false;
      for (const w of o.tails) if (w !== x && rearOn(w, o) < k.otherExit) return false;
      for (const w of o.from.vehicles) if (w !== x && w.committed === o) return false;
    }
    return true;
  }

  /** Conflict zones ahead on a connector: returns the distance to where to stop, or −1. */
  private zoneBlock(x: Vehicle, conn: Connector, baseConn: number, lookahead: number, lineCommitted: boolean): number {
    this.waitInside = false;
    // Don't enter a crossing you can't clear: if the exit has jammed since we committed, wait
    // before the first crossing someone else may need rather than stopping across it.
    if (lineCommitted && conn.junction.kind !== 'none' && conn.role !== 'circulate' && !this.exitHasRoom(x, conn)) {
      for (let i = 0; i < conn.conflicts.length; i++) {
        const k = conn.conflicts[i];
        if (k.kind !== 'cross' || baseConn + k.enter < 0 || !this.zoneInUse(k)) continue;
        this.reason = 'exit-blocked';
        this.blocker = null;
        return this.stopPoint(x, conn, baseConn, i);
      }
    }
    for (let i = 0; i < conn.conflicts.length; i++) {
      const k = conn.conflicts[i];
      if (k.kind === 'diverge') continue;
      const dz = baseConn + k.enter;
      if (dz < 0) continue;
      if (dz > lookahead) break;
      const mode = yieldMode(conn, k, this.side);
      let committed: boolean;
      if (mode === 'zone') committed = x.zoneCommits.includes(k);
      else if (mode === 'line') {
        // Decided at the line; once past it only committed traffic matters.
        if (!lineCommitted) continue;
        committed = true;
      } else committed = lineCommitted;
      if (this.conflictBlocks(x, conn, k, dz, committed)) {
        this.waitInside = mode === 'zone' && !committed;
        this.reason = this.waitInside ? 'give-way' : 'conflict';
        return this.stopPoint(x, conn, baseConn, i);
      }
      if (mode === 'zone' && !committed && lineCommitted && dz <= stoppingDistance(x) + COMMIT_MARGIN) x.pendingZones.push(k);
    }
    return -1;
  }

  /**
   * Where to wait for the zone at `blockIdx`: before it, but also before any earlier zone the
   * body would still overlap there if someone could be using that zone. A car waiting inside
   * another movement's path is how junction gridlock starts.
   */
  private stopPoint(x: Vehicle, conn: Connector, baseConn: number, blockIdx: number): number {
    let p = conn.conflicts[blockIdx].enter;
    for (let i = blockIdx - 1; i >= 0; i--) {
      const j = conn.conflicts[i];
      if (j.kind === 'diverge') continue;
      // Zones are sorted by entry: once our front is past one, it is past all earlier ones too.
      if (baseConn + j.enter < 0) break;
      if (j.exit > p - x.length && this.zoneInUse(j)) p = j.enter;
    }
    return baseConn + p;
  }

  /**
   * Whether someone may need the other side of a conflict while we wait there: anyone on it or
   * overhanging it, anyone committed to it, and — unless a red light holds them — anyone heading for it.
   */
  private zoneInUse(k: Conflict): boolean {
    const o = k.other;
    if (o.vehicles.length > 0 || o.tails.length > 0) return true;
    const signal = o.junction.signal;
    const held = o.junction.kind === 'signal' && signal !== null && !signal.inCurrentPhase(o);
    for (const w of o.from.vehicles) {
      if (w.committed === o) return true;
      if (!held && w.nextConn === o) return true;
    }
    return false;
  }

  private timeTo(v: Vehicle, d: number): number {
    return timeToCover(d, v.v, v.a, Math.max(v.desiredSpeed(v.track), 2));
  }

  /**
   * Does conflict k stop vehicle x (whose front is dz metres from its zone)? Looks at everyone
   * who could be in the other connector's zone: vehicles on it, bodies still overhanging it,
   * vehicles queued or approaching on its lane, and vehicles one turn further upstream.
   */
  private conflictBlocks(x: Vehicle, conn: Connector, k: Conflict, dz: number, xCommitted: boolean): boolean {
    const o = k.other;
    const mode = yieldMode(conn, k, this.side);
    const inverse = yieldMode(o, k.mirror, this.side);
    const margin = gapMargin(conn);
    // Crossing traffic must be clear of the zone; merging traffic only has to get in ahead,
    // after which the other vehicle simply follows.
    const xClr = this.timeTo(x, dz + (k.exit - k.enter) + (k.kind === 'merge' ? 0 : x.length));
    const xSeq = xCommitted ? this.commitOrder(x, k, mode) : Infinity;
    const wOffset = k.kind === 'merge' ? k.otherExit - k.otherEnter : 0;

    // Vehicles already on a converging turn are ordered by mergeLeaders (we follow whoever is ahead).
    const merge = k.kind === 'merge';
    for (const w of o.vehicles) {
      if (w === x || merge) continue;
      if (w.s - w.length >= k.otherExit) continue;
      const wSeq = inverse === 'zone' ? this.zoneSeq(w, k.mirror) : w.commitSeq;
      if (w.s >= k.otherEnter || this.pairBlocks(xSeq, xClr, mode, w, wSeq, k.otherEnter - w.s + wOffset, margin)) {
        this.blocker = w;
        return true;
      }
    }
    for (const w of o.tails) {
      if (w !== x && !merge && rearOn(w, o) < k.otherExit) {
        this.blocker = w;
        return true;
      }
    }
    const lane = o.from;
    for (const w of lane.vehicles) {
      if (w === x || w.nextConn !== o) continue;
      const dW = lane.length - w.s + k.otherEnter;
      if (dW > HORIZON) break;
      const wSeq = inverse === 'zone' ? this.zoneSeq(w, k.mirror) : w.committed === o ? w.commitSeq : Infinity;
      if (this.pairBlocks(xSeq, xClr, mode, w, wSeq, dW + wOffset, margin)) {
        this.blocker = w;
        return true;
      }
    }
    // Priority traffic still on the turn before o's lane whose route continues through o
    // (short ring arcs and closely spaced junctions put it within reach).
    if (mode !== null && !xCommitted) {
      for (const c of lane.in) {
        for (const w of c.vehicles) {
          if (w === x) continue;
          if (w.route[w.routeIdx] !== lane.link || w.route[w.routeIdx + 1] !== o.to.link) continue;
          const dW = c.length - w.s + lane.length + k.otherEnter;
          if (dW > HORIZON) continue;
          if (this.pairBlocks(xSeq, xClr, mode, w, Infinity, dW + wOffset, margin)) {
            this.blocker = w;
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Sequence number of x's commitment that governs conflict k (a zone commit for permissive turns). */
  private commitOrder(x: Vehicle, k: Conflict, mode: YieldMode): number {
    return mode === 'zone' ? this.zoneSeq(x, k) : x.commitSeq;
  }

  private zoneSeq(x: Vehicle, k: Conflict): number {
    const i = x.zoneCommits.indexOf(k);
    return i < 0 ? Infinity : x.zoneSeqs[i];
  }

  /**
   * One-on-one right of way between x and w at a conflict (seq = Infinity means not committed).
   *  - w not committed: only matters when x must give way to it (gap acceptance); w checks x at its own line.
   *  - w committed, x not: x waits for a gap behind w, like for priority traffic.
   *  - both committed: whoever committed first goes first. That order is total, so committed
   *    vehicles can never end up waiting for each other in a circle.
   */
  private pairBlocks(xSeq: number, xClr: number, mode: YieldMode, w: Vehicle, wSeq: number, dW: number, margin: number): boolean {
    // A vehicle standing still and not pulling away is waiting for something itself and won't
    // arrive soon — waiting for it as well is how two drivers end up waiting for each other.
    // (If we then go, it sees us in the zone and waits until we are through.)
    if (w.v < 0.5 && w.acc <= 0.05) return false;
    const wArr = this.timeTo(w, dW);
    if (wSeq === Infinity) {
      if (xSeq !== Infinity || mode === null) return false;
      return wArr < xClr + margin;
    }
    if (xSeq === Infinity) return wArr < xClr + margin;
    if (wSeq > xSeq) return false;
    return wArr < xClr + 0.5;
  }

  /**
   * "Don't block the box": only enter if the exit lane will have room for us. Traffic that is
   * moving makes room as we arrive, so only slow or stopped vehicles count against the space.
   */
  private exitHasRoom(x: Vehicle, conn: Connector): boolean {
    const lane = conn.to;
    let space = lane.length;
    let lastV = 0;
    const vs = lane.vehicles;
    if (vs.length > 0) {
      const l = vs[vs.length - 1];
      space = l.s - l.length;
      lastV = l.v;
    }
    for (const w of lane.tails) {
      const r = rearOn(w, lane);
      if (r < space) {
        space = r;
        lastV = w.v;
      }
    }
    for (const c of lane.in) {
      for (const w of c.vehicles) if (w !== x && w.v < 3) space -= w.length + 1.5;
      for (const w of c.from.vehicles) if (w !== x && w.committed === c && w.v < 3) space -= w.length + 1.5;
    }
    // Traffic that is clearly flowing makes room by the time we get there; a crawling queue does not.
    const draining = lastV >= 3 ? Math.min(lastV, 8) * 2 : 0;
    return space + draining >= x.length + 1.5;
  }

  /** Free length at the start of a lane before the rear-most body on it. */
  private entrySpace(lane: Lane): number {
    let space = lane.length;
    const vs = lane.vehicles;
    if (vs.length > 0) {
      const l = vs[vs.length - 1];
      space = l.s - l.length;
    }
    for (const w of lane.tails) space = Math.min(space, rearOn(w, lane));
    return space;
  }

  /**
   * Turn to take at the end of a lane: one that reaches the next link of the route, preferring
   * a target lane that also serves the turn after, a ring lane suited to the exit, and the
   * lane with the shorter queue.
   */
  private plan(x: Vehicle, lane: Lane, routeIdx: number): Connector | null {
    const next = x.route[routeIdx + 1];
    if (next === undefined) return null;
    const after = x.route[routeIdx + 2];
    const ringLanes = next.ring !== null && lane.link.ring === null ? this.ringLanes(x.route, routeIdx + 1) : null;
    let best: Connector | null = null;
    let bestScore = -Infinity;
    for (const c of lane.out) {
      if (c.to.link !== next) continue;
      let score = Math.min(this.entrySpace(c.to), 200) * 0.05;
      if (after !== undefined && !c.to.out.some((cc) => cc.to.link === after)) score -= 100;
      if (ringLanes !== null && !ringLanes.includes(c.to.index)) score -= 50;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /**
   * Ring lanes suited to a trip entering a roundabout at route[idx], like lane markings:
   * kerb lane for the first exit, inner lane for going more than halfway round, either lane in
   * between. Balancing the through traffic across both lanes is what gives a two-lane
   * roundabout its capacity.
   */
  private ringLanes(route: Link[], idx: number): number[] {
    const link = route[idx];
    const ring = link.ring;
    if (ring === null) throw new Error('ringLanes on a non-ring link');
    const n = link.lanes.length;
    if (n === 1) return [0];
    let arcs = 0;
    for (let i = idx; i < route.length && route[i].ring === ring; i++) arcs++;
    if (arcs === 1) return [n - 1];
    if (arcs > ring.arms.length / 2) return [0];
    return link.lanes.map((l) => l.index);
  }

  /** Whether the lane leads where the driver is going next (any turn onto the next link). */
  private canProceed(route: Link[], idx: number, lane: Lane): boolean {
    const next = route[idx + 1];
    return next === undefined || lane.out.some((c) => c.to.link === next);
  }

  /** Whether the lane is one the driver wants for what comes next (respects roundabout lane use). */
  private wantsLane(route: Link[], idx: number, lane: Lane): boolean {
    const next = route[idx + 1];
    if (next === undefined) return true;
    const allowed = next.ring !== null && lane.link.ring === null ? this.ringLanes(route, idx + 1) : null;
    for (const c of lane.out) if (c.to.link === next && (allowed === null || allowed.includes(c.to.index))) return true;
    return false;
  }

  // ---------------------------------------------------------------- movement

  private move(x: Vehicle): void {
    if (x.pendingCommit !== x.committed) {
      x.committed = x.pendingCommit;
      x.commitSeq = x.committed === null ? 0 : ++this.commitCounter;
    }
    for (const k of x.pendingZones) {
      x.zoneCommits.push(k);
      x.zoneSeqs.push(++this.commitCounter);
    }
    const a = x.nextAcc;
    x.acc = a;
    let v1 = x.v + a * DT;
    let ds: number;
    if (v1 <= 0) {
      ds = a < 0 ? (x.v * x.v) / (-2 * a) : 0;
      v1 = 0;
    } else {
      ds = x.v * DT + 0.5 * a * DT * DT;
    }
    x.v = v1;
    x.s += ds;
    x.trackStops();
    while (!x.done && x.s > x.track.length) if (!this.advance(x)) break;
    if (!x.done) this.updateApproach(x);
    if (x.lateral !== 0) {
      x.lateral *= Math.exp(-DT / 0.9);
      if (Math.abs(x.lateral) < 0.02) x.lateral = 0;
    }
  }

  /** Moves the front onto the next track. Returns false when the vehicle stops advancing. */
  private advance(x: Vehicle): boolean {
    const t = x.track;
    if (t.kind === 'lane') {
      if (x.routeIdx === x.route.length - 1) {
        if (t.link.sink === null) throw new Error(`Vehicle ${x.id} reached the end of its route away from an exit`);
        this.finish(x);
        return false;
      }
      const c = x.nextConn;
      if (c === null) {
        this.incident(`Vehicle ${x.id} overran the end of a lane that does not lead onwards`);
        x.s = t.length;
        x.v = 0;
        return false;
      }
      x.s -= t.length;
      this.transfer(x, t, c);
      if (x.committed !== c) {
        // Rolled over the line without having decided to (couldn't stop in time): committed now.
        x.committed = c;
        x.commitSeq = ++this.commitCounter;
      }
      x.routeIdx++;
      if (x.stopFor !== null && x.stopFor.stop !== null) x.stopFor.stop.remove(x);
      x.stopFor = null;
      x.stopDone = false;
      x.stopTimer = 0;
      this.clearMergeRequest(x);
      return true;
    }
    x.s -= t.length;
    this.transfer(x, t, t.to);
    this.enteredLink(x, t);
    return true;
  }

  private transfer(x: Vehicle, from: AnyTrack, to: AnyTrack): void {
    removeFrom(from.vehicles, x);
    insertSorted(to.vehicles, x);
    x.track = to;
    x.tailTracks.unshift(from);
    from.tails.push(x);
  }

  private enteredLink(x: Vehicle, c: Connector): void {
    const spent = this.t - x.linkEnterTime;
    const from = c.from.link;
    from.observedTime += (spent - from.observedTime) * 0.1;
    // Roundabouts are judged by the delay on their approaches, not on the ring itself.
    if (from.ring === null) c.junction.stats.record(Math.max(0, spent - from.freeFlowTime - c.length / c.speed));
    x.linkEnterTime = this.t;
    x.committed = null;
    x.commitSeq = 0;
    x.zoneCommits.length = 0;
    x.zoneSeqs.length = 0;
    x.replanned = false;
    x.stuckTime = 0;
    x.nextConn = this.plan(x, c.to, x.routeIdx);
  }

  /** Final-approach re-plan, going round again on roundabouts, and stop-sign bookkeeping. */
  private updateApproach(x: Vehicle): void {
    if (x.track.kind !== 'lane') return;
    const lane = x.track;
    const remaining = lane.length - x.s;
    // Can't get out of the inner lane across the outer one: go round again rather than block the ring.
    if (lane.link.ring !== null && x.nextConn !== null && x.nextConn.role === 'exit' && x.committed === null) {
      if (x.v < 0.5 && remaining < 3 && (x.wait === 'give-way' || x.wait === 'conflict')) x.stuckTime += DT;
      else x.stuckTime = 0;
      if (x.stuckTime > RING_GO_AROUND) this.reroute(x, lane, x.nextConn);
    }
    if (!x.replanned && remaining < 50 && x.committed === null && x.routeIdx < x.route.length - 1) {
      x.nextConn = this.plan(x, lane, x.routeIdx);
      x.replanned = true;
    }
    const conn = x.nextConn;
    if (conn === null || !this.mustStop(conn)) {
      if (x.stopFor !== null) {
        if (x.stopFor.stop !== null) x.stopFor.stop.remove(x);
        x.stopFor = null;
        x.stopDone = false;
      }
      return;
    }
    const j = conn.junction;
    if (x.stopFor !== j) {
      x.stopFor = j;
      x.stopDone = false;
      x.stopTimer = 0;
    }
    if (x.stopDone) return;
    if (x.v < 0.3 && remaining < 3 && lane.vehicles[0] === x) {
      x.stopTimer += DT;
      if (x.stopTimer >= 1) {
        x.stopDone = true;
        if (j.stop !== null) j.stop.add(x);
      }
    }
  }

  /** Recomputes where each vehicle's rear is and which tracks its body still overlaps. */
  private updateBodies(): void {
    for (const x of this.vehicles) {
      if (x.done) continue;
      let rem = x.length - x.s;
      if (rem <= 0) {
        for (const t of x.tailTracks) removeFrom(t.tails, x);
        x.tailTracks.length = 0;
        x.rearTrack = x.track;
        x.rearPos = x.s - x.length;
        continue;
      }
      let i = 0;
      for (; i < x.tailTracks.length; i++) {
        const t = x.tailTracks[i];
        if (rem <= t.length) {
          x.rearTrack = t;
          x.rearPos = t.length - rem;
          break;
        }
        rem -= t.length;
      }
      if (i === x.tailTracks.length) {
        // The body reaches back past every track it came along (a long truck that just spawned).
        if (x.tailTracks.length === 0) {
          x.rearTrack = x.track;
          x.rearPos = x.s - x.length;
        } else {
          x.rearTrack = x.tailTracks[x.tailTracks.length - 1];
          x.rearPos = -rem;
        }
        continue;
      }
      while (x.tailTracks.length > i + 1) removeFrom(x.tailTracks.pop()!.tails, x);
    }
  }

  /** Keeps track lists ordered and records any overlap: overlaps are bugs worth seeing, not hiding. */
  private checkOrder(): void {
    const check = (list: Vehicle[]) => {
      for (let i = 0; i + 1 < list.length; i++) {
        const a = list[i];
        const b = list[i + 1];
        if (b.s > a.s) {
          list.sort((p, q) => q.s - p.s);
          this.incident(`Vehicles ${a.id} and ${b.id} swapped order`);
          return;
        }
        if (a.s - a.length < b.s - 0.05) this.incident(`Vehicles ${a.id} and ${b.id} overlap`);
      }
    };
    for (const l of this.net.lanes) if (l.vehicles.length > 1) check(l.vehicles);
    for (const c of this.net.connectors) if (c.vehicles.length > 1) check(c.vehicles);
  }

  private incident(message: string): void {
    this.metrics.recordIncident(`t=${this.t.toFixed(1)}s ${message}`);
  }

  // ---------------------------------------------------------------- lane changes

  private laneChanges(): void {
    for (const x of this.vehicles) {
      if (x.done || x.track.kind !== 'lane') continue;
      x.laneCooldown -= DT;
      x.laneTimer -= DT;
      if (x.laneTimer > 0) continue;
      x.laneTimer = 0.5;
      const lane = x.track;
      const link = lane.link;
      // No lane changing on a roundabout or while still clearing a junction.
      if (link.lanes.length < 2 || link.ring !== null) continue;
      if (x.tailTracks.length > 0 || x.committed !== null) continue;
      const remaining = lane.length - x.s;
      if (x.s < x.length + 1 || remaining < 2) continue;
      const leads = (l: Lane) => this.wantsLane(x.route, x.routeIdx, l);
      if (!leads(lane)) this.mandatoryChange(x, lane, leads, remaining);
      else if (x.laneCooldown <= 0 && remaining > 40) this.discretionaryChange(x, lane, leads);
    }
  }

  private mandatoryChange(x: Vehicle, lane: Lane, leads: (l: Lane) => boolean, remaining: number): void {
    const link = lane.link;
    const nearest = (ok: (l: Lane) => boolean) => {
      let target: Lane | null = null;
      for (const l of link.lanes) {
        if (ok(l) && (target === null || Math.abs(l.index - lane.index) < Math.abs(target.index - lane.index))) target = l;
      }
      return target;
    };
    const proceeds = (l: Lane) => this.canProceed(x.route, x.routeIdx, l);
    // Lane markings (roundabout lane use) are a preference; reaching the next road at all is not.
    const target = nearest(leads) ?? nearest(proceeds);
    if (target === null) throw new Error(`Vehicle ${x.id} follows a route no lane of link ${link.id} serves`);
    if (target === lane) return;
    const step = link.lanes[lane.index + Math.sign(target.index - lane.index)];
    if (this.safeToChange(x, step, remaining < 60 ? 4.5 : 3)) {
      this.changeLane(x, step);
      return;
    }
    if (remaining < 100) this.requestMerge(x, step);
    // Only a lane that leads nowhere useful can strand the driver; otherwise they carry on in it.
    if (!proceeds(lane) && x.v < 0.5 && remaining < 25) {
      x.stuckTime += 0.5;
      if (x.stuckTime > STUCK_REROUTE) this.reroute(x, lane, x.nextConn);
    }
  }

  private discretionaryChange(x: Vehicle, lane: Lane, leads: (l: Lane) => boolean): void {
    const here = this.laneAccel(x, lane, x.s);
    let best: Lane | null = null;
    let bestGain = 0.5;
    for (const d of [-1, 1]) {
      const l = lane.link.lanes[lane.index + d];
      if (l === undefined || !leads(l)) continue;
      const sT = (x.s * l.length) / lane.length;
      let cost = 0;
      const f = this.followerOn(l, sT);
      if (f !== null) {
        const gap = sT - x.length - f.s;
        if (gap < 1) continue;
        const before = this.laneAccel(f, l, f.s);
        const after = freeAccel(f, f.desiredSpeed(l)) + interaction(f, gap, x.v, f.s0);
        // Politeness: count part of the slowdown we would force on the new follower.
        cost = Math.max(0, before - after) * 0.3;
      }
      const gain = this.laneAccel(x, l, sT) - here - cost;
      if (gain > bestGain && this.safeToChange(x, l, 2)) {
        bestGain = gain;
        best = l;
      }
    }
    if (best !== null) this.changeLane(x, best);
  }

  /** Acceleration `x` would have at position s in `lane`, following only the vehicle ahead there. */
  private laneAccel(x: Vehicle, lane: Lane, s: number): number {
    let gap = Infinity;
    let lv = 0;
    for (const w of lane.vehicles) {
      if (w === x) continue;
      if (w.s <= s) break;
      gap = w.s - w.length - s;
      lv = w.v;
    }
    for (const w of lane.tails) {
      const g = rearOn(w, lane) - s;
      if (g > -1 && g < gap) {
        gap = g;
        lv = w.v;
      }
    }
    const free = freeAccel(x, x.desiredSpeed(lane));
    return gap === Infinity ? free : free + interaction(x, gap, lv, x.s0);
  }

  private followerOn(lane: Lane, s: number): Vehicle | null {
    for (const w of lane.vehicles) if (w.s < s) return w;
    return null;
  }

  private safeToChange(x: Vehicle, target: Lane, bSafe: number): boolean {
    const sT = (x.s * target.length) / x.track.length;
    let lead: Vehicle | null = null;
    let follow: Vehicle | null = null;
    for (const w of target.vehicles) {
      if (w.s >= sT) lead = w;
      else {
        follow = w;
        break;
      }
    }
    const free = freeAccel(x, x.desiredSpeed(target));
    if (lead !== null) {
      const gap = lead.s - lead.length - sT;
      if (gap < 1.5 || free + interaction(x, gap, lead.v, x.s0) < -bSafe) return false;
    }
    for (const w of target.tails) {
      const gap = rearOn(w, target) - sT;
      if (gap < 1.5 || free + interaction(x, gap, w.v, x.s0) < -bSafe) return false;
    }
    if (follow !== null) {
      const gap = sT - x.length - follow.s;
      if (gap < 1) return false;
      if (freeAccel(follow, follow.desiredSpeed(target)) + interaction(follow, gap, x.v, follow.s0) < -bSafe) return false;
    }
    return true;
  }

  private changeLane(x: Vehicle, target: Lane): void {
    const from = x.track as Lane;
    const sT = (x.s * target.length) / from.length;
    removeFrom(from.vehicles, x);
    x.s = sT;
    insertSorted(target.vehicles, x);
    x.track = target;
    x.rearTrack = target;
    x.rearPos = sT - x.length;
    // Keep the car where it is on screen and let it drift across into the new lane.
    x.lateral += this.side * (from.index - target.index) * LANE_WIDTH;
    x.nextConn = this.plan(x, target, x.routeIdx);
    x.laneCooldown = 3;
    x.stuckTime = 0;
    this.clearMergeRequest(x);
  }

  private requestMerge(x: Vehicle, target: Lane): void {
    if (x.mergeTarget === target) return;
    this.clearMergeRequest(x);
    x.mergeTarget = target;
    target.mergeRequests.push(x);
  }

  private clearMergeRequest(x: Vehicle): void {
    if (x.mergeTarget === null) return;
    removeFrom(x.mergeTarget.mergeRequests, x);
    x.mergeTarget = null;
  }

  /**
   * What a driver does after missing their turn: take another turn this lane offers (not
   * `avoid`) and plan again from there; if their destination is now out of reach, head for the
   * nearest reachable exit.
   */
  private reroute(x: Vehicle, lane: Lane, avoid: Connector | null): void {
    for (const c of lane.out) {
      if (c === avoid) continue;
      const r = this.router.route(c.to.link, x.dest, x.id) ?? this.router.anyExit(c.to.link, x.id);
      if (r === null) continue;
      const exit = r[r.length - 1].sink;
      if (exit === null) throw new Error('Router returned a route that does not end at an exit');
      x.route = [...x.route.slice(0, x.routeIdx + 1), ...r];
      x.dest = exit;
      x.nextConn = c;
      x.stuckTime = 0;
      this.clearMergeRequest(x);
      return;
    }
    this.incident(`Vehicle ${x.id} is trapped: no exit is reachable from link ${lane.link.id}`);
  }

  // ---------------------------------------------------------------- spawning and exits

  private finish(x: Vehicle): void {
    x.done = true;
    removeFrom(x.track.vehicles, x);
    for (const t of x.tailTracks) removeFrom(t.tails, x);
    x.tailTracks.length = 0;
    this.clearMergeRequest(x);
    const travel = this.t - x.arrivalTime;
    this.metrics.recordTrip(this.t, travel, Math.max(0, travel - x.freeFlowTime), x.stops);
  }

  private retire(): void {
    let w = 0;
    for (const x of this.vehicles) if (!x.done) this.vehicles[w++] = x;
    this.vehicles.length = w;
  }

  private spawn(): void {
    for (const st of this.gateways) {
      while (st.nextArrival <= this.t) {
        this.arrive(st, st.nextArrival);
        st.nextArrival += st.rng.exponential(st.rate);
      }
      while (st.queue.length > 0 && this.tryInsert(st, st.queue[0])) st.queue.shift();
    }
  }

  private arrive(st: GatewayState, time: number): void {
    const g = st.gateway;
    const node = this.node(g.nodeId);
    let total = 0;
    for (const d of g.reachable) total += this.destinationWeight(node, d);
    if (total <= 0) throw new Error(`Gateway ${g.nodeId} has arrivals but no destination weight`);
    let r = st.rng.next() * total;
    let dest = g.reachable[g.reachable.length - 1];
    for (const d of g.reachable) {
      r -= this.destinationWeight(node, d);
      if (r < 0) {
        dest = d;
        break;
      }
    }
    const profile = makeProfile(st.rng, this.design.traffic.truckShare);
    st.queue.push({ arrival: time, dest, profile, seed: Math.floor(st.rng.next() * 2147483647), route: null });
  }

  private tryInsert(st: GatewayState, p: Pending): boolean {
    const src = st.gateway.source;
    if (src === null) throw new Error(`Gateway ${st.gateway.nodeId} has no entry lanes`);
    if (p.route === null) {
      p.route = this.router.route(src, p.dest, p.seed);
      if (p.route === null) throw new Error(`No route from node ${st.gateway.nodeId} to node ${p.dest.nodeId}`);
    }
    const route = p.route;
    const wanted = src.lanes.filter((l) => this.wantsLane(route, 0, l));
    const candidates = wanted.length > 0 ? wanted : src.lanes.filter((l) => this.canProceed(route, 0, l));
    if (candidates.length === 0) throw new Error(`No entry lane at node ${st.gateway.nodeId} leads along the route`);
    let best = candidates[0];
    let bestSpace = this.entrySpace(best);
    for (const l of candidates) {
      const sp = this.entrySpace(l);
      if (sp > bestSpace) {
        bestSpace = sp;
        best = l;
      }
    }
    const prof = p.profile;
    if (bestSpace < prof.length + prof.s0 + 1) return false;
    const s = Math.min(prof.length, best.length);
    const vDesired = best.speed * prof.speedFactor;
    const v = Math.min(vDesired, Math.max(0, (bestSpace - s - prof.s0) / prof.T));
    const x = new Vehicle(this.nextId++, prof, best, s, v, route, p.dest, p.arrival, this.t);
    x.freeFlowTime = this.freeFlow(route);
    insertSorted(best.vehicles, x);
    x.nextConn = this.plan(x, best, 0);
    this.vehicles.push(x);
    st.spawned++;
    this.setPose(x);
    x.px = x.x;
    x.py = x.y;
    x.pheading = x.heading;
    return true;
  }

  private freeFlow(route: Link[]): number {
    let t = 0;
    for (let i = 0; i < route.length; i++) {
      t += route[i].freeFlowTime;
      const next = route[i + 1];
      if (next === undefined) break;
      const m = route[i].out.find((mv) => mv.to === next);
      if (m === undefined) throw new Error('Route contains a turn that does not exist');
      t += m.freeFlowTime;
    }
    return t;
  }

  // ---------------------------------------------------------------- rendering support

  /** Pose from the front and rear bumper positions, so bodies follow curves like real vehicles. */
  private setPose(x: Vehicle): void {
    const f = x.track.path.pose(x.s, this.front);
    const fx = f.x - f.ty * x.lateral;
    const fy = f.y + f.tx * x.lateral;
    const r = x.rearTrack.path.pose(x.rearPos, this.rear);
    const rearLateral = clamp(x.lateral * 1.6, -LANE_WIDTH, LANE_WIDTH);
    const rx = r.x - r.ty * rearLateral;
    const ry = r.y + r.tx * rearLateral;
    x.x = (fx + rx) / 2;
    x.y = (fy + ry) / 2;
    x.heading = Math.atan2(fy - ry, fx - rx);
  }
}
