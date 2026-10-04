import { Vector2 } from 'three';
import type { App, Selection } from '../app/App';
import type { Vehicle } from '../sim/vehicle';
import { LANE_WIDTH, defaultControl, findNode, findRoad, nodeDegree, type Design } from '../sim/design';
import { minBendRadius } from '../sim/compile';
import { quadraticMinRadius } from '../sim/geometry';
import { palette } from '../render/palette';
import { anchorPoint, drawRoad, moveNode, nearestOnRoad, removeNode, removeRoad, updateNode, updateRoad, type Anchor } from './ops';

export type ToolId = 'select' | 'road' | 'bulldoze' | 'junction' | 'traffic' | 'map';

/** Pointer on the ground plane, in plan coordinates. */
export interface WorldPointer {
  world: Vector2 | null;
  /** Metres covered by one screen pixel at the pointer (for zoom-independent pick radii). */
  pixel: number;
  shift: boolean;
  /** Design node whose floating tag (entry flow, junction delay) is under the pointer. */
  tag: number | null;
}

export type Pick =
  | { kind: 'node'; id: number; point: Vector2 }
  | { kind: 'road'; id: number; point: Vector2 }
  | { kind: 'vehicle'; vehicle: Vehicle };

type Drag =
  | { kind: 'node'; id: number; before: Design; from: Vector2; moved: boolean }
  | { kind: 'bend'; roadId: number; before: Design; from: Vector2; moved: boolean }
  | { kind: 'image'; from: Vector2; x0: number; y0: number };

const GRID = 5;

/** A pick or selection as it goes into the overlay key: a vehicle is an object graph, not JSON. */
function keyOf(p: Pick | Selection): unknown {
  return p !== null && p.kind === 'vehicle' ? ['vehicle', p.vehicle.id] : p;
}

/** Turns pointer input into design edits for whichever tool is active, and draws the feedback. */
export class Editor {
  hover: Pick | null = null;
  /** Snapped pointer position (road tool). */
  cursor: Vector2 | null = null;
  roadStart: Anchor | null = null;
  roadControl: Vector2 | null = null;
  /** Two-point scale calibration for the background image. */
  calibration: { a: Vector2 | null; b: Vector2 | null; meters: number } | null = null;
  private drag: Drag | null = null;
  private overlayKey = '';

  constructor(private readonly app: App) {}

  get design(): Design {
    return this.app.project.design;
  }

  /** Resets transient state when the tool changes or the network is replaced. */
  reset(): void {
    this.roadStart = null;
    this.roadControl = null;
    this.drag = null;
    this.calibration = null;
    this.hover = null;
    this.overlayKey = '';
  }

  // ------------------------------------------------------------------ picking

