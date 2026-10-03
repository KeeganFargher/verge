import { describe, expect, it } from 'vitest';
import { DesignBuilder } from '../presets/builder';
import { defaultRoundabout, defaultSignal, type DrivingSide, type NodeControl } from './design';
import { CompileError, compileNetwork } from './compile';
import { assignLanes, mapLanes } from './lanes';
import { buildPhases } from './phases';
import { makePose } from './geometry';

function crossroads(control: NodeControl, lanes = 2, side: DrivingSide = 'right') {
  const b = new DesignBuilder('test', side);
  const c = b.node(0, 0, control);
  const gates = [b.gate(0, -200, 300), b.gate(200, 0, 300), b.gate(0, 200, 300), b.gate(-200, 0, 300)];
  for (const g of gates) b.road(g, c, { lanes });
  return { design: b.design, center: c, gates };
}

describe('lane assignment', () => {
  it('shares a single lane between all movements', () => {
    expect(assignLanes(1, ['far', 'straight', 'near'])).toEqual([[0], [0], [0]]);
  });

  it('uses inner lane for far turns and outer lane for near turns on two lanes', () => {
    expect(assignLanes(2, ['far', 'straight', 'near'])).toEqual([[0], [0, 1], [1]]);
  });

  it('gives three-lane approaches an exclusive far-turn lane', () => {
    expect(assignLanes(3, ['far', 'straight', 'near'])).toEqual([[0], [1, 2], [2]]);
  });

  it('splits a T-junction stem between the two turns', () => {
    expect(assignLanes(2, ['far', 'near'])).toEqual([[0], [1]]);
  });

  it('maps lanes with fan-out on lane gain and merging on lane drop', () => {
    expect(mapLanes(1, 2, 'inner', true)).toEqual([[0, 1]]);
    expect(mapLanes(3, 2, 'inner', true)).toEqual([[0], [1], [1]]);
    expect(mapLanes(1, 2, 'outer', true)).toEqual([[0, 1]]);
    expect(mapLanes(2, 3, 'outer', true)).toEqual([[0, 1], [2]]);
  });

  it('turns into the nearest lane without fanning out', () => {
    expect(mapLanes(1, 2, 'inner', false)).toEqual([[0]]);
    expect(mapLanes(1, 3, 'outer', false)).toEqual([[2]]);
  });
});

describe('compileNetwork', () => {
  it('builds a four-way junction with lanes, turns and conflicts', () => {
    const { design } = crossroads(defaultSignal());
    const net = compileNetwork(design);
    expect(net.links).toHaveLength(8);
    expect(net.gateways).toHaveLength(4);
    expect(net.junctions).toHaveLength(1);
    const j = net.junctions[0];
    expect(j.kind).toBe('signal');
    expect(j.movements).toHaveLength(12);
    // Per approach: far turn 1 (nearest lane only), straight 2 (lane 0→0, 1→1), near turn 1.
    expect(j.connectors).toHaveLength(16);
    for (const g of net.gateways) expect(g.reachable).toHaveLength(3);

    // Every turning path starts where its lane ends and ends where the next lane starts.
    const p = makePose();
    const q = makePose();
    for (const c of j.connectors) {
      c.from.path.pose(c.from.length, p);
      c.path.pose(0, q);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-6);
      c.to.path.pose(0, p);
      c.path.pose(c.length, q);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-6);
    }

    // A far-side (left) turn crosses the opposing straight movement.
    const far = j.movements.find((m) => m.turn === 'far')!;
    const opposing = j.movements.find((m) => m.turn === 'straight' && m.from.fromNode === far.to.toNode)!;
    const crosses = far.connectors.some((c) => c.conflicts.some((k) => k.kind === 'cross' && opposing.connectors.includes(k.other)));
    expect(crosses).toBe(true);
  });

  it('keeps traffic on the right or left according to the driving side', () => {
    for (const side of ['right', 'left'] as const) {
      const { design } = crossroads({ type: 'stop' }, 1, side);
      const net = compileNetwork(design);
      // The link heading south (from the north gate towards the centre) drives on its right
      // in right-hand traffic: with y pointing south, its right is west (negative x).
      const southbound = net.links.find((l) => l.lanes[0].path.ys[0] < l.lanes[0].path.ys[l.lanes[0].path.pointCount - 1] && l.lanes[0].path.ys[0] < -100)!;
      const x = southbound.lanes[0].path.xs[0];
      if (side === 'right') expect(x).toBeLessThan(0);
      else expect(x).toBeGreaterThan(0);
    }
  });

  it('compiles a roundabout into ring arcs and arm junctions circulating the right way', () => {
    for (const side of ['right', 'left'] as const) {
      const { design } = crossroads(defaultRoundabout(), 1, side);
      const net = compileNetwork(design);
      expect(net.roundabouts).toHaveLength(1);
      const ring = net.roundabouts[0];
      expect(ring.arcs).toHaveLength(4);
      expect(ring.junctions).toHaveLength(4);
      // Find the arc passing the east arm's downstream side and check its direction of travel.
      const arc = ring.arcs.find((l) => {
        const p = l.lanes[0].path.pointAt(l.length / 2);
        return p.x > 0 && Math.abs(p.y) < 18;
      });
      const anyArc = ring.arcs[0].lanes[0].path;
      const a = anyArc.pointAt(0);
      const b = anyArc.pointAt(anyArc.length);
      // Cross product of position and direction: negative = counter-clockwise on screen (y down).
      const turn = a.x * (b.y - a.y) - a.y * (b.x - a.x);
      if (side === 'right') expect(turn).toBeLessThan(0);
      else expect(turn).toBeGreaterThan(0);
      expect(arc === undefined || arc.ring === ring).toBe(true);
      for (const j of ring.junctions) {
        expect(j.kind).toBe('ring');
        const entry = j.connectors.find((c) => c.role === 'entry')!;
        const circulating = j.connectors.find((c) => c.role === 'circulate')!;
        expect(entry.conflicts.some((k) => k.other === circulating)).toBe(true);
      }
    }
  });

  it('builds signal phase plans from the geometry', () => {
    const { design } = crossroads(defaultSignal());
    const j = compileNetwork(design).junctions[0];
    expect(buildPhases('axis', j)).toHaveLength(2);
    expect(buildPhases('protected', j)).toHaveLength(4);
    expect(buildPhases('split', j)).toHaveLength(4);
    const labels = buildPhases('axis', j).map((p) => p.label).sort();
    expect(labels).toEqual(['E–W', 'N–S']);
  });

  it('rejects roads too short to fit between junctions', () => {
    const b = new DesignBuilder('short');
    const a = b.node(0, 0, defaultSignal());
    const c = b.node(10, 0, defaultSignal());
    b.road(a, c);
    b.road(a, b.gate(0, -100, 0));
    b.road(a, b.gate(0, 100, 0));
    b.road(c, b.gate(10, -100, 0));
    b.road(c, b.gate(10, 100, 0));
    expect(() => compileNetwork(b.design)).toThrow(CompileError);
  });

  it('rejects roads meeting at a hairpin angle', () => {
    const b = new DesignBuilder('sharp');
    const c = b.node(0, 0);
    b.road(c, b.gate(200, 0, 0));
    b.road(c, b.gate(200, 20, 0));
    b.road(c, b.gate(-200, 0, 0));
    expect(() => compileNetwork(b.design)).toThrow(CompileError);
  });
});
