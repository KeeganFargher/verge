import type { Vector2 } from 'three';
import type { SignalPlan } from './design';
import type { Arm, Junction, Movement, Phase } from './network';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Compass label of an arm from its outward direction (north is up on screen, i.e. −y). */
export function compassName(dir: Vector2): string {
  const ang = Math.atan2(dir.x, -dir.y);
  const t = Math.PI * 2;
  const wrapped = ((ang % t) + t) % t;
  return COMPASS[Math.round(wrapped / (Math.PI / 4)) % 8];
}

/**
 * Groups approach arms into signal axes: arms that roughly face each other run together
 * (their through movements don't cross), anything left over runs alone. Pairs are picked
 * greedily from the most directly opposed so a skewed 4-way still pairs sensibly.
 */
export function axisGroups(arms: readonly Arm[]): number[][] {
  const candidates: { i: number; j: number; score: number }[] = [];
  for (let x = 0; x < arms.length; x++) {
    for (let y = x + 1; y < arms.length; y++) {
      const opposition = -arms[x].dir.dot(arms[y].dir);
      if (opposition > Math.cos(Math.PI / 4)) candidates.push({ i: arms[x].index, j: arms[y].index, score: opposition });
    }
  }
  candidates.sort((p, q) => q.score - p.score);
  const used = new Set<number>();
  const groups: number[][] = [];
  for (const c of candidates) {
    if (used.has(c.i) || used.has(c.j)) continue;
    used.add(c.i);
    used.add(c.j);
    groups.push([c.i, c.j]);
  }
  for (const a of arms) if (!used.has(a.index)) groups.push([a.index]);
  groups.sort((p, q) => Math.min(...p) - Math.min(...q));
  return groups;
}

function makePhase(key: string, label: string, movements: Movement[]): Phase {
  return { key, label, movements, connectors: new Set(movements.flatMap((m) => m.connectors)) };
}

/** Builds the phase sequence for a signal plan from the junction's geometry. */
export function buildPhases(plan: SignalPlan, junction: Junction): Phase[] {
  const approaches = junction.arms.filter((a) => a.in !== null);
  const movementsOf = (arm: number) => junction.movements.filter((m) => m.fromArm === arm);
  const roadOf = (i: number) => {
    const id = junction.arms[i].roadId;
    if (id === null) throw new Error(`Signal at node ${junction.nodeId} has an arm without a road`);
    return id;
  };
  const roadKey = (group: number[]) =>
    group
      .map(roadOf)
      .sort((a, b) => a - b)
      .join('-');
  // Compass order (N before S, E before W) so labels read the conventional way round.
  const label = (group: number[]) =>
    group
      .map((i) => compassName(junction.arms[i].dir))
      .sort((a, b) => COMPASS.indexOf(a) - COMPASS.indexOf(b))
      .join('–');

  switch (plan) {
    case 'axis':
      return axisGroups(approaches).map((g) => makePhase(`axis:${roadKey(g)}`, label(g), g.flatMap(movementsOf)));
    case 'protected':
      return axisGroups(approaches).flatMap((g) => {
        const all = g.flatMap(movementsOf);
        const turns = all.filter((m) => m.turn === 'far');
        const main = all.filter((m) => m.turn !== 'far');
        if (turns.length === 0 || main.length === 0) return [makePhase(`axis:${roadKey(g)}`, label(g), all)];
        return [
          makePhase(`turn:${roadKey(g)}`, `${label(g)} turns`, turns),
          makePhase(`main:${roadKey(g)}`, label(g), main),
        ];
      });
    case 'split':
      return approaches.map((a) => makePhase(`arm:${roadOf(a.index)}`, `from ${compassName(a.dir)}`, movementsOf(a.index)));
  }
}
