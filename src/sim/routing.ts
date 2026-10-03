import type { Gateway, Link, Movement, Network } from './network';
import { hash01 } from './rng';

/** Extra seconds a driver expects to lose passing a junction of each kind (route choice only). */
function controlPenalty(m: Movement): number {
  const j = m.junction;
  const turn = m.turn === 'far' ? 2 : 0;
  switch (j.kind) {
    case 'signal':
      return 8 + turn;
    case 'stop':
      return 6 + turn;
    case 'priority':
      return (j.majorArms !== null && j.majorArms.includes(m.fromArm) ? 0 : 4) + turn;
    case 'ring':
      return m.from.ring === null ? 3 : 0;
    case 'none':
      return 0;
  }
}

class Heap {
  private items: { link: Link; cost: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(link: Link, cost: number): void {
    const a = this.items;
    a.push({ link, cost });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): { link: Link; cost: number } {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest-time routes over links. Costs use observed travel times, so congested roads repel
 * new traffic, and each driver perceives costs with a small personal bias so equal routes
 * share the load instead of everyone picking the same one.
 */
export class Router {
  constructor(private readonly net: Network) {}

  route(from: Link, dest: Gateway, seed: number): Link[] | null {
    const target = dest.sink;
    if (target === null) return null;
    const perceived = (link: Link) => Math.max(link.freeFlowTime, link.observedTime) * (0.85 + 0.3 * hash01(seed, link.id));
    const best = new Map<Link, number>();
    const prev = new Map<Link, Link>();
    const heap = new Heap();
    best.set(from, perceived(from));
    heap.push(from, perceived(from));
    while (heap.size > 0) {
      const { link, cost } = heap.pop();
      if (cost > (best.get(link) ?? Infinity)) continue;
      if (link === target) {
        const path = [link];
        let cur = link;
        while (cur !== from) {
          cur = prev.get(cur)!;
          path.push(cur);
        }
        return path.reverse();
      }
      for (const m of link.out) {
        const next = m.to;
        const c = cost + m.freeFlowTime + controlPenalty(m) + perceived(next);
        if (c < (best.get(next) ?? Infinity)) {
          best.set(next, c);
          prev.set(next, link);
          heap.push(next, c);
        }
      }
    }
    return null;
  }

  /** Shortest route (in links) from `from` to any exit; for drivers whose own destination is out of reach. */
  anyExit(from: Link, seed: number): Link[] | null {
    let bestRoute: Link[] | null = null;
    for (const g of this.net.gateways) {
      if (g.sink === null) continue;
      const r = this.route(from, g, seed);
      if (r !== null && (bestRoute === null || r.length < bestRoute.length)) bestRoute = r;
    }
    return bestRoute;
  }
}
