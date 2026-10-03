import type { Vector2 } from 'three';
import type { DesignRoad, DrivingSide, NodeControl, RoundaboutControl } from './design';
import type { Path } from './geometry';
import type { Vehicle } from './vehicle';
import type { SignalRuntime, StopRuntime } from './controls';

/*
 * Compiled network: the runtime graph vehicles drive on. Built from a Design by
 * `compileNetwork`; rebuilt from scratch whenever geometry changes.
 *
 *   Link      a directed road (one direction of a design road, or a roundabout ring arc)
 *   Lane      one lane of a link — a Track
 *   Movement  a permitted turn through a junction from one link to another
 *   Connector the turning path from one lane to one lane — also a Track
 *   Conflict  where two connectors of a junction come close enough that vehicles on both collide
 */

export type Turn = 'far' | 'straight' | 'near';
export type JunctionKind = 'none' | 'priority' | 'stop' | 'signal' | 'ring';
export type RingRole = 'circulate' | 'entry' | 'exit';

export abstract class Track {
  abstract readonly kind: 'lane' | 'connector';
  readonly length: number;
  /** Vehicles whose front is on this track, ordered front-most first. */
  readonly vehicles: Vehicle[] = [];
  /** Vehicles whose front has moved on but whose body still overlaps this track. */
  readonly tails: Vehicle[] = [];

  constructor(
    readonly id: number,
    readonly path: Path,
    /** Speed (m/s) drivers aim for here: the limit on lanes, a curvature-limited speed on turns. */
    readonly speed: number,
  ) {
    this.length = path.length;
  }
}

/** The concrete tracks; use this (not Track) wherever code needs to tell lanes and connectors apart. */
export type AnyTrack = Lane | Connector;

export class Lane extends Track {
  readonly kind = 'lane' as const;
  /** Connectors leaving the end of this lane. */
  readonly out: Connector[] = [];
  /** Connectors arriving at the start of this lane. */
  readonly in: Connector[] = [];
  /** Vehicles on a neighbouring lane that urgently need to merge in; followers here make room for them. */
  readonly mergeRequests: Vehicle[] = [];

  constructor(
    id: number,
    path: Path,
    speed: number,
    readonly link: Link,
    /** 0 is the lane next to the centre line (serves far-side turns), increasing towards the kerb. */
    readonly index: number,
  ) {
    super(id, path, speed);
  }
}

export class Connector extends Track {
  readonly kind = 'connector' as const;
  /** Conflicts with other connectors of the same junction, sorted by where they start along this path. */
  conflicts: Conflict[] = [];

  constructor(
    id: number,
    path: Path,
    speed: number,
    readonly junction: Junction,
    readonly movement: Movement,
    readonly from: Lane,
    readonly to: Lane,
    /** Role inside a roundabout arm junction; null elsewhere. */
    readonly role: RingRole | null,
  ) {
    super(id, path, speed);
  }
}

export class Conflict {
  /** The same conflict seen from `other`; linked right after both halves are created. */
  mirror!: Conflict;

  constructor(
    readonly other: Connector,
    /** cross: paths intersect; merge: they end in the same lane; diverge: they start from the same lane. */
    readonly kind: 'cross' | 'merge' | 'diverge',
    /** Zone on the owning connector (arc lengths). */
    readonly enter: number,
    readonly exit: number,
    /** Zone on `other`. */
    readonly otherEnter: number,
    readonly otherExit: number,
  ) {}
}

export class Link {
  readonly lanes: Lane[] = [];
  /** Movements leaving the end of this link. */
  readonly out: Movement[] = [];
  startJunction: Junction | null = null;
  endJunction: Junction | null = null;
  source: Gateway | null = null;
  sink: Gateway | null = null;
  /** Free-flow traversal time (s) of the link itself. */
  freeFlowTime = 0;
  /** Smoothed observed traversal time (s) including the delay at its end; used for route choice. */
  observedTime = 0;

  constructor(
    readonly id: number,
    /** Design road this link belongs to; null for roundabout ring arcs. */
    readonly roadId: number | null,
    readonly ring: Roundabout | null,
    readonly fromNode: number,
    readonly toNode: number,
  ) {}

  get length(): number {
    return this.lanes[0].length;
  }
}

export class Movement {
  readonly connectors: Connector[] = [];
  /** Incoming lanes that serve this movement, inner-most first. */
  readonly lanes: Lane[] = [];
  freeFlowTime = 0;

  constructor(
    readonly id: number,
    readonly junction: Junction,
    readonly from: Link,
    readonly to: Link,
    readonly turn: Turn,
    /** Arm indices inside the junction (indices into junction.arms). */
    readonly fromArm: number,
    readonly toArm: number,
  ) {}
}

