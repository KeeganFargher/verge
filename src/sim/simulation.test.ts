import { describe, expect, it } from 'vitest';
import { DesignBuilder } from '../presets/builder';
import { defaultRoundabout, defaultSignal, type Design, type DrivingSide, type NodeControl } from './design';
import { compileNetwork } from './compile';
import { Simulation } from './simulation';
import type { Vehicle } from './vehicle';

/** Bodies shrunk a little so vehicles squeezing past at a merge or mid lane-change don't count. */
function overlaps(a: Vehicle, b: Vehicle): boolean {
  const axes = [a.heading, a.heading + Math.PI / 2, b.heading, b.heading + Math.PI / 2];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const half = (v: Vehicle, ang: number) => {
    const c = Math.abs(Math.cos(v.heading - ang));
    const s = Math.abs(Math.sin(v.heading - ang));
    return 0.45 * v.length * c + 0.4 * v.width * s;
  };
  for (const ang of axes) {
    const d = Math.abs(dx * Math.cos(ang) + dy * Math.sin(ang));
    if (d > half(a, ang) + half(b, ang)) return false;
  }
  return true;
}

function run(design: Design, minutes: number) {
  const net = compileNetwork(design);
  const sim = new Simulation(net, design);
  const collisions: string[] = [];
  const steps = Math.round((minutes * 60) / sim.dt);
  for (let i = 0; i < steps; i++) {
    sim.step();
    if (i % 5 !== 0) continue;
    const vs = sim.vehicles;
    for (let p = 0; p < vs.length; p++) {
      for (let q = p + 1; q < vs.length; q++) {
        const a = vs[p];
        const b = vs[q];
        if (Math.abs(a.x - b.x) > 15 || Math.abs(a.y - b.y) > 15) continue;
        if (overlaps(a, b) && collisions.length < 10) {
          collisions.push(`t=${sim.t.toFixed(1)} ${a.id}(${a.track.kind}${a.track.id}) × ${b.id}(${b.track.kind}${b.track.id})`);
        }
      }
    }
  }
  return { sim, net, collisions };
}

function crossroads(control: NodeControl, opts: { lanes?: number; inflow?: number; side?: DrivingSide } = {}) {
  const b = new DesignBuilder('crossroads', opts.side ?? 'right');
  const c = b.node(0, 0, control);
  const inflow = opts.inflow ?? 400;
  const [n, e, s, w] = [b.gate(0, -250, inflow), b.gate(250, 0, inflow), b.gate(0, 250, inflow), b.gate(-250, 0, inflow)];
  for (const g of [n, e, s, w]) b.road(g, c, { lanes: opts.lanes ?? 1 });
  b.split(n, { [s]: 3, [e]: 1, [w]: 1 });
  b.split(s, { [n]: 3, [e]: 1, [w]: 1 });
  b.split(e, { [w]: 3, [n]: 1, [s]: 1 });
  b.split(w, { [e]: 3, [n]: 1, [s]: 1 });
  return b.design;
}

/**
 * Healthy = nothing overlapped, no vehicle hit an impossible state, entries are not backing up
 * (demand is being served) and trips complete at roughly the demanded rate.
 */
function expectHealthy(result: ReturnType<typeof run>, minTrips: number) {
  const { sim, collisions } = result;
  expect(sim.metrics.incidentLog).toEqual([]);
  expect(collisions).toEqual([]);
  expect(sim.queued()).toBeLessThanOrEqual(5);
  expect(sim.metrics.trips).toBeGreaterThan(minTrips);
}

