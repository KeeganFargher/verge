import type { Design } from '../sim/design';
import type { Network } from '../sim/network';
import { Simulation } from '../sim/simulation';

export interface ExperimentResult {
  id: number;
  label: string;
  /** Completed trips per hour in the measured window. */
  throughput: number;
  /** Mean delay per trip (s), including time queued at the entries. */
  delay: number;
  /** Mean trip time (s). */
  travel: number;
  stops: number;
  /** Vehicles still waiting to enter at the end (unserved demand). */
  queued: number;
  incidents: number;
  minutes: number;
}

/**
 * A repeatable measurement: restart the simulation with the design's seed (same arrivals, same
 * drivers), let the network fill during a warm-up, then measure. Runs as fast as the frame
 * budget allows.
 */
export class Experiment {
  readonly sim: Simulation;
  private measuring = false;
  private readonly warmup: number;
  private readonly total: number;

  constructor(
    net: Network,
    design: Design,
    readonly label: string,
    readonly minutes: number,
    warmupMinutes: number,
  ) {
    this.sim = new Simulation(net, design);
    this.warmup = warmupMinutes * 60;
    this.total = this.warmup + minutes * 60;
  }

  get progress(): number {
    return Math.min(1, this.sim.t / this.total);
  }

  get done(): boolean {
    return this.sim.t >= this.total;
  }

  /** Advances for up to `budgetMs` of wall time. */
  advance(budgetMs: number): void {
    const until = performance.now() + budgetMs;
    while (!this.done && performance.now() < until) {
      for (let i = 0; i < 20 && !this.done; i++) this.sim.step();
      if (!this.measuring && this.sim.t >= this.warmup) {
        this.measuring = true;
        this.sim.metrics.resetWindow(this.sim.t);
        for (const j of this.sim.net.junctions) j.stats.reset();
      }
    }
  }

  result(id: number): ExperimentResult {
    if (!this.done) throw new Error('Experiment still running');
    const m = this.sim.metrics;
    return {
      id,
      label: this.label,
      throughput: m.windowThroughput(this.sim.t),
      delay: m.meanDelay,
      travel: m.meanTravel,
      stops: m.meanStops,
      queued: this.sim.queued(),
      incidents: m.incidents,
      minutes: this.minutes,
    };
  }
}