  pick(p: WorldPointer, vehicles: boolean): Pick | null {
    // A tag stands for its entry or junction where clicking inspects or converts it; not while
    // bulldozing, where a stray click on a tag would delete a road.
    const tool = this.app.tool;
    if (p.tag !== null && (tool === 'select' || tool === 'traffic' || tool === 'junction')) {
      const n = findNode(this.design, p.tag);
      return { kind: 'node', id: n.id, point: new Vector2(n.x, n.y) };
    }
    const w = p.world;
    if (w === null) return null;
    if (vehicles) {
      let best: { vehicle: Vehicle; d: number } | null = null;
      for (const v of this.app.sim.vehicles) {
        const d = Math.hypot(v.x - w.x, v.y - w.y);
        if (d < Math.max(3, p.pixel * 10) && (best === null || d < best.d)) best = { vehicle: v, d };
      }
      if (best !== null) return { kind: 'vehicle', vehicle: best.vehicle };
    }
    let node: { id: number; d: number } | null = null;
    for (const n of this.design.nodes) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      const radius = Math.max(this.app.nodeRadius(n.id), p.pixel * 12);
      if (d < radius && (node === null || d < node.d)) node = { id: n.id, d };
    }
    if (node !== null) {
      const n = findNode(this.design, node.id);
      return { kind: 'node', id: node.id, point: new Vector2(n.x, n.y) };
    }
    let road: { id: number; d: number; point: Vector2 } | null = null;
    for (const r of this.design.roads) {
      const near = nearestOnRoad(this.design, r, w);
      const half = ((r.lanesAB + r.lanesBA) * LANE_WIDTH) / 2;
      if (near.distance < half + p.pixel * 8 && (road === null || near.distance < road.d)) road = { id: r.id, d: near.distance, point: near.point };
    }
    return road === null ? null : { kind: 'road', id: road.id, point: road.point };
  }

  /** Where a road endpoint would go: an existing node, a point on a road, or a free (snapped) point. */
  private anchorAt(p: WorldPointer): { anchor: Anchor; point: Vector2 } | null {
    const w = p.world;
    if (w === null) return null;
    const hit = this.pick(p, false);
    if (hit !== null && hit.kind === 'node') return { anchor: { kind: 'node', id: hit.id }, point: hit.point };
    if (hit !== null && hit.kind === 'road') return { anchor: { kind: 'road', id: hit.id, x: hit.point.x, y: hit.point.y }, point: hit.point };
    let q = w.clone();
    const settings = this.app.roadTool;
    if (this.roadStart !== null && (settings.angleSnap || p.shift)) {
      const s = anchorPoint(this.design, this.roadStart);
      const from = this.roadControl ?? s;
      const d = q.clone().sub(from);
      const step = Math.PI / 12;
      const ang = Math.round(Math.atan2(d.y, d.x) / step) * step;
      const len = settings.gridSnap ? Math.round(d.length() / GRID) * GRID : d.length();
      q = new Vector2(from.x + Math.cos(ang) * len, from.y + Math.sin(ang) * len);
    } else if (settings.gridSnap) {
      q = new Vector2(Math.round(q.x / GRID) * GRID, Math.round(q.y / GRID) * GRID);
    }
    return { anchor: { kind: 'free', x: q.x, y: q.y }, point: q };
  }

  // ------------------------------------------------------------------ pointer

  /** Left button pressed on the world. Returns false to let the camera pan instead. */
  down(p: WorldPointer): boolean {
    const w = p.world;
    if (w === null) return false;
    switch (this.app.tool) {
      case 'select': {
        const hit = this.pick(p, true);
        if (hit === null) return false;
        if (hit.kind === 'node') this.drag = { kind: 'node', id: hit.id, before: this.design, from: w.clone(), moved: false };
        else if (hit.kind === 'road') this.drag = { kind: 'bend', roadId: hit.id, before: this.design, from: w.clone(), moved: false };
        this.app.select(hit.kind === 'vehicle' ? { kind: 'vehicle', vehicle: hit.vehicle } : { kind: hit.kind, id: hit.id });
        return true;
      }
      case 'road':
        return true;
      case 'bulldoze':
      case 'junction':
      case 'traffic':
        return this.pick(p, this.app.tool === 'traffic') !== null;
      case 'map': {
        const bg = this.app.project.background;
        if (this.calibration !== null) return true;
        if (bg === null || bg.locked) return false;
        this.drag = { kind: 'image', from: w.clone(), x0: bg.x, y0: bg.y };
        return true;
      }
    }
  }

  move(p: WorldPointer): void {
    const w = p.world;
    const drag = this.drag;
    if (drag !== null && w !== null) {
      if (drag.kind === 'image') {
        const bg = this.app.project.background;
        if (bg === null) throw new Error('Image drag without a background');
        this.app.setBackground({ ...bg, x: drag.x0 + w.x - drag.from.x, y: drag.y0 + w.y - drag.from.y });
        return;
      }
      if (!drag.moved && w.distanceTo(drag.from) < p.pixel * 5) return;
      drag.moved = true;
      if (drag.kind === 'node') {
        let x = w.x;
        let y = w.y;
        if (this.app.roadTool.gridSnap) {
          x = Math.round(x / GRID) * GRID;
          y = Math.round(y / GRID) * GRID;
        }
        this.app.preview(moveNode(drag.before, drag.id, x, y));
      } else {
        // Bend the road so its midpoint passes under the pointer.
        const r = findRoad(drag.before, drag.roadId);
        const a = findNode(drag.before, r.a);
        const b = findNode(drag.before, r.b);
        const c = { x: 2 * w.x - (a.x + b.x) / 2, y: 2 * w.y - (a.y + b.y) / 2 };
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const straight = Math.hypot(c.x - mid.x, c.y - mid.y) < 3;
        this.app.preview(updateRoad(drag.before, drag.roadId, { curve: straight ? null : c }));
      }
      return;
    }
    this.hover = this.app.tool === 'road' ? null : this.pick(p, this.app.tool === 'select' || this.app.tool === 'traffic');
    if (this.app.tool === 'road') {
      const a = this.anchorAt(p);
      this.cursor = a === null ? null : a.point;
      const hit = this.pick(p, false);
      this.hover = hit;
    }
  }

  up(p: WorldPointer, click: boolean): void {
    const drag = this.drag;
    this.drag = null;
    if (drag !== null) {
      if ((drag.kind === 'node' || drag.kind === 'bend') && drag.moved) this.app.finishPreview(drag.before, drag.kind === 'node' ? 'Moved junction' : 'Reshaped road');
      return;
    }
    if (!click || p.world === null) return;
    switch (this.app.tool) {
      case 'select':
        return;
      case 'road':
        this.roadClick(p);
        return;
      case 'bulldoze': {
        const hit = this.pick(p, false);
        if (hit === null || hit.kind === 'vehicle') return;
        if (hit.kind === 'node') this.app.commit(removeNode(this.design, hit.id), 'Removed junction');
        else this.app.commit(removeRoad(this.design, hit.id), 'Removed road');
        this.hover = null;
        return;
      }
      case 'junction': {
        const hit = this.pick(p, false);
        if (hit === null || hit.kind !== 'node') return;
        if (nodeDegree(this.design, hit.id) < 3) {
          this.app.toast('Junction controls apply where three or more roads meet', 'info');
          return;
        }
        const type = this.app.junctionType;
        const node = findNode(this.design, hit.id);
        if (node.control.type !== type) {
          this.app.commit(updateNode(this.design, hit.id, (n) => (n.control = defaultControl(type))), `Converted to ${controlName(type)}`);
        }
        this.app.select({ kind: 'node', id: hit.id });
        return;
      }
      case 'traffic': {
        const hit = this.pick(p, true);
        if (hit === null) return;
        this.app.select(hit.kind === 'vehicle' ? { kind: 'vehicle', vehicle: hit.vehicle } : { kind: hit.kind, id: hit.id });
        return;
      }
      case 'map': {
        const c = this.calibration;
        if (c === null) return;
        if (c.a === null || c.b !== null) {
          c.a = p.world.clone();
          c.b = null;
        } else if (p.world.distanceTo(c.a) > p.pixel * 3) {
          // A second click on the first point would measure nothing, and scale the image to infinity.
          c.b = p.world.clone();
        }
        this.app.hud.invalidate();
        return;
      }
    }
  }

  private roadClick(p: WorldPointer): void {
    const at = this.anchorAt(p);
    if (at === null) return;
    if (this.roadStart === null) {
      this.roadStart = at.anchor;
      this.app.hud.invalidate();
      return;
    }
    if (this.app.roadTool.curved && this.roadControl === null) {
      this.roadControl = at.point.clone();
      this.app.hud.invalidate();
      return;
    }
    const t = this.app.roadTool;
    const lanes = t.lanes;
    try {
      const { design, end } = drawRoad(this.design, this.roadStart, at.anchor, this.roadControl, {
        lanesAB: lanes,
        lanesBA: t.oneWay ? 0 : lanes,
        speed: t.speed,
      });
      if (this.app.commit(design, 'Built road')) {
        // Keep drawing from where this segment ended, like city builders do.
        this.roadStart = { kind: 'node', id: end };
        this.roadControl = null;
      }
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      this.app.toast(e.message, 'error');
    }
  }

  /** Right click / Escape: back out of the current action. Returns false if there was nothing to cancel. */
  cancel(): boolean {
    if (this.drag !== null) {
      const d = this.drag;
      this.drag = null;
      if (d.kind !== 'image' && d.moved) this.app.preview(d.before);
      return true;
    }
    if (this.roadControl !== null) {
      this.roadControl = null;
      return true;
    }
    if (this.roadStart !== null) {
      this.roadStart = null;
      return true;
    }
    if (this.calibration !== null) {
      this.calibration = null;
      return true;
    }
    return false;
  }

  /** Length (m) of the segment being drawn, for the HUD. */
  draftLength(): number | null {
    if (this.roadStart === null || this.cursor === null) return null;
    const s = anchorPoint(this.design, this.roadStart);
    if (this.roadControl === null) return s.distanceTo(this.cursor);
    return s.distanceTo(this.roadControl) + this.roadControl.distanceTo(this.cursor);
  }

  // ------------------------------------------------------------------ feedback

  /** Updates the ground overlays; cheap when nothing changed. */
  refreshOverlay(): void {
    const app = this.app;
    const o = app.views.overlay;
    const sel = app.selection;
    const veh = sel !== null && sel.kind === 'vehicle' && app.sim.vehicles.includes(sel.vehicle) ? sel.vehicle : undefined;
    const key = JSON.stringify([
      app.tool,
      keyOf(this.hover),
      keyOf(sel),
      this.roadStart,
      this.roadControl,
      this.cursor?.toArray(),
      this.calibration,
      app.netVersion,
      veh === undefined ? null : [Math.round(veh.x * 4), Math.round(veh.y * 4)],
    ]);
    if (key === this.overlayKey) return;
    this.overlayKey = key;

    const danger = app.tool === 'bulldoze';
    this.highlight('hover', this.hover, danger ? palette.danger : palette.hover, danger ? 0.45 : 0.3);
    this.highlight('select', sel === null || sel.kind === 'vehicle' ? null : sel.kind === 'node' ? { kind: 'node', id: sel.id, point: new Vector2() } : { kind: 'road', id: sel.id, point: new Vector2() }, palette.select, 0.4);
    if (veh !== undefined) o.ring('vehicle', new Vector2(veh.x, veh.y), veh.length * 0.6, veh.length * 0.6 + 0.6, palette.select, 0.9);
    else o.clear('vehicle');

    if (app.tool === 'road') {
      o.discs('handles', this.design.nodes.map((n) => new Vector2(n.x, n.y)), 1.6, 0xffffff, 0.55);
      if (this.roadStart !== null && this.cursor !== null) {
        const s = anchorPoint(this.design, this.roadStart);
        const pts: Vector2[] = [];
        const c = this.roadControl;
        const end = this.cursor;
        const n = c === null ? 1 : 24;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          if (c === null) pts.push(s.clone().lerp(end, t));
          else pts.push(s.clone().lerp(c, t).lerp(c.clone().lerp(end, t), t));
        }
        const tool = app.roadTool;
        const lanesBA = tool.oneWay ? 0 : tool.lanes;
        // Radius 0: the draft has no length or doubles back on itself, so it has no sides to draw.
        const radius = s.equals(end) ? 0 : c === null ? Infinity : quadraticMinRadius(s, c, end);
        const ok = (this.draftLength() ?? 0) >= 12 && radius >= minBendRadius(tool.lanes, lanesBA);
        if (radius > 0) o.strip('preview', pts, ((tool.lanes + lanesBA) * LANE_WIDTH) / 2, ok ? palette.valid : palette.danger, 0.45);
        else o.clear('preview');
        o.discs('ends', c === null ? [s, end] : [s, c, end], 2.2, ok ? palette.valid : palette.danger, 0.9);
      } else {
        o.clear('preview');
        o.discs('ends', this.cursor === null ? [] : [this.cursor], 2.2, palette.valid, 0.9);
      }
    } else {
      o.clear('handles');
      o.clear('preview');
      o.clear('ends');
    }

    const cal = this.calibration;
    if (app.tool === 'map' && cal !== null && cal.a !== null) {
      const b = cal.b ?? this.cursor ?? cal.a;
      // Until the pointer moves off the first point there is only an end to show.
      if (b.equals(cal.a)) o.clear('ruler');
      else o.strip('ruler', [cal.a, b], 0.6, palette.select, 0.9, 4);
      o.discs('ruler-ends', [cal.a, b], 2, palette.select, 1, 5);
    } else {
      o.clear('ruler');
      o.clear('ruler-ends');
    }
  }

  private highlight(slot: string, what: Pick | null, color: number, opacity: number): void {
    const o = this.app.views.overlay;
    if (what === null || what.kind === 'vehicle') {
      o.clear(slot);
      return;
    }
    if (what.kind === 'road') {
      const road = this.app.net.roadsById.get(what.id);
      if (road === undefined) {
        o.clear(slot);
        return;
      }
      o.strip(slot, road.center.points(), road.width / 2 + 1.2, color, opacity);
      return;
    }
    const n = this.design.nodes.find((x) => x.id === what.id);
    if (n === undefined) {
      o.clear(slot);
      return;
    }
    const r = this.app.nodeRadius(n.id);
    o.ring(slot, new Vector2(n.x, n.y), r, r + 1.6, color, Math.min(1, opacity + 0.35));
  }

  /** Pointer in map-tool calibration: the cursor follows the ground for the ruler preview. */
  trackCursor(p: WorldPointer): void {
    if (this.app.tool === 'map') this.cursor = p.world;
  }
}

export function controlName(type: string): string {
  switch (type) {
    case 'signal':
      return 'traffic signals';
    case 'roundabout':
      return 'a roundabout';
    case 'stop':
      return 'an all-way stop';
    case 'priority':
      return 'a priority junction';
    default:
      throw new Error(`Unknown control ${type}`);
  }
}