describe('simulation', () => {
  it('runs a signalised crossroads without collisions', () => {
    const r = run(crossroads(defaultSignal(), { lanes: 2, inflow: 500 }), 15);
    // 4 × 500 veh/h for 15 min ≈ 500 arrivals, of which the last minute or so is still driving.
    expectHealthy(r, 420);
  });

  it('runs actuated and protected-turn signal plans', () => {
    expectHealthy(run(crossroads({ ...defaultSignal(), actuated: true }, { lanes: 2, inflow: 400 }), 12), 280);
    expectHealthy(run(crossroads({ ...defaultSignal(), plan: 'protected' }, { lanes: 2, inflow: 400 }), 12), 250);
    expectHealthy(run(crossroads({ ...defaultSignal(), plan: 'split' }, { lanes: 2, inflow: 300 }), 12), 180);
  });

  it('runs single and two-lane roundabouts', () => {
    expectHealthy(run(crossroads(defaultRoundabout(), { lanes: 1, inflow: 400 }), 15), 340);
    expectHealthy(run(crossroads({ ...defaultRoundabout(), lanes: 2, radius: 25 }, { lanes: 2, inflow: 600 }), 15), 500);
  });

  it('runs an all-way stop', () => {
    expectHealthy(run(crossroads({ type: 'stop' }, { inflow: 150 }), 15), 120);
  });

  it('runs a priority T-junction', () => {
    const b = new DesignBuilder('tee');
    const c = b.node(0, 0);
    const w = b.gate(-250, 0, 400);
    const e = b.gate(250, 0, 400);
    const s = b.gate(0, 250, 150);
    b.road(w, c);
    b.road(c, e);
    b.road(c, s);
    b.split(w, { [e]: 3, [s]: 1 });
    b.split(e, { [w]: 3, [s]: 1 });
    // 950 veh/h for 15 minutes ≈ 237 arrivals.
    expectHealthy(run(b.design, 15), 200);
  });

  it('mirrors everything for left-hand traffic', () => {
    expectHealthy(run(crossroads(defaultSignal(), { lanes: 2, inflow: 400, side: 'left' }), 12), 260);
    expectHealthy(run(crossroads(defaultRoundabout(), { lanes: 1, inflow: 400, side: 'left' }), 12), 260);
  });

  it('merges a lane drop', () => {
    const b = new DesignBuilder('drop');
    const a = b.gate(-300, 0, 1400);
    const m = b.node(0, 0);
    const z = b.gate(300, 0, 0);
    b.road(a, m, { lanesAB: 2, lanesBA: 0 });
    b.road(m, z, { lanesAB: 1, lanesBA: 0 });
    expectHealthy(run(b.design, 10), 150);
  });

  it('runs a grid of signalised junctions with route choice', () => {
    const b = new DesignBuilder('grid');
    const size = 3;
    const spacing = 160;
    const nodes: number[][] = [];
    for (let r = 0; r < size; r++) {
      nodes.push([]);
      for (let c = 0; c < size; c++) nodes[r].push(b.node(c * spacing, r * spacing, defaultSignal()));
    }
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (c + 1 < size) b.road(nodes[r][c], nodes[r][c + 1]);
        if (r + 1 < size) b.road(nodes[r][c], nodes[r + 1][c]);
      }
    }
    const far = (size - 1) * spacing;
    for (let i = 0; i < size; i++) {
      b.road(b.gate(i * spacing, -200, 150), nodes[0][i]);
      b.road(b.gate(i * spacing, far + 200, 150), nodes[size - 1][i]);
      b.road(b.gate(-200, i * spacing, 150), nodes[i][0]);
      b.road(b.gate(far + 200, i * spacing, 150), nodes[i][size - 1]);
    }
    // 12 entries × 150 veh/h for 15 min = 450 arrivals.
    expectHealthy(run(b.design, 15), 330);
  });

  it('keeps a roundabout safe when entering traffic has priority', () => {
    expectHealthy(run(crossroads({ ...defaultRoundabout(), priority: 'entering' }, { lanes: 1, inflow: 200 }), 10), 100);
  });

  it('is deterministic for a given seed', () => {
    const d = crossroads(defaultSignal(), { lanes: 2, inflow: 400 });
    const a = run(d, 5).sim;
    const b = run(d, 5).sim;
    expect(a.metrics.trips).toBe(b.metrics.trips);
    expect(a.metrics.delaySum).toBeCloseTo(b.metrics.delaySum, 9);
  });
});
