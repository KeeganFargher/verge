import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Simulation } from '../sim/simulation';
import type { Vehicle } from '../sim/vehicle';
import { destinationColors } from './palette';

export type VehicleColorMode = 'type' | 'speed' | 'destination';

/** A box with a constant vertex colour, positioned in a vehicle's local frame (x forward, y up). */
function part(l: number, w: number, h: number, x: number, y: number, shade: number): BufferGeometry {
  const g = new BoxGeometry(l, h, w);
  g.translate(x, y, 0);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new Float32BufferAttribute(new Array(n * 3).fill(shade), 3));
  return g;
}

function wheels(length: number, width: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const fx of [0.32, -0.32]) {
    for (const s of [1, -1]) {
      const g = part(0.7, 0.3, 0.7, fx * length, 0.35, 0.08);
      g.translate(0, 0, (s * width) / 2);
      out.push(g);
    }
  }
  return out;
}

/** Car model with unit-ish proportions; instances scale it to each vehicle's length. */
function carGeometry(): BufferGeometry {
  const L = 4.5;
  const g = mergeGeometries([
    part(L, 1.8, 0.7, 0, 0.62, 1),
    part(2.3, 1.62, 0.62, -0.25, 1.28, 0.16),
    part(2.32, 1.5, 0.12, -0.25, 1.64, 1),
    ...wheels(L, 1.8),
  ]);
  if (g === null) throw new Error('Failed to merge car geometry');
  return g;
}

function truckGeometry(): BufferGeometry {
  const L = 11;
  const g = mergeGeometries([
    part(2.3, 2.4, 2.4, L / 2 - 1.15, 1.6, 1),
    part(0.08, 2.0, 0.9, L / 2 + 0.01, 2.2, 0.15),
    part(L - 2.7, 2.5, 3.0, -1.3, 2.0, 0.92),
    ...wheels(L, 2.4),
  ]);
  if (g === null) throw new Error('Failed to merge truck geometry');
  return g;
}

const CAR_LENGTH = 4.5;
const TRUCK_LENGTH = 11;

/** Instanced vehicles, drawn between simulation steps with interpolated poses. */
export class VehicleView {
  readonly group = new Group();
  colorMode: VehicleColorMode = 'type';
  private cars: InstancedMesh;
  private trucks: InstancedMesh;
  private lights: InstancedMesh;
  private readonly bodyMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  private readonly lightMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  private readonly carGeo = carGeometry();
  private readonly truckGeo = truckGeometry();
  private readonly lightGeo = new BoxGeometry(0.14, 0.22, 1);
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private destIndex = new Map<number, number>();

  constructor() {
    this.cars = this.makeMesh(this.carGeo, this.bodyMat, 512);
    this.trucks = this.makeMesh(this.truckGeo, this.bodyMat, 64);
    this.lights = this.makeMesh(this.lightGeo, this.lightMat, 1024);
    this.lights.castShadow = false;
  }

  private makeMesh(geo: BufferGeometry, mat: MeshStandardMaterial | MeshBasicMaterial, capacity: number): InstancedMesh {
    const m = new InstancedMesh(geo, mat, capacity);
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.castShadow = true;
    m.count = 0;
    m.frustumCulled = false;
    this.group.add(m);
    return m;
  }

  private ensure(mesh: InstancedMesh, needed: number): InstancedMesh {
    if (needed <= mesh.instanceMatrix.count) return mesh;
    let capacity = mesh.instanceMatrix.count;
    while (capacity < needed) capacity *= 2;
    this.group.remove(mesh);
    mesh.dispose();
    const next = this.makeMesh(mesh.geometry, mesh.material as MeshStandardMaterial, capacity);
    next.castShadow = mesh.castShadow;
    return next;
  }

  /** Destination colours are assigned per gateway so they stay stable while the network does. */
  setGateways(nodeIds: number[]): void {
    this.destIndex = new Map(nodeIds.map((id, i) => [id, i]));
  }

  update(sim: Simulation, alpha: number): void {
    let nCars = 0;
    let nTrucks = 0;
    for (const v of sim.vehicles) {
      if (v.kind === 'truck') nTrucks++;
      else nCars++;
    }
    this.cars = this.ensure(this.cars, nCars);
    this.trucks = this.ensure(this.trucks, nTrucks);
    this.lights = this.ensure(this.lights, sim.vehicles.length);
    this.lights.castShadow = false;

    let ci = 0;
    let ti = 0;
    let li = 0;
    const d = this.dummy;
    for (const v of sim.vehicles) {
      const x = v.px + (v.x - v.px) * alpha;
      const y = v.py + (v.y - v.py) * alpha;
      let dh = v.heading - v.pheading;
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      const h = v.pheading + dh * alpha;
      const truck = v.kind === 'truck';
      const base = truck ? TRUCK_LENGTH : CAR_LENGTH;
      d.position.set(x, 0, y);
      d.rotation.set(0, -h, 0);
      d.scale.set(v.length / base, 1, 1);
      d.updateMatrix();
      const mesh = truck ? this.trucks : this.cars;
      const idx = truck ? ti++ : ci++;
      mesh.setMatrixAt(idx, d.matrix);
      mesh.setColorAt(idx, this.colorOf(v));

      // Brake lights at the rear bumper.
      const rx = x - Math.cos(h) * (v.length / 2 + 0.02);
      const ry = y - Math.sin(h) * (v.length / 2 + 0.02);
      d.position.set(rx, truck ? 1.0 : 0.75, ry);
      d.scale.set(1, 1, v.width * 0.92);
      d.updateMatrix();
      this.lights.setMatrixAt(li, d.matrix);
      this.lights.setColorAt(li, this.color.set(v.acc < -0.6 || v.v < 0.3 ? 0xff2a1a : 0x5a1410));
      li++;
    }
    for (const [mesh, count] of [
      [this.cars, ci],
      [this.trucks, ti],
      [this.lights, li],
    ] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  private colorOf(v: Vehicle): Color {
    switch (this.colorMode) {
      case 'type':
        return this.color.set(v.color);
      case 'speed': {
        const r = Math.max(0, Math.min(1, v.v / v.desiredSpeed(v.track)));
        // red (stopped) → amber → green (free flow)
        return r < 0.5 ? this.color.setRGB(0.95, 0.25 + r * 1.2, 0.2) : this.color.setRGB(0.95 - (r - 0.5) * 1.6, 0.85, 0.25);
      }
      case 'destination': {
        const i = this.destIndex.get(v.dest.nodeId);
        if (i === undefined) throw new Error(`Vehicle heading for unknown gateway ${v.dest.nodeId}`);
        return this.color.set(destinationColors[i % destinationColors.length]);
      }
    }
  }
}
