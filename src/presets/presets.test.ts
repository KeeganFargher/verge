import { describe, expect, it } from 'vitest';
import { compileNetwork } from '../sim/compile';
import { Simulation } from '../sim/simulation';
import { presets } from './index';

describe('presets', () => {
  for (const p of presets) {
    for (const side of ['right', 'left'] as const) {
      it(`${p.name} (${side}-hand traffic) compiles and runs cleanly`, () => {
        const design = p.build(side);
        const net = compileNetwork(design);
        expect(net.warnings).toEqual([]);
        const sim = new Simulation(net, design);
        sim.run(240);
        expect(sim.metrics.incidentLog).toEqual([]);
        if (design.roads.length > 0) expect(sim.metrics.trips).toBeGreaterThan(0);
      });
    }
  }
});
