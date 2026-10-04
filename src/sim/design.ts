/*
 * The design is the editable, serialisable description of a road network. It is what the
 * editor mutates, what undo snapshots, what presets produce and what gets saved to JSON.
 * The simulation never runs on it directly: `compileNetwork` turns it into lanes, turning
 * paths and conflict zones.
 */

export const LANE_WIDTH = 3.5;

export type DrivingSide = 'right' | 'left';

/** How signal phases are grouped: by opposing axis, with protected turn phases, or one approach at a time. */
export type SignalPlan = 'axis' | 'protected' | 'split';

export interface SignalControl {
  type: 'signal';
  plan: SignalPlan;
  actuated: boolean;
  /** Green time (s) for any phase without an entry in `greens`. */
  green: number;
  /** Per-phase green overrides keyed by phase key. Keys are built from road ids so they survive edits elsewhere. */
  greens: Record<string, number>;
  /** Actuated control bounds (s). */
  minGreen: number;
  maxGreen: number;
  /** Actuated control: end the green once no vehicle is within this many seconds of the stop line. */
  gap: number;
  amber: number;
  allRed: number;
  /** Fixed-time control: sim second at which the first phase's green starts. Used to build green waves. */
  offset: number;
}

export type RoundaboutPriority = 'circulating' | 'entering';

export interface RoundaboutControl {
  type: 'roundabout';
  /** Radius (m) of the centre line of the circulating carriageway. */
  radius: number;
  lanes: 1 | 2;
  /** Extra seconds entering drivers want between clearing the merge and the next circulating car arriving. */
  entryGap: number;
  priority: RoundaboutPriority;
}

export interface PriorityControl {
  type: 'priority';
  /** Road ids forming the major (priority) road, or null to pick the dominant pair automatically. */
  major: [number, number] | null;
  minor: 'yield' | 'stop';
}

export interface StopControl {
  type: 'stop';
}

export type NodeControl = SignalControl | RoundaboutControl | PriorityControl | StopControl;
export type ControlType = NodeControl['type'];

export interface Demand {
  /** Vehicles per hour entering the network here (before the global demand multiplier). */
  inflow: number;
  /** Relative destination weights keyed by destination node id. Destinations not listed weigh 1. */
  split: Record<string, number>;
}

export interface DesignNode {
  id: number;
  x: number;
  y: number;
  /** Junction control; only meaningful while three or more roads meet here. */
  control: NodeControl;
  /** Entry/exit settings; only meaningful while exactly one road ends here. */
  demand: Demand;
}

export interface DesignRoad {
  id: number;
  a: number;
  b: number;
  /** Lanes travelling a → b and b → a. One of them may be 0 for a one-way road. */
  lanesAB: number;
  lanesBA: number;
  /** Speed limit in km/h. */
  speed: number;
  /** Control point of a quadratic Bézier, or null for a straight road. */
  curve: { x: number; y: number } | null;
}

export interface TrafficSettings {
  /** Global multiplier applied to every entry's inflow. */
  demandScale: number;
  /** Share of spawned vehicles that are trucks (0..1). */
  truckShare: number;
  /** Seed for arrivals, routes and driver behaviour, so experiments are repeatable. */
  seed: number;
}

export interface Design {
  name: string;
  drivingSide: DrivingSide;
  nodes: DesignNode[];
  roads: DesignRoad[];
  traffic: TrafficSettings;
  nextId: number;
}

export const MAX_LANES = 4;

export function defaultSignal(): SignalControl {
  return {
    type: 'signal',
    plan: 'axis',
    actuated: false,
    green: 25,
    greens: {},
    minGreen: 6,
    maxGreen: 45,
    gap: 3,
    amber: 3,
    allRed: 2,
    offset: 0,
  };
}

export function defaultRoundabout(): RoundaboutControl {
  return { type: 'roundabout', radius: 20, lanes: 1, entryGap: 1.2, priority: 'circulating' };
}

export function defaultPriority(): PriorityControl {
  return { type: 'priority', major: null, minor: 'yield' };
}

export function defaultControl(type: ControlType): NodeControl {
  switch (type) {
    case 'signal':
      return defaultSignal();
    case 'roundabout':
      return defaultRoundabout();
    case 'priority':
      return defaultPriority();
    case 'stop':
      return { type: 'stop' };
  }
}

export function defaultDemand(): Demand {
  return { inflow: 300, split: {} };
}

export function emptyDesign(name: string, drivingSide: DrivingSide): Design {
  return {
    name,
    drivingSide,
    nodes: [],
    roads: [],
    traffic: { demandScale: 1, truckShare: 0.05, seed: 1 },
    nextId: 1,
  };
}

export function cloneDesign(d: Design): Design {
  return structuredClone(d);
}

export function nodeDegree(d: Design, nodeId: number): number {
  let n = 0;
  for (const r of d.roads) {
    if (r.a === nodeId) n++;
    if (r.b === nodeId) n++;
  }
  return n;
}

export function findNode(d: Design, id: number): DesignNode {
  const n = d.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`Node ${id} does not exist`);
  return n;
}

export function findRoad(d: Design, id: number): DesignRoad {
  const r = d.roads.find((x) => x.id === id);
  if (r === undefined) throw new Error(`Road ${id} does not exist`);
  return r;
}

/**
 * Everything that changes lane geometry. When two designs share this key the compiled
 * lanes and connectors are identical, so the running simulation can be kept and only the
 * junction controls rebound (e.g. switching signals ↔ priority, or retiming).
 */
export function geometryKey(d: Design): string {
  const nodes = d.nodes.map((n) => [
    n.id,
    n.x,
    n.y,
    n.control.type === 'roundabout' ? `R${n.control.radius}/${n.control.lanes}` : 'J',
  ]);
  const roads = d.roads.map((r) => [r.id, r.a, r.b, r.lanesAB, r.lanesBA, r.speed, r.curve?.x ?? null, r.curve?.y ?? null]);
  return JSON.stringify([d.drivingSide, nodes, roads]);
}
