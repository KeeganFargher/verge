import type { Design, DesignNode, PriorityControl, SignalControl, SignalPlan } from './design';
import type { Connector, Junction, Network, Phase } from './network';
import { buildPhases } from './phases';
import type { Vehicle } from './vehicle';

export type LightState = 'green' | 'amber' | 'red';
type Stage = 'green' | 'amber' | 'allred';

/** Vehicles further than this from the stop line are not seen by actuated detection. */
const DETECTION_RANGE = 60;

/**
 * Traffic signal controller. Fixed-time signals are a pure function of the sim clock (so
 * retiming or changing the offset takes effect immediately and coordinated corridors stay in
 * step); actuated signals are stateful and react to detected demand.
 */
export class SignalRuntime {
  phase = 0;
  stage: Stage = 'green';
  /** Seconds spent in the current stage. */
  elapsed = 0;

  constructor(
    readonly junction: Junction,
    readonly phases: Phase[],
    readonly plan: SignalPlan,
  ) {
    if (phases.length === 0) throw new Error(`Signal at node ${junction.nodeId} has no phases`);
  }

  get control(): SignalControl {
    const c = this.junction.control;
    if (c.type !== 'signal') throw new Error(`Junction at node ${this.junction.nodeId} is not a signal`);
    return c;
  }

  greenTime(i: number): number {
    const c = this.control;
    return c.greens[this.phases[i].key] ?? c.green;
  }

  cycleLength(): number {
    const c = this.control;
    let total = 0;
    for (let i = 0; i < this.phases.length; i++) total += this.greenTime(i) + c.amber + c.allRed;
    return total;
  }

  inCurrentPhase(c: Connector): boolean {
    return this.phases[this.phase].connectors.has(c);
  }

  state(c: Connector): LightState {
    if (!this.inCurrentPhase(c)) return 'red';
    return this.stage === 'green' ? 'green' : this.stage === 'amber' ? 'amber' : 'red';
  }

  /** Seconds until the current stage ends (fixed-time), or null when actuated control decides on the fly. */
  remaining(): number | null {
    const c = this.control;
    if (c.actuated && this.stage === 'green') return null;
    const total = this.stage === 'green' ? this.greenTime(this.phase) : this.stage === 'amber' ? c.amber : c.allRed;
    return Math.max(0, total - this.elapsed);
  }

  step(t: number, dt: number): void {
    if (this.control.actuated) this.stepActuated(dt);
    else this.syncFixed(t);
  }

  private syncFixed(t: number): void {
    const c = this.control;
    const cycle = this.cycleLength();
    let pos = (((t - c.offset) % cycle) + cycle) % cycle;
    for (let i = 0; i < this.phases.length; i++) {
      const g = this.greenTime(i);
      if (pos < g) return this.set(i, 'green', pos);
      pos -= g;
      if (pos < c.amber) return this.set(i, 'amber', pos);
      pos -= c.amber;
      if (pos < c.allRed) return this.set(i, 'allred', pos);
      pos -= c.allRed;
    }
    this.set(0, 'green', 0);
  }

  private set(phase: number, stage: Stage, elapsed: number): void {
    this.phase = phase;
    this.stage = stage;
    this.elapsed = elapsed;
  }

  private stepActuated(dt: number): void {
    const c = this.control;
    this.elapsed += dt;
    if (this.stage === 'green') {
      if (this.elapsed < c.minGreen) return;
      const othersWaiting = this.phases.some((_, i) => i !== this.phase && this.demand(i, c.gap).present);
      // Rest in green while nobody else is waiting.
      if (!othersWaiting) return;
      if (this.elapsed >= c.maxGreen || !this.demand(this.phase, c.gap).arriving) this.set(this.phase, 'amber', 0);
    } else if (this.stage === 'amber') {
      if (this.elapsed >= c.amber) this.set(this.phase, 'allred', 0);
    } else if (this.elapsed >= c.allRed) {
      this.set(this.nextPhaseWithDemand(), 'green', 0);
    }
  }

