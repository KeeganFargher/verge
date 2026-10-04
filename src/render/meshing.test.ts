import { Vector2 } from 'three';
import { describe, expect, it } from 'vitest';
import { MeshBuilder, dashed, ribbon } from './meshing';

describe('meshing', () => {
  it('refuses a polyline with a zero-length step instead of producing NaN vertices', () => {
    const p = new Vector2(3, 4);
    expect(() => ribbon(new MeshBuilder(), [p, p.clone()], -1, 1, 0)).toThrow();
  });

  it('leaves out a final dash shorter than the line is wide', () => {
    // Dashes of 3 m every 9 m starting 3 m in: [3, 6], [12, 15], [21, 24], then a 2 cm sliver at 30.
    const mb = new MeshBuilder();
    dashed(mb, [new Vector2(0, 0), new Vector2(30.02, 0)], 0, 0.15, 3, 6, 0);
    expect(mb.build().getAttribute('position').count).toBe(3 * 4);
  });
});
