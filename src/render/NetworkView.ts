import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  QuadraticBezierCurve,
  ShapeUtils,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
} from 'three';
import { LANE_WIDTH } from '../sim/design';
import { makePose } from '../sim/geometry';
import type { Connector, Junction, Lane, Link, Network, Roundabout } from '../sim/network';
import { MeshBuilder, dashed, polygon, ribbon, wall } from './meshing';
import { layer } from './layers';
import { palette } from './palette';

const H_ROAD = 0.03;
const H_MARK = 0.05;
const H_KERB = 0.16;
const SIDEWALK = 2.2;

interface LampRef {
  junction: Junction;
  link: Link;
  color: 'red' | 'amber' | 'green';
}

interface BarRef {
  junction: Junction;
  lane: Lane;
}

/** Most permissive light shown to a set of turns (a lane or an approach). */
function lightFor(j: Junction, connectors: readonly Connector[]): 'red' | 'amber' | 'green' {
  const signal = j.signal;
  if (signal === null) throw new Error(`Junction at node ${j.nodeId} has no signal`);
  let best: 'red' | 'amber' | 'green' = 'red';
  for (const c of connectors) {
    const s = signal.state(c);
    if (s === 'green') return 'green';
    if (s === 'amber') best = 'amber';
  }
  return best;
}

