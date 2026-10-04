import { defaultRoundabout, defaultSignal, type Design, type DrivingSide, type NodeControl } from '../sim/design';
import { emptyDesign } from '../sim/design';
import { DesignBuilder } from './builder';

export interface Preset {
  id: string;
  name: string;
  description: string;
  build: (side: DrivingSide) => Design;
}

/** A four-arm junction with a 60/20/20 straight/left/right split from every arm. */
function crossroads(name: string, side: DrivingSide, control: NodeControl, lanes: number, inflow: number, speed = 50): Design {
  const b = new DesignBuilder(name, side);
  const c = b.node(0, 0, control);
  const arm = 260;
  const n = b.gate(0, -arm, inflow);
  const e = b.gate(arm, 0, inflow);
  const s = b.gate(0, arm, inflow);
  const w = b.gate(-arm, 0, inflow);
  for (const g of [n, e, s, w]) b.road(g, c, { lanes, speed });
  b.split(n, { [s]: 3, [e]: 1, [w]: 1 });
  b.split(s, { [n]: 3, [e]: 1, [w]: 1 });
  b.split(e, { [w]: 3, [n]: 1, [s]: 1 });
  b.split(w, { [e]: 3, [n]: 1, [s]: 1 });
  return b.design;
}

/** An east–west arterial crossed by side streets; `control` decides what each crossing is. */
function arterial(name: string, side: DrivingSide, control: (i: number) => NodeControl): Design {
  const b = new DesignBuilder(name, side);
  const count = 5;
  const spacing = 260;
  const x0 = -((count - 1) * spacing) / 2;
  const west = b.gate(x0 - 300, 0, 900);
  const east = b.gate(-x0 + 300, 0, 900);
  const nodes: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + i * spacing;
    const j = b.node(x, 0, control(i));
    nodes.push(j);
    b.road(b.gate(x, -220, 180), j, { lanes: 1, speed: 40 });
    b.road(b.gate(x, 220, 180), j, { lanes: 1, speed: 40 });
  }
  b.road(west, nodes[0], { lanes: 2, speed: 60 });
  for (let i = 0; i + 1 < count; i++) b.road(nodes[i], nodes[i + 1], { lanes: 2, speed: 60 });
  b.road(nodes[count - 1], east, { lanes: 2, speed: 60 });
  // Most arterial traffic stays on the arterial.
  b.split(west, { [east]: 6 });
  b.split(east, { [west]: 6 });
  return b.design;
}

export const presets: Preset[] = [
  {
    id: 'crossroads-signals',
    name: 'Crossroads · Signals',
    description: 'Two-lane four-way junction under fixed-time two-phase signals. Left turns filter through gaps in oncoming traffic.',
    build: (side) => crossroads('Crossroads · Signals', side, defaultSignal(), 2, 600),
  },
  {
    id: 'crossroads-roundabout',
    name: 'Crossroads · Roundabout',
    description: 'The same junction and demand as a two-lane roundabout. Compare it with the signals.',
    build: (side) => crossroads('Crossroads · Roundabout', side, { ...defaultRoundabout(), radius: 26, lanes: 2 }, 2, 600),
  },
  {
    id: 'crossroads-stop',
    name: 'Crossroads · All-way stop',
    description: 'Single-lane four-way stop. Fine at low volumes, watch it saturate as demand grows.',
    build: (side) => crossroads('Crossroads · All-way stop', side, { type: 'stop' }, 1, 200, 40),
  },
  {
    id: 'tee',
    name: 'T-junction · Priority',
    description: 'A side road joining a busy main road. Side-road drivers wait for gaps in both directions.',
    build: (side) => {
      const b = new DesignBuilder('T-junction · Priority', side);
      const c = b.node(0, 0);
      const w = b.gate(-320, 0, 500);
      const e = b.gate(320, 0, 500);
      const s = b.gate(0, 260, 220);
      b.road(w, c, { speed: 60 });
      b.road(c, e, { speed: 60 });
      b.road(c, s, { speed: 40 });
      b.split(w, { [e]: 4, [s]: 1 });
      b.split(e, { [w]: 4, [s]: 1 });
      return b.design;
    },
  },
  {
    id: 'grid',
    name: 'Downtown grid',
    description: 'Nine signalised blocks with traffic entering from every edge. Drivers re-route around congestion.',
    build: (side) => {
      const b = new DesignBuilder('Downtown grid', side);
      const size = 3;
      const spacing = 170;
      const nodes: number[][] = [];
      const o = -((size - 1) * spacing) / 2;
      for (let r = 0; r < size; r++) {
        nodes.push([]);
        for (let c = 0; c < size; c++) nodes[r].push(b.node(o + c * spacing, o + r * spacing, { ...defaultSignal(), green: 20 }));
      }
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (c + 1 < size) b.road(nodes[r][c], nodes[r][c + 1], { speed: 40 });
          if (r + 1 < size) b.road(nodes[r][c], nodes[r + 1][c], { speed: 40 });
        }
      }
      for (let i = 0; i < size; i++) {
        const p = o + i * spacing;
        b.road(b.gate(p, o - 200, 160), nodes[0][i], { speed: 40 });
        b.road(b.gate(p, -o + 200, 160), nodes[size - 1][i], { speed: 40 });
        b.road(b.gate(o - 200, p, 160), nodes[i][0], { speed: 40 });
        b.road(b.gate(-o + 200, p, 160), nodes[i][size - 1], { speed: 40 });
      }
      return b.design;
    },
  },
  {
    id: 'green-wave',
    name: 'Arterial · Green wave',
    description: 'Five signals on a 60 km/h arterial, offset so eastbound platoons hit green after green.',
    build: (side) =>
      arterial('Arterial · Green wave', side, (i) => ({
        ...defaultSignal(),
        green: 30,
        greens: {},
        // 260 m between signals at ~57 km/h ≈ 16.5 s: each light turns green as the platoon arrives.
        offset: Math.round(i * 16.5),
      })),
  },
  {
    id: 'roundabout-corridor',
    name: 'Arterial · Roundabouts',
    description: 'The green-wave arterial with every signal swapped for a two-lane roundabout.',
    build: (side) => arterial('Arterial · Roundabouts', side, () => ({ ...defaultRoundabout(), radius: 22, lanes: 2 })),
  },
  {
    id: 'lane-drop',
    name: 'Lane drop',
    description: 'Three lanes squeeze into two. Push the demand up to see the queue build at the merge.',
    build: (side) => {
      const b = new DesignBuilder('Lane drop', side);
      const a = b.gate(-500, 0, 2600);
      const m = b.node(0, 0);
      const z = b.gate(500, 0, 0);
      b.road(a, m, { lanesAB: 3, lanesBA: 0, speed: 80 });
      b.road(m, z, { lanesAB: 2, lanesBA: 0, speed: 80 });
      return b.design;
    },
  },
  {
    id: 'blank',
    name: 'Blank canvas',
    description: 'Nothing yet. Pick the road tool and start drawing, or drop in a map screenshot to trace.',
    build: (side) => emptyDesign('Untitled', side),
  },
];

export function presetById(id: string): Preset {
  const p = presets.find((x) => x.id === id);
  if (p === undefined) throw new Error(`Unknown preset ${id}`);
  return p;
}
