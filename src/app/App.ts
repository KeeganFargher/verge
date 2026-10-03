import { NeutralToneMapping, Vector3, WebGLRenderer, type Vector2 } from 'three';
import { CompileError } from '../sim/compile';
import { cloneDesign, nodeDegree, type ControlType, type Design, type DrivingSide } from '../sim/design';
import type { Network } from '../sim/network';
import { DT, type Simulation } from '../sim/simulation';
import { presetById } from '../presets';
import { World } from '../render/World';
import { NetworkView } from '../render/NetworkView';
import { VehicleView } from '../render/VehicleView';
import { OverlayView } from '../render/OverlayView';
import { BackgroundView } from '../render/BackgroundView';
import { LabelView, type LabelSpec } from '../render/LabelView';
import { Hud } from '../hud/Hud';
import { losColor } from '../hud/theme';
import { Editor, type ToolId } from '../editor/Editor';
import { bounds, removeNode, removeRoad, updateNode } from '../editor/ops';
import { History } from './history';
import type { Experiment, ExperimentResult } from './experiment';
import { downloadProject, parseProject, pickFile, readImage } from './files';
import type { Background, Project } from './project';
import { Session } from './session';

export type Selection = { kind: 'node'; id: number } | { kind: 'road'; id: number } | { kind: 'vehicle'; id: number } | null;
export type Modal = 'presets' | 'settings' | 'help' | null;

export interface RoadToolSettings {
  lanes: number;
  oneWay: boolean;
  speed: number;
  curved: boolean;
  gridSnap: boolean;
  angleSnap: boolean;
}

export interface ViewSettings {
  colorMode: 'type' | 'speed' | 'destination';
  labels: boolean;
  grid: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
  until: number;
}

export const SPEEDS = [1, 2, 4, 8, 16];

/** What the static road markings depend on besides geometry: junction kinds and stop/yield rules. */
function markingsKey(d: Design): string {
  return JSON.stringify(d.nodes.map((n) => [n.id, n.control.type, n.control.type === 'priority' ? [n.control.minor, n.control.major] : null]));
}

/** Level of service from mean control delay (HCM thresholds; signals tolerate more delay per grade). */
export function levelOfService(delay: number, signalised: boolean): string {
  const limits = signalised ? [10, 20, 35, 55, 80] : [10, 15, 25, 35, 50];
  const grades = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < limits.length; i++) if (delay <= limits[i]) return grades[i];
  return 'F';
}

/** Owns the project, the compiled network and simulation, the views and the HUD, and runs the frame loop. */
export class App {
  readonly renderer: WebGLRenderer;
  readonly world: World;
  readonly hud = new Hud();
  readonly views: { network: NetworkView; vehicles: VehicleView; overlay: OverlayView; background: BackgroundView; labels: LabelView };
  readonly editor: Editor;
  readonly history = new History();

  project: Project;
  readonly session: Session;
  /** Bumped whenever the network is rebuilt or rebound, so views know to refresh. */
  netVersion = 0;

  tool: ToolId = 'select';
  modal: Modal = null;
  analyticsOpen = true;
  selection: Selection = null;
  roadTool: RoadToolSettings = { lanes: 1, oneWay: false, speed: 50, curved: false, gridSnap: true, angleSnap: false };
  junctionType: ControlType = 'signal';
  view: ViewSettings = { colorMode: 'type', labels: true, grid: false };
  running = true;
  speed = 1;
  experiments: ExperimentResult[] = [];
  experimentMinutes = 15;
  /** Vehicle the camera follows, if any. */
  follow: number | null = null;
  toasts: Toast[] = [];
  private toastId = 0;
  private accumulator = 0;
  private last = performance.now();
  private nodeRadii = new Map<number, number>();
  private labelTimer = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.autoClear = false;
    this.world = new World(this.renderer, 1);
    this.views = {
      network: new NetworkView(),
      vehicles: new VehicleView(),
      overlay: new OverlayView(),
      background: new BackgroundView(this.renderer.capabilities.getMaxAnisotropy()),
      labels: new LabelView(),
    };
    this.world.network.add(this.views.network.group);
    this.world.vehicles.add(this.views.vehicles.group);
    this.world.overlay.add(this.views.overlay.group);
    this.world.background.add(this.views.background.group);
    this.world.labels.add(this.views.labels.group);
    this.editor = new Editor(this);

