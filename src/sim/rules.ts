import type { Conflict, Connector } from './network';

/*
 * Right of way between two connectors of the same junction. `yieldMode(c, k)` answers: must
 * a vehicle on connector c give way to vehicles on k.other? Every pair of conflicting
 * movements gets exactly one answer per side, so two drivers never both wait for each other.
 *
 *   'line' — give way before crossing the stop/yield line (minor roads, roundabout entries)
 *   'zone' — enter the junction and wait at the conflict point (permissive turns across oncoming traffic)
 *   null   — no obligation (the other side yields, or the signal keeps them apart)
 */
export type YieldMode = 'line' | 'zone' | null;

const TURN_RANK = { straight: 3, near: 2, far: 1 } as const;

export function yieldMode(c: Connector, k: Conflict, side: 1 | -1): YieldMode {
  if (k.kind === 'diverge') return null;
  const o = k.other;
  const j = c.junction;
  switch (j.kind) {
    case 'none':
      if (sameApproach(c, o)) return laneShiftYields(c, o) ? 'line' : null;
      return approachYields(c, o, side) ? 'line' : null;
    case 'stop':
      // First come, first served — handled by the stop queue, not by priorities.
      return null;
    case 'priority': {
      const major = j.majorArms;
      if (major === null) throw new Error(`Priority junction at node ${j.nodeId} has no major road`);
      const rc = major.includes(c.movement.fromArm) ? 2 : 1;
      const ro = major.includes(o.movement.fromArm) ? 2 : 1;
      if (rc !== ro) return rc < ro ? 'line' : null;
      return turnRule(c, o, side, rc === 2);
    }
    case 'signal': {
      const signal = j.signal;
      if (signal === null) throw new Error(`Signal junction at node ${j.nodeId} has no controller`);
      // Only movements released together need rules; everything else is separated by red lights.
      if (!signal.inCurrentPhase(c) || !signal.inCurrentPhase(o)) return null;
      return turnRule(c, o, side, true);
    }
    case 'ring': {
      if (j.control.type !== 'roundabout') throw new Error(`Ring junction at node ${j.nodeId} lost its roundabout control`);
      const entering = j.control.priority === 'entering';
      const rc = ringRank(c, entering);
      const ro = ringRank(o, entering);
      if (rc !== ro) return rc < ro ? 'line' : null;
      return laneShiftYields(c, o) ? 'line' : null;
    }
  }
}

/**
 * Ring priorities: circulating traffic first, then traffic leaving (on two-lane rings an
 * inner-lane car leaving crosses the outer lane and gives way to it — or goes round again),
 * entering traffic last. With priority to entering traffic the order flips.
 */
function ringRank(c: Connector, entering: boolean): number {
  switch (c.role) {
    case 'circulate':
      return entering ? 1 : 3;
    case 'exit':
      return 2;
    case 'entry':
      return entering ? 3 : 1;
    case null:
      throw new Error('Ring junction connector without a role');
  }
}

function sameApproach(c: Connector, o: Connector): boolean {
  return c.from.link === o.from.link;
}

/** Within one approach, the vehicle that shifts across more lanes gives way (a zip merge), outer lane last. */
function laneShiftYields(c: Connector, o: Connector): boolean {
  const sc = Math.abs(c.from.index - c.to.index);
  const so = Math.abs(o.from.index - o.to.index);
  if (sc !== so) return sc > so;
  if (c.from.index !== o.from.index) return c.from.index > o.from.index;
  return c.id > o.id;
}

/**
 * Between movements of equal standing: straight beats near-side turns beats far-side turns.
 * A far-side turn across a straight movement waits inside the junction when `waitInside`
 * (permissive turns at signals and turns off the major road), otherwise at the line.
 */
function turnRule(c: Connector, o: Connector, side: 1 | -1, waitInside: boolean): YieldMode {
  if (sameApproach(c, o)) return laneShiftYields(c, o) ? 'line' : null;
  const tc = TURN_RANK[c.movement.turn];
  const to = TURN_RANK[o.movement.turn];
  const wait: YieldMode = waitInside && c.movement.turn === 'far' ? 'zone' : 'line';
  if (tc !== to) return tc > to ? null : wait;
  return approachYields(c, o, side) ? wait : null;
}

/**
 * Tie-break by approach: give way to traffic coming from your near side (priority to the right
 * in right-hand traffic, mirrored for left-hand traffic). Approaches that face each other fall
 * back to a fixed order so the relation stays one-sided.
 */
function approachYields(c: Connector, o: Connector, side: 1 | -1): boolean {
  const arms = c.junction.arms;
  const mine = arms[c.movement.fromArm].dir;
  const theirs = arms[o.movement.fromArm].dir;
  const ix = -mine.x;
  const iy = -mine.y;
  const along = ix * theirs.x + iy * theirs.y;
  if (Math.abs(along) < 0.75) return side * (ix * theirs.y - iy * theirs.x) > 0;
  return c.movement.fromArm > o.movement.fromArm;
}

/** Extra seconds a giving-way driver wants between clearing the conflict and the other vehicle arriving. */
export function gapMargin(c: Connector): number {
  const j = c.junction;
  switch (j.kind) {
    case 'ring':
      if (j.control.type !== 'roundabout') throw new Error('Ring junction without roundabout control');
      return j.control.entryGap;
    case 'priority':
      return 1.6;
    case 'signal':
      return 1.2;
    case 'stop':
      return 1.0;
    case 'none':
      return 0.6;
  }
}
