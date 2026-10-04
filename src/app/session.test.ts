import { describe, expect, it } from 'vitest';
import { updateNode } from '../editor/ops';
import { presetById } from '../presets';
import { cloneDesign, defaultControl, type Design } from '../sim/design';
import { Session } from './session';

function signalNode(d: Design): number {
  const n = d.nodes.find((x) => x.control.type === 'signal');
  if (n === undefined) throw new Error('Preset has no signalised junction');
  return n.id;
}

describe('Session', () => {
  it('ends a running experiment when the seed changes, and the replaced run cannot drive on', () => {
    const d = presetById('crossroads-signals').build('right');
    const s = new Session(d);
    const exp = s.startExperiment(d, 'signals', 10, 5);
    s.sim.run(60);
    const next = cloneDesign(d);
    next.traffic.seed += 1;
    s.change(d, next);
    expect(s.experiment).toBeNull();
    // The app advances whatever experiment it holds; a stale one would move vehicles on the
    // network the new run now drives on.
    expect(() => exp.advance(5)).toThrow();
    s.sim.run(120);
    expect(s.sim.metrics.incidentLog).toEqual([]);
    expect(s.sim.metrics.trips).toBeGreaterThan(0);
  });

  it('ends a running experiment when a junction is swapped, keeping the traffic moving', () => {
    const d = presetById('crossroads-signals').build('right');
    const s = new Session(d);
    s.startExperiment(d, 'signals', 10, 5);
    s.sim.run(60);
    const sim = s.sim;
    const next = updateNode(d, signalNode(d), (n) => (n.control = defaultControl('stop')));
    expect(s.change(d, next)).toBe(false);
    expect(s.experiment).toBeNull();
    expect(s.sim).toBe(sim);
    expect(s.sim.vehicles.length).toBeGreaterThan(0);
  });
});
