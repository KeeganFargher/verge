import { Vector2 } from 'three';
import { describe, expect, it } from 'vitest';
import { emptyDesign, nodeDegree } from '../sim/design';
import { compileNetwork } from '../sim/compile';
import { drawRoad, moveNode, removeNode, removeRoad, splitRoad } from './ops';

const draft = { lanesAB: 1, lanesBA: 1, speed: 50 };

describe('editor operations', () => {
  it('draws a road between two free points', () => {
    const { design } = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: 0, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft);
    expect(design.nodes).toHaveLength(2);
    expect(design.roads).toHaveLength(1);
    expect(() => compileNetwork(design)).not.toThrow();
  });

  it('creates a junction where a new road crosses an existing one', () => {
    let d = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: -200, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft).design;
    d = drawRoad(d, { kind: 'free', x: 0, y: -200 }, { kind: 'free', x: 0, y: 200 }, null, draft).design;
    expect(d.roads).toHaveLength(4);
    const center = d.nodes.find((n) => Math.hypot(n.x, n.y) < 1);
    expect(center).toBeDefined();
    expect(nodeDegree(d, center!.id)).toBe(4);
    const net = compileNetwork(d);
    expect(net.junctions.filter((j) => j.kind === 'priority')).toHaveLength(1);
  });

  it('crosses an existing road with a curved one and keeps the pieces curved', () => {
    let d = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: -200, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft).design;
    d = drawRoad(d, { kind: 'free', x: -150, y: -150 }, { kind: 'free', x: 150, y: 150 }, new Vector2(-150, 150), draft).design;
    expect(d.roads).toHaveLength(4);
    const curved = d.roads.filter((r) => r.curve !== null);
    expect(curved).toHaveLength(2);
    expect(() => compileNetwork(d)).not.toThrow();
  });

  it('connects to the middle of a road by splitting it', () => {
    let d = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: 0, y: 0 }, { kind: 'free', x: 300, y: 0 }, null, draft).design;
    d = drawRoad(d, { kind: 'road', id: d.roads[0].id, x: 150, y: 0 }, { kind: 'free', x: 150, y: 200 }, null, draft).design;
    expect(d.roads).toHaveLength(3);
    const tee = d.nodes.find((n) => Math.abs(n.x - 150) < 1 && Math.abs(n.y) < 1)!;
    expect(nodeDegree(d, tee.id)).toBe(3);
  });

  it('chains from an existing node', () => {
    const first = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: 0, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft);
    const second = drawRoad(first.design, { kind: 'node', id: first.end }, { kind: 'free', x: 200, y: 200 }, null, draft);
    expect(second.design.roads).toHaveLength(2);
    expect(nodeDegree(second.design, first.end)).toBe(2);
  });

  it('refuses to connect two nodes twice', () => {
    const first = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: 0, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft);
    const [a, b] = first.design.nodes;
    expect(() => drawRoad(first.design, { kind: 'node', id: a.id }, { kind: 'node', id: b.id }, null, draft)).toThrow();
  });

  it('removes roads and the nodes they leave behind', () => {
    let d = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: 0, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft).design;
    d = removeRoad(d, d.roads[0].id);
    expect(d.roads).toHaveLength(0);
    expect(d.nodes).toHaveLength(0);
  });

  it('removes a junction with all its roads', () => {
    let d = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: -200, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft).design;
    d = drawRoad(d, { kind: 'free', x: 0, y: -200 }, { kind: 'free', x: 0, y: 200 }, null, draft).design;
    const center = d.nodes.find((n) => Math.hypot(n.x, n.y) < 1)!;
    d = removeNode(d, center.id);
    expect(d.roads).toHaveLength(0);
    expect(d.nodes).toHaveLength(0);
  });

  it('splits a curved road keeping its shape', () => {
    let d = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: 0, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft).design;
    d.roads[0].curve = { x: 100, y: 100 };
    const mid = splitRoad(d, d.roads[0].id, 0.5);
    const node = d.nodes.find((n) => n.id === mid)!;
    expect(node.x).toBeCloseTo(100, 6);
    expect(node.y).toBeCloseTo(50, 6);
    expect(d.roads.every((r) => r.curve !== null)).toBe(true);
  });

  it('moves a node', () => {
    const first = drawRoad(emptyDesign('t', 'right'), { kind: 'free', x: 0, y: 0 }, { kind: 'free', x: 200, y: 0 }, null, draft);
    const moved = moveNode(first.design, first.end, 250, 40);
    const n = moved.nodes.find((x) => x.id === first.end)!;
    expect([n.x, n.y]).toEqual([250, 40]);
  });
});
