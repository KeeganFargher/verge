import type { Turn } from './network';

/*
 * Lane-use rules for a junction approach. Lanes are indexed from the centre line (0, which
 * serves far-side turns: left in right-hand traffic) towards the kerb (which serves
 * near-side turns). Movements arrive sorted from far-side to near-side.
 */

/**
 * Which incoming lanes serve each movement. Returns, per movement, the lane indices it may
 * use. The rules mirror common road markings:
 *   1 lane  — shared by every movement
 *   2 lanes — inner: far + straight, outer: straight + near
 *   3+      — inner: far only, middle: straight, outer: straight + near
 * Without a straight movement (the stem of a T) the inner half turns far and the outer half near.
 */
export function assignLanes(laneCount: number, turns: readonly Turn[]): number[][] {
  if (laneCount < 1) throw new Error('assignLanes needs at least one lane');
  const result: number[][] = turns.map(() => []);
  if (turns.length === 0) return result;
  const idx = (t: Turn) => turns.flatMap((x, i) => (x === t ? [i] : []));
  const far = idx('far');
  const straight = idx('straight');
  const near = idx('near');
  const give = (lane: number, movements: number[]) => {
    for (const m of movements) result[m].push(lane);
  };

  if (laneCount === 1) {
    give(0, turns.map((_, i) => i));
    return result;
  }

  if (straight.length === 0) {
    if (far.length === 0 || near.length === 0) {
      for (let l = 0; l < laneCount; l++) give(l, far.length === 0 ? near : far);
      return result;
    }
    const innerCount = Math.ceil(laneCount / 2);
    for (let l = 0; l < laneCount; l++) give(l, l < innerCount ? far : near);
    return result;
  }

  if (laneCount === 2) {
    give(0, far.length > 0 ? [...far, ...straight] : straight);
    give(1, near.length > 0 ? [...straight, ...near] : straight);
    return result;
  }

  give(0, far.length > 0 ? far : straight);
  for (let l = 1; l < laneCount - 1; l++) give(l, straight);
  give(laneCount - 1, near.length > 0 ? [...straight, ...near] : straight);
  return result;
}

/**
 * Pairs `a` incoming lanes (of one movement, inner-most first) with the `k` lanes of the
 * exit. Far-side turns and straight movements align on the inner lanes, near-side turns on
 * the kerb lanes. Surplus incoming lanes squeeze into the nearest exit lane (lane drop).
 * With `fan`, extra exit lanes are reachable from the closest incoming lane (lane gain, the
 * driver picks); without it a turn goes into the nearest lane, as drivers are taught —
 * fanning a turn into the far lanes makes it swing wide across opposing turns.
 */
export function mapLanes(a: number, k: number, align: 'inner' | 'outer', fan: boolean): number[][] {
  if (a < 1 || k < 1) throw new Error('mapLanes needs at least one lane on each side');
  const res: number[][] = [];
  for (let p = 0; p < a; p++) {
    if (align === 'inner') {
      const q = Math.min(p, k - 1);
      const lanes = [q];
      if (fan && p === a - 1) for (let x = q + 1; x < k; x++) lanes.push(x);
      res.push(lanes);
    } else {
      const q = Math.max(0, k - a + p);
      const lanes: number[] = [];
      if (fan && p === 0) for (let x = 0; x < q; x++) lanes.push(x);
      lanes.push(q);
      res.push(lanes);
    }
  }
  return res;
}