/** Static meshes for roads, junctions and roundabouts, plus live signal lamps and stop bars. */
export class NetworkView {
  readonly group = new Group();
  // Ground-hugging layers are centimetres apart; polygon offsets (see layers.ts) keep their
  // order right at any zoom instead of relying on depth precision.
  private readonly asphalt = new MeshStandardMaterial({ color: palette.asphalt, roughness: 0.95, metalness: 0, ...layer('asphalt') });
  private readonly sidewalk = new MeshStandardMaterial({ color: palette.sidewalk, roughness: 0.92, ...layer('asphalt') });
  private readonly marking = new MeshStandardMaterial({ color: palette.marking, roughness: 0.7, ...layer('marking') });
  private readonly island = new MeshStandardMaterial({ color: palette.island, roughness: 1 });
  private readonly kerb = new MeshStandardMaterial({ color: palette.islandKerb, roughness: 0.9 });
  private readonly leaves = new MeshStandardMaterial({ color: palette.treeLeaves, roughness: 0.9, flatShading: true });
  private readonly trunk = new MeshStandardMaterial({ color: palette.treeTrunk, roughness: 0.9 });
  private readonly metal = new MeshStandardMaterial({ color: palette.pole, roughness: 0.6, metalness: 0.3 });
  private readonly headMat = new MeshStandardMaterial({ color: palette.signalHead, roughness: 0.6 });
  private readonly lampMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  private readonly barMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, ...layer('bar') });
  private lamps: InstancedMesh | null = null;
  private lampRefs: LampRef[] = [];
  private bars: InstancedMesh | null = null;
  private barRefs: BarRef[] = [];
  private readonly color = new Color();

  build(net: Network): void {
    this.clear();
    const road = new MeshBuilder();
    const side = new MeshBuilder();
    const mark = new MeshBuilder();
    const side_ = net.side;

    for (const r of net.roads) {
      const pts = r.center.points();
      const hw = r.width / 2;
      ribbon(road, pts, -hw, hw, H_ROAD);
      ribbon(side, pts, hw, hw + SIDEWALK, H_KERB);
      ribbon(side, pts, -hw - SIDEWALK, -hw, H_KERB);
      wall(side, pts, hw, H_ROAD, H_KERB, 1);
      wall(side, pts, -hw, H_ROAD, H_KERB, -1);
      const two = r.ab !== null && r.ba !== null;
      if (two) {
        // Double centre line between the two directions.
        ribbon(mark, pts, r.divider - 0.28, r.divider - 0.12, H_MARK);
        ribbon(mark, pts, r.divider + 0.12, r.divider + 0.28, H_MARK);
      }
      // Dashed lines between lanes of the same direction (in the road's a → b frame).
      for (let i = 1; i < r.design.lanesAB; i++) dashed(mark, pts, r.divider + side_ * i * LANE_WIDTH, 0.15, 3, 6, H_MARK);
      for (let i = 1; i < r.design.lanesBA; i++) dashed(mark, pts, r.divider - side_ * i * LANE_WIDTH, 0.15, 3, 6, H_MARK);
    }

    for (const j of net.junctions) {
      if (j.ring !== null) continue;
      polygon(road, j.polygon, H_ROAD);
      this.kerbs(side, j.polygon, j.outlineKerbs);
      if (j.kind !== 'none') this.approachMarkings(mark, net, j);
    }
    for (const ring of net.roundabouts) this.roundabout(road, side, mark, ring);
    for (const g of net.gateways) {
      const disc = new Mesh(new CylinderGeometry(4, 4, 0.12, 32), new MeshBasicMaterial({
        color: g.source !== null ? palette.entry : palette.exit,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }));
      disc.position.set(g.position.x, 0.1, g.position.y);
      this.group.add(disc);
    }

    this.addMesh(road.build(), this.asphalt, true);
    if (!side.empty) this.addMesh(side.build(), this.sidewalk, true);
    if (!mark.empty) this.addMesh(mark.build(), this.marking, false);
    this.signals(net);
  }

  private addMesh(geometry: BufferGeometry, material: Material, receive: boolean): Mesh {
    const m = new Mesh(geometry, material);
    m.receiveShadow = receive;
    this.group.add(m);
    return m;
  }

  /** Sidewalk strips along the kerb edges of an outline (outside the paved area). */
  private kerbs(mb: MeshBuilder, outline: readonly Vector2[], kerbs: readonly boolean[]): void {
    // With y pointing south, a positive signed area means the outline runs clockwise on screen,
    // so its outside lies to the left of travel; otherwise to the right.
    let area = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      area += a.x * b.y - b.x * a.y;
    }
    const out: 1 | -1 = area > 0 ? -1 : 1;
    let run: Vector2[] = [];
    const flush = () => {
      if (run.length >= 2) {
        ribbon(mb, run, out === 1 ? 0 : -SIDEWALK, out === 1 ? SIDEWALK : 0, H_KERB);
        wall(mb, run, 0, H_ROAD, H_KERB, out === 1 ? 1 : -1);
      }
      run = [];
    };
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      if (!kerbs[i]) {
        flush();
        continue;
      }
      if (run.length === 0) run.push(a);
      run.push(b);
    }
    flush();
  }

  /** Stop/give-way lines across each approach and painted turn arrows on its lanes. */
  private approachMarkings(mb: MeshBuilder, net: Network, j: Junction): void {
    const pose = makePose();
    for (const link of j.incoming) {
      const arm = j.arms.find((a) => a.in === link);
      if (arm === undefined) throw new Error('Incoming link without an arm');
      let line: 'stop' | 'yield' | null = null;
      if (j.kind === 'signal' || j.kind === 'stop') line = 'stop';
      else if (j.kind === 'priority' && j.majorArms !== null && !j.majorArms.includes(arm.index)) {
        line = j.control.type === 'priority' && j.control.minor === 'stop' ? 'stop' : 'yield';
      }
      for (const lane of link.lanes) {
        lane.path.pose(lane.length, pose);
        const nx = -pose.ty;
        const ny = pose.tx;
        const back = (d: number) => new Vector2(pose.x - pose.tx * d, pose.y - pose.ty * d);
        if (line === 'stop') {
          const p0 = back(0.25).addScaledVector(new Vector2(nx, ny), -LANE_WIDTH / 2);
          const p1 = back(0.25).addScaledVector(new Vector2(nx, ny), LANE_WIDTH / 2);
          ribbon(mb, [p0, p1], -0.25, 0.25, H_MARK);
        } else if (line === 'yield') {
          for (let k = -1.5; k <= 1.5; k += 0.75) {
            const c = back(0.4).addScaledVector(new Vector2(nx, ny), k);
            ribbon(mb, [c.clone().addScaledVector(new Vector2(nx, ny), -0.22), c.clone().addScaledVector(new Vector2(nx, ny), 0.22)], -0.2, 0.2, H_MARK);
          }
        }
        if (lane.length > 25) this.arrow(mb, net, j, lane);
      }
    }
  }

  /** Turn arrow(s) painted near the end of a lane, showing which movements it serves. */
  private arrow(mb: MeshBuilder, net: Network, j: Junction, lane: Lane): void {
    const turns = new Set(j.movements.filter((m) => m.lanes.includes(lane)).map((m) => m.turn));
    if (turns.size === 0) return;
    const pose = lane.path.pose(lane.length - 14, makePose());
    const fx = pose.tx;
    const fy = pose.ty;
    const rx = -pose.ty;
    const ry = pose.tx;
    const at = (u: number, v: number) => new Vector2(pose.x + fx * u + rx * v, pose.y + fy * u + ry * v);
    // Arrow head at (tipU, tipV) pointing along the unit direction (du, dv) of the lane frame.
    const head = (tipU: number, tipV: number, du: number, dv: number) => {
      const tip = at(tipU, tipV);
      const b1 = at(tipU - du * 1.1 - dv * 0.55, tipV - dv * 1.1 + du * 0.55);
      const b2 = at(tipU - du * 1.1 + dv * 0.55, tipV - dv * 1.1 - du * 0.55);
      mb.tri(mb.vertex(tip.x, tip.y, H_MARK), mb.vertex(b1.x, b1.y, H_MARK), mb.vertex(b2.x, b2.y, H_MARK));
    };
    ribbon(mb, [at(-2.6, 0), at(0, 0)], -0.15, 0.15, H_MARK);
    if (turns.has('straight')) {
      ribbon(mb, [at(0, 0), at(1.0, 0)], -0.15, 0.15, H_MARK);
      head(2.1, 0, 1, 0);
    }
    for (const t of ['near', 'far'] as const) {
      if (!turns.has(t)) continue;
      const sideV = (t === 'near' ? 1 : -1) * net.side;
      const end = at(0.9, sideV * 0.9);
      ribbon(mb, [at(0, 0), end], -0.15, 0.15, H_MARK);
      head(1.55, sideV * 1.55, Math.SQRT1_2, sideV * Math.SQRT1_2);
    }
  }

  private roundabout(road: MeshBuilder, side: MeshBuilder, mark: MeshBuilder, ring: Roundabout): void {
    const c = ring.center;
    const outline: Vector2[] = [];
    const kerbs: boolean[] = [];
    const arms = [...ring.arms].sort((a, b) => a.angle - b.angle);
    const R = ring.rOuter;
    const onRing = (ang: number) => new Vector2(c.x + Math.cos(ang) * R, c.y + Math.sin(ang) * R);
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const next = arms[(i + 1) % arms.length];
      const n = new Vector2(-arm.dir.y, arm.dir.x);
      const nn = new Vector2(-next.dir.y, next.dir.x);
      const left = arm.end.clone().addScaledVector(n, -arm.halfWidth);
      const right = arm.end.clone().addScaledVector(n, arm.halfWidth);
      const nextLeft = next.end.clone().addScaledVector(nn, -next.halfWidth);
      outline.push(left, right);
      kerbs.push(false, true);
      // Flare from this arm's kerb onto the ring edge, along the edge, and out to the next arm.
      const span = Math.asin(Math.min(0.95, (arm.halfWidth + 4) / R));
      const spanNext = Math.asin(Math.min(0.95, (next.halfWidth + 4) / R));
      const a0 = arm.angle + span;
      let a1 = next.angle - spanNext;
      if (a1 <= a0) a1 += Math.PI * 2;
      const edgeHit = (armDir: Vector2, normal: Vector2, offset: number) => {
        const along = Math.sqrt(Math.max(0, R * R - offset * offset));
        return new Vector2(c.x + armDir.x * along + normal.x * offset, c.y + armDir.y * along + normal.y * offset);
      };
      const flareOut = new QuadraticBezierCurve(right, edgeHit(arm.dir, n, arm.halfWidth), onRing(a0)).getPoints(8);
      for (let s = 1; s < flareOut.length; s++) {
        outline.push(flareOut[s]);
        kerbs.push(true);
      }
      const steps = Math.max(2, Math.ceil(((a1 - a0) * R) / 2));
      for (let s = 1; s < steps; s++) {
        outline.push(onRing(a0 + ((a1 - a0) * s) / steps));
        kerbs.push(true);
      }
      const flareIn = new QuadraticBezierCurve(onRing(a1), edgeHit(next.dir, nn, -next.halfWidth), nextLeft).getPoints(8);
      for (let s = 0; s < flareIn.length - 1; s++) {
        outline.push(flareIn[s]);
        kerbs.push(true);
      }
    }
    const islandR = ring.rInner - 0.2;
    const hole: Vector2[] = [];
    for (let k = 0; k < 64; k++) {
      const ang = (k / 64) * Math.PI * 2;
      hole.push(new Vector2(c.x + Math.cos(ang) * islandR, c.y + Math.sin(ang) * islandR));
    }
    const tris = ShapeUtils.triangulateShape(outline, [hole]);
    const all = [...outline, ...hole].map((p) => road.vertex(p.x, p.y, H_ROAD));
    for (const [a, b, d] of tris) road.tri(all[a], all[b], all[d]);
    this.kerbs(side, outline, kerbs);

    // Lane line on multi-lane rings and give-way lines at the entries.
    if (ring.control.lanes > 1) {
      const pts: Vector2[] = [];
      const r = ring.rInner + LANE_WIDTH;
      for (let k = 0; k <= 96; k++) {
        const ang = (k / 96) * Math.PI * 2;
        pts.push(new Vector2(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r));
      }
      dashed(mark, pts, 0, 0.15, 2.5, 3.5, H_MARK);
    }
    const pose = makePose();
    for (const j of ring.junctions) {
      const link = j.arms[0].in;
      if (link === null) continue;
      for (const lane of link.lanes) {
        lane.path.pose(lane.length, pose);
        const n = new Vector2(-pose.ty, pose.tx);
        for (let k = -1.5; k <= 1.5; k += 0.75) {
          const ctr = new Vector2(pose.x - pose.tx * 0.4, pose.y - pose.ty * 0.4).addScaledVector(n, k);
          ribbon(mark, [ctr.clone().addScaledVector(n, -0.22), ctr.clone().addScaledVector(n, 0.22)], -0.2, 0.2, H_MARK);
        }
      }
    }

    // Central island: a raised kerb ring, grass and a few trees.
    const kerbRing = new Mesh(new CylinderGeometry(islandR, islandR, 0.28, 72), this.kerb);
    kerbRing.position.set(c.x, 0.14, c.y);
    kerbRing.receiveShadow = true;
    const grass = new Mesh(new CylinderGeometry(islandR - 0.5, islandR - 0.5, 0.36, 72), this.island);
    grass.position.set(c.x, 0.18, c.y);
    grass.receiveShadow = true;
    this.group.add(kerbRing, grass);
    const trees = Math.min(5, Math.floor(islandR / 3));
    for (let t = 0; t < trees; t++) {
      const ang = t * 2.399 + ring.nodeId;
      const rad = t === 0 ? 0 : islandR * 0.45;
      this.tree(c.x + Math.cos(ang) * rad, c.y + Math.sin(ang) * rad, 0.8 + ((t * 37) % 10) / 20);
    }
  }

  private tree(x: number, y: number, scale: number): void {
    const trunk = new Mesh(new CylinderGeometry(0.25 * scale, 0.35 * scale, 2.2 * scale, 6), this.trunk);
    trunk.position.set(x, 1.1 * scale + 0.3, y);
    const crown = new Mesh(new ConeGeometry(2.2 * scale, 5 * scale, 7), this.leaves);
    crown.position.set(x, 4.3 * scale + 0.3, y);
    trunk.castShadow = true;
    crown.castShadow = true;
    this.group.add(trunk, crown);
  }

  /** Poles, heads and lamps for every signalised approach; coloured stop bars per lane. */
  private signals(net: Network): void {
    const lampGeo = new SphereGeometry(0.16, 10, 8);
    const lampMatrices: Matrix4[] = [];
    const barMatrices: Matrix4[] = [];
    this.lampRefs = [];
    this.barRefs = [];
    const dummy = new Object3D();
    const pose = makePose();
    for (const j of net.junctions) {
      if (j.kind !== 'signal') continue;
      for (const link of j.incoming) {
        const outer = link.lanes[link.lanes.length - 1];
        outer.path.pose(outer.length, pose);
        const nx = -pose.ty * net.side;
        const ny = pose.tx * net.side;
        const base = new Vector2(pose.x + nx * (LANE_WIDTH / 2 + 1.2), pose.y + ny * (LANE_WIDTH / 2 + 1.2));
        const reach = Math.min(7, link.lanes.length * LANE_WIDTH);
        const pole = new Mesh(new CylinderGeometry(0.13, 0.16, 5.6, 8), this.metal);
        pole.position.set(base.x, 2.8, base.y);
        pole.castShadow = true;
        const mast = new Mesh(new BoxGeometry(reach, 0.16, 0.16), this.metal);
        const mid = base.clone().addScaledVector(new Vector2(nx, ny), -reach / 2);
        mast.position.set(mid.x, 5.5, mid.y);
        mast.rotation.y = Math.atan2(-ny, nx);
        mast.castShadow = true;
        const headPos = base.clone().addScaledVector(new Vector2(nx, ny), -reach + 0.3);
        const head = new Mesh(new BoxGeometry(0.5, 1.3, 0.5), this.headMat);
        head.position.set(headPos.x, 4.9, headPos.y);
        head.castShadow = true;
        this.group.add(pole, mast, head);
        // Lamps on the face towards approaching traffic, red on top.
        const face = new Vector2(headPos.x - pose.tx * 0.27, headPos.y - pose.ty * 0.27);
        (['red', 'amber', 'green'] as const).forEach((color, k) => {
          dummy.position.set(face.x, 5.3 - k * 0.4, face.y);
          dummy.updateMatrix();
          lampMatrices.push(dummy.matrix.clone());
          this.lampRefs.push({ junction: j, link, color });
        });
        for (const lane of link.lanes) {
          lane.path.pose(lane.length, pose);
          dummy.position.set(pose.x - pose.tx * 0.6, H_MARK + 0.01, pose.y - pose.ty * 0.6);
          dummy.rotation.set(0, -Math.atan2(pose.ty, pose.tx), 0);
          dummy.updateMatrix();
          barMatrices.push(dummy.matrix.clone());
          this.barRefs.push({ junction: j, lane });
          dummy.rotation.set(0, 0, 0);
        }
      }
    }
    if (lampMatrices.length > 0) {
      this.lamps = new InstancedMesh(lampGeo, this.lampMat, lampMatrices.length);
      lampMatrices.forEach((m, i) => this.lamps!.setMatrixAt(i, m));
      this.lamps.instanceMatrix.setUsage(DynamicDrawUsage);
      this.group.add(this.lamps);
    }
    if (barMatrices.length > 0) {
      this.bars = new InstancedMesh(new BoxGeometry(0.9, 0.04, LANE_WIDTH - 0.4), this.barMat, barMatrices.length);
      barMatrices.forEach((m, i) => this.bars!.setMatrixAt(i, m));
      this.group.add(this.bars);
    }
    this.updateSignals();
  }

  /** Recolours lamps and stop bars from the controllers' current state. */
  updateSignals(): void {
    if (this.lamps !== null) {
      this.lampRefs.forEach((ref, i) => {
        const shown = lightFor(ref.junction, ref.link.lanes.flatMap((l) => l.out));
        const on = shown === ref.color;
        const base = ref.color === 'red' ? palette.lampRed : ref.color === 'amber' ? palette.lampAmber : palette.lampGreen;
        this.lamps!.setColorAt(i, this.color.set(on ? base : palette.lampOff));
      });
      if (this.lamps.instanceColor !== null) this.lamps.instanceColor.needsUpdate = true;
    }
    if (this.bars !== null) {
      this.barRefs.forEach((ref, i) => {
        const shown = lightFor(ref.junction, ref.lane.out);
        this.bars!.setColorAt(i, this.color.set(shown === 'green' ? palette.lampGreen : shown === 'amber' ? palette.lampAmber : palette.lampRed));
      });
      if (this.bars.instanceColor !== null) this.bars.instanceColor.needsUpdate = true;
    }
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof Mesh || child instanceof InstancedMesh) child.geometry.dispose();
    }
    this.lamps = null;
    this.bars = null;
  }

  dispose(): void {
    this.clear();
  }
}
