import { Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { presets } from '../presets';
import { compileNetwork } from '../sim/compile';
import { NetworkView } from './NetworkView';

describe('NetworkView', () => {
  for (const p of presets) {
    for (const side of ['right', 'left'] as const) {
      it(`meshes ${p.name} (${side}-hand traffic) with finite vertices`, () => {
        const view = new NetworkView();
        view.build(compileNetwork(p.build(side)));
        let bad = 0;
        view.group.traverse((o) => {
          if (!(o instanceof Mesh)) return;
          for (const v of o.geometry.getAttribute('position').array) if (!Number.isFinite(v)) bad++;
        });
        expect(bad).toBe(0);
      });
    }
  }
});