export interface Arm {
  readonly index: number;
  /** Design road of this arm; null for roundabout ring arcs. */
  readonly roadId: number | null;
  /** Unit direction pointing away from the junction along the road. */
  readonly dir: Vector2;
  /** Point where the arm's lanes end/start (the trimmed road end, on the road centre line). */
  readonly end: Vector2;
  readonly halfWidth: number;
  readonly in: Link | null;
  readonly out: Link | null;
}

export interface Phase {
  /** Stable key (from road ids) used to store per-phase timing in the design. */
  readonly key: string;
  readonly label: string;
  readonly movements: Movement[];
  readonly connectors: Set<Connector>;
}

export class JunctionStats {
  /** Vehicles that completed a pass through the junction (approach + turn). */
  passed = 0;
  /** Sum of their delays (s): time on the approach and turn minus the free-flow time. */
  delaySum = 0;
  /** Exponentially smoothed delay for the live view. */
  recentDelay = 0;

  reset(): void {
    this.passed = 0;
    this.delaySum = 0;
    this.recentDelay = 0;
  }

  record(delay: number): void {
    this.passed++;
    this.delaySum += delay;
    this.recentDelay = this.passed === 1 ? delay : this.recentDelay * 0.95 + delay * 0.05;
  }

  get meanDelay(): number {
    return this.passed === 0 ? 0 : this.delaySum / this.passed;
  }
}

export class Junction {
  readonly movements: Movement[] = [];
  readonly connectors: Connector[] = [];
  readonly incoming: Link[] = [];
  readonly outgoing: Link[] = [];
  arms: Arm[] = [];
  /** Outline of the paved junction area (empty for roundabout arm junctions, drawn by the roundabout). */
  polygon: Vector2[] = [];
  /** How the junction is currently controlled. Mutable: control swaps are applied to a running simulation. */
  kind: JunctionKind;
  /** Live control parameters from the design (the same object the editor edits). */
  control: NodeControl;
  /** Priority junctions: the two arms forming the major road. */
  majorArms: [number, number] | null = null;
  phases: Phase[] = [];
  signal: SignalRuntime | null = null;
  stop: StopRuntime | null = null;
  readonly stats = new JunctionStats();

  constructor(
    readonly id: number,
    /** Design node this junction was compiled from. */
    readonly nodeId: number,
    kind: JunctionKind,
    control: NodeControl,
    readonly center: Vector2,
    readonly ring: Roundabout | null,
  ) {
    this.kind = kind;
    this.control = control;
  }
}

export class Gateway {
  /** Destinations reachable from this entry. */
  reachable: Gateway[] = [];

  constructor(
    readonly nodeId: number,
    readonly position: Vector2,
    /** Link vehicles enter on (null when every lane points into the gateway: exit only). */
    readonly source: Link | null,
    /** Link vehicles leave by (null when every lane points away: entry only). */
    readonly sink: Link | null,
  ) {}
}

export interface RingArm {
  readonly roadId: number;
  /** Angle (plan coordinates, atan2(y, x)) of the arm around the roundabout centre. */
  readonly angle: number;
  /** Angular half-width of the arm junction region along the ring (rad). */
  readonly halfSpan: number;
  readonly dir: Vector2;
  readonly end: Vector2;
  readonly halfWidth: number;
}

export class Roundabout {
  readonly arcs: Link[] = [];
  readonly junctions: Junction[] = [];
  readonly arms: RingArm[] = [];

  constructor(
    readonly nodeId: number,
    readonly center: Vector2,
    readonly control: RoundaboutControl,
    readonly rInner: number,
    readonly rOuter: number,
    /** +1 when travel increases the polar angle (clockwise on screen), −1 otherwise. */
    readonly circulation: 1 | -1,
  ) {}
}

export class CompiledRoad {
  ab: Link | null = null;
  ba: Link | null = null;

  constructor(
    readonly design: DesignRoad,
    /** Centre line between the trimmed ends, oriented a → b. */
    readonly center: Path,
    readonly width: number,
    /** Lateral position (right of a → b) of the line separating the two directions. */
    readonly divider: number,
  ) {}
}

export class Network {
  readonly roads: CompiledRoad[] = [];
  readonly links: Link[] = [];
  readonly lanes: Lane[] = [];
  readonly connectors: Connector[] = [];
  readonly junctions: Junction[] = [];
  readonly gateways: Gateway[] = [];
  readonly roundabouts: Roundabout[] = [];
  readonly warnings: string[] = [];
  readonly junctionsByNode = new Map<number, Junction[]>();
  readonly gatewaysByNode = new Map<number, Gateway>();
  readonly roadsById = new Map<number, CompiledRoad>();

  constructor(
    readonly drivingSide: DrivingSide,
    /** +1 for right-hand traffic, −1 for left-hand traffic. Mirrors every side-dependent rule. */
    readonly side: 1 | -1,
  ) {}
}
