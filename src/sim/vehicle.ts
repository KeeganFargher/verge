import type { AnyTrack, Conflict, Connector, Gateway, Junction, Lane, Link, Track } from './network';

export type VehicleKind = 'car' | 'truck';

/** Why a vehicle is holding back, for the inspector and for debugging stuck traffic. */
export type WaitReason =
  | 'red-light'
  | 'amber-light'
  | 'stop-sign'
  | 'stop-queue'
  | 'give-way'
  | 'conflict'
  | 'exit-blocked'
  | 'lane-end';

/** Physical size and driving style of one vehicle (Intelligent Driver Model parameters). */
export interface Profile {
  kind: VehicleKind;
  length: number;
  width: number;
  /** Maximum acceleration (m/s²). */
  a: number;
  /** Comfortable deceleration (m/s²). */
  b: number;
  /** Desired time headway (s). */
  T: number;
  /** Minimum standstill gap (m). */
  s0: number;
  /** Multiplier on the speed limit this driver aims for. */
  speedFactor: number;
  color: number;
}

export class Vehicle {
  readonly kind: VehicleKind;
  readonly length: number;
  readonly width: number;
  readonly a: number;
  readonly b: number;
  readonly T: number;
  readonly s0: number;
  readonly speedFactor: number;
  readonly color: number;

  /** Track the front bumper is on, and its arc length along it. */
  track: AnyTrack;
  s: number;
  v: number;
  acc = 0;
  /** Acceleration decided this step, applied in the move phase (keeps decisions order-independent). */
  nextAcc = 0;
  /** Tracks behind `track` that the body still covers, nearest first. */
  readonly tailTracks: AnyTrack[] = [];
  /** Where the rear bumper is: a track (the oldest tail, or `track` itself) and a position on it. */
  rearTrack: AnyTrack;
  rearPos: number;

  route: Link[];
  /** Index into `route` of the link the vehicle is on, or is turning into while on a connector. */
  routeIdx = 0;
  dest: Gateway;
  /** Turn planned at the end of the current lane. */
  nextConn: Connector | null = null;
  /** Whether the turn was re-planned on the final approach (once, with fresher queue information). */
  replanned = false;

  /** Connector the vehicle has committed to enter at the junction ahead (or is driving on). */
  committed: Connector | null = null;
  /** When it committed (a global sequence): among committed vehicles, first committed goes first. */
  commitSeq = 0;
  /** Conflicts of type "wait inside the junction" the vehicle has decided to go through, with their sequence numbers. */
  readonly zoneCommits: Conflict[] = [];
  readonly zoneSeqs: number[] = [];
  pendingCommit: Connector | null = null;
  readonly pendingZones: Conflict[] = [];

  /** What the vehicle is currently stopping for (null when only following traffic or free). */
  wait: WaitReason | null = null;
  /** The vehicle it is giving way to, when that is the reason. */
  waitFor: Vehicle | null = null;
  /** The vehicle whose presence currently limits its acceleration most (leader, merge partner...). */
  heldBy: Vehicle | null = null;

  /** Stop-sign state for the junction at the end of the current lane. */
  stopFor: Junction | null = null;
  stopTimer = 0;
  stopDone = false;

  /** Visual lateral offset (m, right of travel) while drifting into a new lane. */
  lateral = 0;
  laneTimer = 0;
  laneCooldown = 0;
  /** Lane this vehicle asked to be let into. */
  mergeTarget: Lane | null = null;
  /** Seconds spent unable to reach a lane that leads onwards. */
  stuckTime = 0;

  readonly arrivalTime: number;
  freeFlowTime = 0;
  linkEnterTime: number;
  stops = 0;
  private moving = false;
  done = false;

  /** Render pose (plan coordinates) after the latest step and the one before, for interpolation. */
  x = 0;
  y = 0;
  heading = 0;
  px = 0;
  py = 0;
  pheading = 0;

  constructor(
    readonly id: number,
    profile: Profile,
    lane: Lane,
    s: number,
    v: number,
    route: Link[],
    dest: Gateway,
    arrivalTime: number,
    now: number,
  ) {
    this.kind = profile.kind;
    this.length = profile.length;
    this.width = profile.width;
    this.a = profile.a;
    this.b = profile.b;
    this.T = profile.T;
    this.s0 = profile.s0;
    this.speedFactor = profile.speedFactor;
    this.color = profile.color;
    this.track = lane;
    this.s = s;
    this.v = v;
    this.rearTrack = lane;
    this.rearPos = s - this.length;
    this.route = route;
    this.dest = dest;
    this.arrivalTime = arrivalTime;
    this.linkEnterTime = now;
    this.moving = v > 2;
  }

  /** Counts a stop each time the vehicle comes to (nearly) a standstill after moving. */
  trackStops(): void {
    if (this.moving && this.v < 0.5) {
      this.moving = false;
      this.stops++;
    } else if (!this.moving && this.v > 2) {
      this.moving = true;
    }
  }

  /** Speed this driver wants on the given track. */
  desiredSpeed(track: Track): number {
    return Math.max(1, track.speed * this.speedFactor);
  }
}

/** Free-road term of the IDM. Above the desired speed it brakes firmly but boundedly (IIDM), unlike plain IDM. */
export function freeAccel(x: Vehicle, v0: number): number {
  const v = x.v;
  if (v <= v0) return x.a * (1 - (v / v0) ** 4);
  return -x.b * (1 - (v0 / v) ** ((4 * x.a) / x.b));
}

/** Interaction term of the IDM for a leader (or a standing obstacle with leaderV = 0) at `gap` metres. */
export function interaction(x: Vehicle, gap: number, leaderV: number, s0: number): number {
  const v = x.v;
  const sStar = s0 + Math.max(0, v * x.T + (v * (v - leaderV)) / (2 * Math.sqrt(x.a * x.b)));
  const g = Math.max(gap, 0.1);
  return -x.a * (sStar / g) ** 2;
}

/** Time (s) to cover `d` metres from speed v, accelerating at `a` up to `vmax`. */
export function timeToCover(d: number, v: number, a: number, vmax: number): number {
  if (d <= 0) return 0;
  if (v >= vmax) return d / vmax;
  const t1 = (vmax - v) / a;
  const d1 = v * t1 + 0.5 * a * t1 * t1;
  if (d <= d1) return (-v + Math.sqrt(v * v + 2 * a * d)) / a;
  return t1 + (d - d1) / vmax;
}

/** Distance needed to stop at comfortable deceleration. */
export function stoppingDistance(x: Vehicle): number {
  return (x.v * x.v) / (2 * x.b);
}
