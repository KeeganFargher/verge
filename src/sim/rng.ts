/** Small seeded PRNG (mulberry32). Experiments must be repeatable, so nothing in the sim uses Math.random. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Exponentially distributed interval for a Poisson process with the given rate (events/s). */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Deterministic hash of two integers into [0, 1). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function mixSeed(a: number, b: number): number {
  return Math.floor(hash01(a, b) * 4294967296) >>> 0;
}