  private nextPhaseWithDemand(): number {
    const n = this.phases.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.phase + k) % n;
      if (this.demand(i, this.control.gap).present) return i;
    }
    return (this.phase + 1) % n;
  }

  /** Detector reading for a phase: anyone waiting/approaching, and anyone due at the line within `gap` seconds. */
  demand(i: number, gap: number): { present: boolean; arriving: boolean } {
    const phase = this.phases[i];
    let present = false;
    let arriving = false;
    for (const m of phase.movements) {
      for (const lane of m.lanes) {
        for (const v of lane.vehicles) {
          const d = lane.length - v.s;
          if (d > DETECTION_RANGE) break;
          if (v.nextConn === null || !phase.connectors.has(v.nextConn)) continue;
          present = true;
          // A queue that is just starting to move still counts as arriving.
          if (d / Math.max(v.v, 2) <= gap) arriving = true;
        }
      }
    }
    return { present, arriving };
  }
}

/** All-way stop: vehicles that have stopped at the line, in arrival order. */
export class StopRuntime {
  readonly queue: Vehicle[] = [];

  add(v: Vehicle): void {
    if (!this.queue.includes(v)) this.queue.push(v);
  }

  remove(v: Vehicle): void {
    const i = this.queue.indexOf(v);
    if (i >= 0) this.queue.splice(i, 1);
  }
}

/** Arms forming the major road of a priority junction. */
export function resolveMajorArms(j: Junction, control: PriorityControl): [number, number] {
  if (control.major !== null) {
    const [ra, rb] = control.major;
    const a = j.arms.find((x) => x.roadId === ra);
    const b = j.arms.find((x) => x.roadId === rb);
    if (a === undefined || b === undefined) {
      throw new Error(`Priority junction at node ${j.nodeId} names a major road that does not meet it`);
    }
    return [a.index, b.index];
  }
  // The dominant pair: widest roads first, then the most directly opposed.
  let best: [number, number] = [0, 1];
  let bestScore = -Infinity;
  for (let x = 0; x < j.arms.length; x++) {
    for (let y = x + 1; y < j.arms.length; y++) {
      const ax = j.arms[x];
      const ay = j.arms[y];
      const lanes = ax.halfWidth + ay.halfWidth;
      const opposition = -ax.dir.dot(ay.dir);
      const score = lanes * 10 + opposition * 5;
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = [ax.index, ay.index];
      }
    }
  }
  return best;
}

/**
 * Points every junction at the design's current control settings. Geometry is untouched, so
 * this is how control swaps and retiming are applied to a running simulation.
 */
export function bindControls(net: Network, design: Design): void {
  const nodes = new Map<number, DesignNode>(design.nodes.map((n) => [n.id, n]));
  for (const j of net.junctions) {
    const node = nodes.get(j.nodeId);
    if (node === undefined) throw new Error(`Junction references missing node ${j.nodeId}`);
    j.control = node.control;
    if (j.kind === 'none') continue;
    if (j.ring !== null) {
      if (node.control.type !== 'roundabout') throw new Error(`Node ${node.id} lost its roundabout without a rebuild`);
      continue;
    }
    const control = node.control;
    switch (control.type) {
      case 'roundabout':
        throw new Error(`Node ${node.id} became a roundabout without a rebuild`);
      case 'priority':
        j.kind = 'priority';
        j.majorArms = resolveMajorArms(j, control);
        j.signal = null;
        j.stop = null;
        j.phases = [];
        break;
      case 'stop':
        j.kind = 'stop';
        j.majorArms = null;
        j.signal = null;
        // A stop junction that stays a stop junction keeps its arrival queue.
        if (j.stop === null) j.stop = new StopRuntime();
        j.phases = [];
        break;
      case 'signal': {
        j.kind = 'signal';
        j.majorArms = null;
        j.stop = null;
        // Keep the running controller when only timings changed so the lights don't jump.
        if (j.signal === null || j.signal.plan !== control.plan) {
          j.phases = buildPhases(control.plan, j);
          j.signal = new SignalRuntime(j, j.phases, control.plan);
        }
        break;
      }
    }
  }
}
