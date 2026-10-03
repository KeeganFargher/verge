import { compileNetwork } from '../sim/compile';
import { geometryKey, type Design } from '../sim/design';
import type { Network } from '../sim/network';
import { Simulation } from '../sim/simulation';
import { Experiment } from './experiment';

/**
 * The live run: the compiled network, the simulation driving on it and the experiment measuring
 * it, if any. Kept apart from App (which needs WebGL) so the rules for what survives an edit can
 * be tested headless.
 */
export class Session {
  net: Network;
  sim: Simulation;
  experiment: Experiment | null = null;

  constructor(design: Design) {
    this.net = compileNetwork(design);
    this.sim = new Simulation(this.net, design);
  }

  /**
   * Moves the run from `prev` to the edited design `next`. Geometry edits need a new network;
   * parameter edits are applied to the running simulation so traffic carries on, except a new
   * seed, which is new demand and so a new run. Throws CompileError (leaving the session as it
   * was) when `next` is not a valid network. Returns whether the network was rebuilt.
   */
  change(prev: Design, next: Design): boolean {
    const rebuild = geometryKey(next) !== geometryKey(prev);
    // Compile before touching anything, so a rejected edit leaves the current run intact.
    const net = rebuild ? compileNetwork(next) : this.net;
    // An experiment measures one design; carrying on would blend two designs into one result.
    this.experiment = null;
    if (rebuild || next.traffic.seed !== prev.traffic.seed) {
      this.net = net;
      this.sim = new Simulation(net, next);
    } else {
      this.sim.setDesign(next);
    }
    return rebuild;
  }

  restart(design: Design): void {
    this.experiment = null;
    this.sim = new Simulation(this.net, design);
  }

  startExperiment(design: Design, label: string, minutes: number, warmupMinutes: number): Experiment {
    this.experiment = new Experiment(this.net, design, label, minutes, warmupMinutes);
    this.sim = this.experiment.sim;
    return this.experiment;
  }
}
