import {
  defaultPriority,
  emptyDesign,
  type Design,
  type DrivingSide,
  type NodeControl,
} from '../sim/design';

export interface RoadOptions {
  /** Lanes in each direction (shorthand for lanesAB = lanesBA). */
  lanes?: number;
  lanesAB?: number;
  lanesBA?: number;
  /** km/h */
  speed?: number;
  curve?: { x: number; y: number } | null;
}

/** Terse construction of designs for presets and tests. */
export class DesignBuilder {
  readonly design: Design;

  constructor(name: string, side: DrivingSide = 'right') {
    this.design = emptyDesign(name, side);
  }

  private id(): number {
    return this.design.nextId++;
  }

  /** A junction or bend node. */
  node(x: number, y: number, control: NodeControl = defaultPriority()): number {
    const id = this.id();
    this.design.nodes.push({ id, x, y, control, demand: { inflow: 0, split: {} } });
    return id;
  }

  /** A network entry/exit (dead end) with an inflow in vehicles per hour. */
  gate(x: number, y: number, inflow: number, split: Record<number, number> = {}): number {
    const id = this.id();
    const s: Record<string, number> = {};
    for (const [k, v] of Object.entries(split)) s[k] = v;
    this.design.nodes.push({ id, x, y, control: defaultPriority(), demand: { inflow, split: s } });
    return id;
  }

  road(a: number, b: number, opts: RoadOptions = {}): number {
    const id = this.id();
    const lanes = opts.lanes ?? 1;
    this.design.roads.push({
      id,
      a,
      b,
      lanesAB: opts.lanesAB ?? lanes,
      lanesBA: opts.lanesBA ?? lanes,
      speed: opts.speed ?? 50,
      curve: opts.curve ?? null,
    });
    return id;
  }

  /** Sets destination weights of an entry. */
  split(gate: number, weights: Record<number, number>): void {
    const n = this.design.nodes.find((x) => x.id === gate);
    if (n === undefined) throw new Error(`No node ${gate}`);
    for (const [k, v] of Object.entries(weights)) n.demand.split[k] = v;
  }
}