    const design = presetById('crossroads-signals').build('right');
    this.project = { design, background: null };
    this.session = new Session(design);
    this.networkChanged(true);
    this.frameDesign();
  }

  get design(): Design {
    return this.project.design;
  }

  get net(): Network {
    return this.session.net;
  }

  get sim(): Simulation {
    return this.session.sim;
  }

  get experiment(): Experiment | null {
    return this.session.experiment;
  }

  // ------------------------------------------------------------------ design changes

  /** Applies an edit and records it for undo. Returns false (and says why) if it isn't a valid network. */
  commit(next: Design, message?: string, coalesce?: string): boolean {
    const before = this.design;
    if (!this.apply(next, false)) return false;
    this.history.record(before, coalesce ?? null);
    if (message !== undefined) this.toast(message, 'success');
    return true;
  }

  /** Applies an edit without recording it (while dragging); invalid intermediate shapes are skipped quietly. */
  preview(next: Design): boolean {
    return this.apply(next, true);
  }

  /** Ends a drag: the state before it becomes the undo point. */
  finishPreview(before: Design, message: string): void {
    this.history.record(before);
    this.toast(message, 'success');
  }

  private apply(next: Design, quiet: boolean): boolean {
    const prev = this.design;
    const experimenting = this.session.experiment !== null;
    let rebuilt: boolean;
    try {
      rebuilt = this.session.change(prev, next);
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      if (!quiet) this.toast(e.message, 'error');
      return false;
    }
    this.project.design = next;
    if (experimenting) this.toast('Experiment stopped: the design changed', 'info');
    this.networkChanged(rebuilt || markingsKey(next) !== markingsKey(prev));
    return true;
  }

  /** Refreshes everything derived from the network; meshes only when what they show changed. */
  private networkChanged(rebuildMeshes: boolean): void {
    this.netVersion++;
    if (rebuildMeshes) this.views.network.build(this.net);
    this.views.vehicles.setGateways(this.net.gateways.map((g) => g.nodeId));
    this.nodeRadii = new Map();
    for (const j of this.net.junctions) {
      let r = 4;
      for (const p of j.polygon) r = Math.max(r, p.distanceTo(j.center));
      this.nodeRadii.set(j.nodeId, Math.max(this.nodeRadii.get(j.nodeId) ?? 0, r));
    }
    for (const ring of this.net.roundabouts) this.nodeRadii.set(ring.nodeId, ring.rOuter + 2);
    for (const g of this.net.gateways) this.nodeRadii.set(g.nodeId, 5);
    const sel = this.selection;
    if (sel !== null && sel.kind === 'node' && !this.design.nodes.some((n) => n.id === sel.id)) this.selection = null;
    if (sel !== null && sel.kind === 'road' && !this.design.roads.some((r) => r.id === sel.id)) this.selection = null;
    for (const w of this.net.warnings) this.toast(w, 'info');
    this.labelTimer = 0;
    this.hud.invalidate();
  }

  /** Pick radius of a node: the size of its junction (roundabouts are big). */
  nodeRadius(id: number): number {
    const r = this.nodeRadii.get(id);
    if (r === undefined) throw new Error(`Node ${id} is not part of the compiled network`);
    return r;
  }

  undo(): void {
    const prev = this.history.undo(this.design);
    if (prev === null) return;
    if (!this.apply(prev, false)) throw new Error('An undo snapshot no longer compiles');
    this.toast('Undone', 'info');
  }

  redo(): void {
    const next = this.history.redo(this.design);
    if (next === null) return;
    if (!this.apply(next, false)) throw new Error('A redo snapshot no longer compiles');
    this.toast('Redone', 'info');
  }

  /** Edits one node (inspector controls); slider drags coalesce into one undo step via `key`. */
  editNode(id: number, edit: (n: Design['nodes'][number]) => void, key: string): void {
    this.commit(updateNode(this.design, id, edit), undefined, key);
  }

  editDesign(edit: (d: Design) => void, key: string, message?: string): void {
    const d = cloneDesign(this.design);
    edit(d);
    this.commit(d, message, key);
  }

  deleteSelection(): void {
    const s = this.selection;
    if (s === null || s.kind === 'vehicle') return;
    if (s.kind === 'node') this.commit(removeNode(this.design, s.id), 'Removed junction');
    else this.commit(removeRoad(this.design, s.id), 'Removed road');
    this.selection = null;
  }

  setDrivingSide(side: DrivingSide): void {
    if (side === this.design.drivingSide) return;
    this.editDesign((d) => (d.drivingSide = side), 'side', side === 'left' ? 'Now driving on the left' : 'Now driving on the right');
  }

  loadPreset(id: string): void {
    const design = presetById(id).build(this.design.drivingSide);
    this.loadProject({ design, background: null }, `Loaded “${design.name}”`);
  }

  loadProject(project: Project, message: string): void {
    const before = this.design;
    this.editor.reset();
    if (!this.apply(project.design, false)) return;
    this.history.record(before);
    this.project.background = project.background;
    this.views.background.set(project.background);
    this.selection = null;
    this.modal = null;
    this.frameDesign();
    this.toast(message, 'success');
  }

  /** Points the camera at the whole network. */
  frameDesign(): void {
    const b = bounds(this.design);
    if (b === null) {
      this.world.rig.setGoal(0, 0, 400);
      return;
    }
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 120);
    this.world.rig.setGoal((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2 + size * 0.05, size * 0.8, 0.35, 0.9);
  }

  setBackground(bg: Background | null): void {
    this.project.background = bg;
    this.views.background.set(bg);
    this.hud.invalidate();
  }

  exportProject(): void {
    downloadProject(this.project);
    this.toast('Saved project file', 'success');
  }

  importProject(): void {
    pickFile('.json,application/json', (f) => void this.openFile(f));
  }

  importImage(): void {
    pickFile('image/*', (f) => void this.openFile(f));
  }

  /** Opens a dropped/picked file: a project or a map image to trace. */
  async openFile(file: File): Promise<void> {
    try {
      if (file.type.startsWith('image/')) {
        const t = this.world.rig.target;
        this.setBackground(await readImage(file, t.x, t.z));
        this.setTool('map');
        this.toast('Map image placed — calibrate its scale in the Map tool', 'success');
      } else {
        this.loadProject(parseProject(await file.text()), `Opened ${file.name}`);
      }
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      this.toast(e.message, 'error');
    }
  }

  // ------------------------------------------------------------------ UI state

  setTool(tool: ToolId): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.editor.reset();
    this.modal = null;
    this.hud.invalidate();
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.hud.invalidate();
  }

  toggleModal(m: Exclude<Modal, null>): void {
    this.modal = this.modal === m ? null : m;
    this.hud.invalidate();
  }

  toast(text: string, kind: Toast['kind']): void {
    this.toasts.push({ id: ++this.toastId, text, kind, until: performance.now() + (kind === 'error' ? 5000 : 3000) });
    if (this.toasts.length > 4) this.toasts.shift();
    this.hud.invalidate();
  }

  togglePause(): void {
    this.running = !this.running;
    this.hud.invalidate();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.running = true;
    this.hud.invalidate();
  }

  restart(): void {
    this.session.restart(this.design);
    this.selection = this.selection?.kind === 'vehicle' ? null : this.selection;
    this.toast('Traffic restarted', 'info');
    this.hud.invalidate();
  }

  /** Summary of junction controls, used to label experiment runs. */
  controlSummary(): string {
    const counts = new Map<string, number>();
    for (const n of this.design.nodes) {
      if (nodeDegree(this.design, n.id) < 3) continue;
      const name = { signal: 'signal', roundabout: 'roundabout', stop: 'all-way stop', priority: 'priority' }[n.control.type];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([k, v]) => (v === 1 ? k : `${v} ${k}s`));
    return parts.length === 0 ? 'no junctions' : parts.join(', ');
  }

  runExperiment(): void {
    const scale = this.design.traffic.demandScale;
    const label = `${this.controlSummary()}${scale === 1 ? '' : ` · ×${scale.toFixed(2)}`}`;
    this.session.startExperiment(this.design, label, this.experimentMinutes, 5);
    this.running = true;
    this.toast(`Running ${this.experimentMinutes}-minute experiment…`, 'info');
    this.hud.invalidate();
  }

  // ------------------------------------------------------------------ frame

  resize(w: number, h: number, dpr: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.world.resize(w / h);
    this.hud.resize(w, h, dpr);
    this.views.labels.resize(h, this.world.rig.camera.fov);
  }

  frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    const exp = this.session.experiment;
    if (exp !== null) {
      exp.advance(12);
      if (exp.done) {
        const r = exp.result(this.experiments.length + 1);
        this.experiments.push(r);
        this.session.experiment = null;
        this.analyticsOpen = true;
        this.toast(`Run ${r.id}: ${Math.round(r.throughput)} veh/h, ${r.delay.toFixed(1)} s mean delay`, 'success');
      }
      this.accumulator = 0;
      this.hud.invalidate();
    } else if (this.running) {
      this.accumulator += dt * this.speed;
      let steps = Math.floor(this.accumulator / DT);
      // If the machine can't keep up, drop time rather than spiral.
      if (steps > 400) {
        steps = 400;
        this.accumulator = 0;
      } else this.accumulator -= steps * DT;
      for (let i = 0; i < steps; i++) this.sim.step();
    }

    const alpha = this.running && exp === null ? this.accumulator / DT : 1;
    this.views.vehicles.colorMode = this.view.colorMode;
    this.views.vehicles.update(this.sim, Math.min(1, alpha));
    this.views.network.updateSignals();
    this.labelTimer -= dt;
    if (this.labelTimer <= 0) {
      this.labelTimer = 1;
      this.updateLabels();
    }
    if (this.follow !== null) {
      const v = this.sim.vehicles.find((x) => x.id === this.follow);
      if (v === undefined) this.follow = null;
      else this.world.rig.setGoal(v.x, v.y, this.world.rig.distance);
    }
    this.editor.refreshOverlay();
    this.world.grid.visible = this.view.grid || this.tool === 'road';
    this.world.update(dt);

    const nowMs = performance.now();
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.until > nowMs);
    if (this.toasts.length !== before) this.hud.invalidate();
    this.hud.update(now);

    this.renderer.clear();
    this.renderer.render(this.world.scene, this.world.rig.camera);
    this.renderer.clearDepth();
    this.hud.render(this.renderer);
  }

  /** Junction level-of-service tags and entry flow tags in the 3D view. */
  private updateLabels(): void {
    if (!this.view.labels) {
      this.views.labels.set([]);
      return;
    }
    const labels: LabelSpec[] = [];
    for (const n of this.design.nodes) {
      if (nodeDegree(this.design, n.id) < 3) continue;
      const js = this.net.junctionsByNode.get(n.id);
      if (js === undefined) throw new Error(`Junction node ${n.id} was not compiled`);
      const passed = js.reduce((s, j) => s + j.stats.passed, 0);
      if (passed === 0) continue;
      const delay = js.reduce((s, j) => s + j.stats.delaySum, 0) / passed;
      const grade = levelOfService(delay, n.control.type === 'signal');
      labels.push({ key: `j${n.id}`, x: n.x, y: n.y, lift: 9, text: `${delay.toFixed(0)} s`, badge: losColor(grade), badgeText: grade });
    }
    for (const st of this.sim.gateways) {
      const g = st.gateway;
      if (g.source === null) continue;
      const rate = st.rate * 3600;
      const text = st.queue.length > 0 ? `${Math.round(rate)}/h · ${st.queue.length} waiting` : `${Math.round(rate)}/h`;
      labels.push({ key: `g${g.nodeId}`, x: g.position.x, y: g.position.y, lift: 4, text, badge: st.queue.length > 5 ? '#ff8a4c' : '#5aa9ff', badgeText: '↓' });
    }
    this.views.labels.set(labels);
  }

  /** Metres per screen pixel at a ground point (for zoom-independent pick radii). */
  pixelSize(at: Vector2 | null): number {
    const cam = this.world.rig.camera;
    const dist = at === null ? this.world.rig.distance : cam.position.distanceTo(new Vector3(at.x, 0, at.y));
    return (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / this.hud.height;
  }
}
