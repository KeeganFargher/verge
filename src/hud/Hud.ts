import {
  CanvasTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  type WebGLRenderer,
} from 'three';
import { theme } from './theme';
import { Dyn, Label, Para, col, type Getter, type UiState, type Widget } from './ui';

/** Where a panel goes, given the screen size and its own measured size; returns its top-left. */
export type Placement = (screenW: number, screenH: number, w: number, h: number) => [number, number];

export interface PanelOpts {
  visible?: Getter<boolean>;
  /** Repaint at least this often (ms) for live figures; 0 = only when marked dirty. */
  live?: number;
}

/** Shadow margin around the panel content inside its texture. */
const MARGIN = 40;

/**
 * One HUD panel: a widget tree painted into its own canvas, uploaded as a texture and shown on
 * a quad in the HUD's orthographic scene. Only panels that changed are repainted and re-uploaded.
 */
export class Panel {
  readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  x = 0;
  y = 0;
  w = 0;
  h = 0;
  dirty = true;
  private lastPaint = -Infinity;

  constructor(
    readonly root: Widget,
    private readonly place: Placement,
    private readonly opts: PanelOpts = {},
  ) {
    const g = this.canvas.getContext('2d');
    if (g === null) throw new Error('2D canvas unavailable');
    this.g = g;
    this.texture = this.makeTexture();
    this.mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.frustumCulled = false;
  }

  private makeTexture(): CanvasTexture {
    const t = new CanvasTexture(this.canvas);
    t.colorSpace = SRGBColorSpace;
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = false;
    return t;
  }

  get shown(): boolean {
    return this.opts.visible?.() ?? true;
  }

  contains(px: number, py: number): boolean {
    return this.shown && px >= this.x && px < this.x + this.w && py >= this.y && py < this.y + this.h;
  }

  update(now: number, sw: number, sh: number, ui: UiState, dpr: number): void {
    const vis = this.shown;
    this.mesh.visible = vis;
    if (!vis) return;
    const live = this.opts.live ?? 0;
    if (!this.dirty && !(live > 0 && now - this.lastPaint >= live)) return;
    this.dirty = false;
    this.lastPaint = now;
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const [w, h] = this.root.measure(g);
    const [px, py] = this.place(sw, sh, w, h);
    // Snap to device pixels so texels map 1:1 and text stays crisp.
    this.x = Math.round(px * dpr) / dpr;
    this.y = Math.round(py * dpr) / dpr;
    this.w = w;
    this.h = h;
    this.root.arrange(g, 0, 0, w, h);
    const cw = Math.ceil((w + MARGIN * 2) * dpr);
    const ch = Math.ceil((h + MARGIN * 2) * dpr);
    if (cw !== this.canvas.width || ch !== this.canvas.height) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      // GPU storage is immutable in size: a resized canvas needs a fresh texture.
      this.texture.dispose();
      this.texture = this.makeTexture();
      this.mesh.material.map = this.texture;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.setTransform(dpr, 0, 0, dpr, MARGIN * dpr, MARGIN * dpr);
    this.root.paint(g, ui);
    this.texture.needsUpdate = true;
    const fw = cw / dpr;
    const fh = ch / dpr;
    this.mesh.scale.set(fw, fh, 1);
    this.mesh.position.set(this.x - MARGIN + fw / 2, -(this.y - MARGIN + fh / 2), 0);
  }
}

/**
 * The heads-up display, rendered by three.js in a second pass over the 3D view. It owns pointer
 * routing for its panels: anything over a panel is consumed here and never reaches the world.
 */
export class Hud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 0, -1, -100, 100);
  private readonly panels: Panel[] = [];
  private readonly ui: UiState = { hover: null, active: null, now: 0 };
  private hoverPanel: Panel | null = null;
  private activePanel: Panel | null = null;
  private pointerX = -1;
  private pointerY = -1;
  private hoverSince = 0;
  private tipText = '';
  private readonly tip: Panel;
  width = 1;
  height = 1;
  dpr = 1;

  constructor() {
    this.tip = new Panel(
      new Dyn(
        () => this.tipText,
        () => {
          const lines = this.tipText.split('\n');
          return col(
            { pad: [7, 10, 7, 10], bg: 'rgba(8, 11, 16, 0.96)', radius: 7, border: theme.panelBorder, gap: 2 },
            new Label(lines[0], { weight: 600 }),
            ...lines.slice(1).map((l) => new Para(l, 240, { size: 11 })),
          );
        },
      ),
      (sw, sh, w, h) => [Math.min(this.pointerX + 14, sw - w - 6), Math.min(this.pointerY + 20, sh - h - 6)],
      { visible: () => this.tipText !== '' },
    );
    this.tip.mesh.renderOrder = 10000;
    this.scene.add(this.tip.mesh);
  }

  add(panel: Panel): Panel {
    this.panels.push(panel);
    panel.mesh.renderOrder = this.panels.length;
    this.scene.add(panel.mesh);
    return panel;
  }

  resize(w: number, h: number, dpr: number): void {
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = 0;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Marks every panel for repaint (call after app state changes). */
  invalidate(): void {
    for (const p of this.panels) p.dirty = true;
    this.tip.dirty = true;
  }

  /** Topmost visible panel under a point. */
  panelAt(x: number, y: number): Panel | null {
    for (let i = this.panels.length - 1; i >= 0; i--) if (this.panels[i].contains(x, y)) return this.panels[i];
    return null;
  }

  get capturing(): boolean {
    return this.ui.active !== null;
  }

  private setHover(panel: Panel | null, widget: Widget | null): void {
    if (widget === this.ui.hover) return;
    if (this.hoverPanel !== null) this.hoverPanel.dirty = true;
    if (panel !== null) panel.dirty = true;
    this.ui.hover = widget;
    this.hoverPanel = panel;
    this.hoverSince = this.ui.now;
    this.tipText = '';
  }

  pointerMove(x: number, y: number, shift: boolean): boolean {
    this.pointerX = x;
    this.pointerY = y;
    if (this.ui.active !== null && this.activePanel !== null) {
      const p = this.activePanel;
      this.ui.active.onDrag({ x: x - p.x, y: y - p.y, shift });
      p.dirty = true;
      return true;
    }
    const panel = this.panelAt(x, y);
    const widget = panel !== null ? panel.root.pick(x - panel.x, y - panel.y) : null;
    this.setHover(panel, widget);
    if (this.tipText !== '') this.tip.dirty = true;
    return panel !== null;
  }

  pointerDown(x: number, y: number, shift: boolean): boolean {
    const panel = this.panelAt(x, y);
    if (panel === null) return false;
    const widget = panel.root.pick(x - panel.x, y - panel.y);
    this.tipText = '';
    if (widget !== null) {
      this.ui.active = widget;
      this.activePanel = panel;
      widget.onDown({ x: x - panel.x, y: y - panel.y, shift });
      panel.dirty = true;
    }
    return true;
  }

  pointerUp(x: number, y: number, shift: boolean): boolean {
    const widget = this.ui.active;
    const panel = this.activePanel;
    if (widget === null || panel === null) return this.panelAt(x, y) !== null;
    this.ui.active = null;
    this.activePanel = null;
    const lx = x - panel.x;
    const ly = y - panel.y;
    // Clicks run synchronously inside the DOM event so actions like opening a file picker are allowed.
    widget.onUp({ x: lx, y: ly, shift }, widget.inside(lx, ly) && panel.contains(x, y));
    this.invalidate();
    return true;
  }

  wheel(x: number, y: number, dy: number): boolean {
    const panel = this.panelAt(x, y);
    if (panel === null) return false;
    const widget = panel.root.pick(x - panel.x, y - panel.y);
    if (widget !== null && widget.onWheel(dy)) this.invalidate();
    return true;
  }

  leave(): void {
    this.setHover(null, null);
    this.pointerX = -1;
  }

  update(now: number): void {
    this.ui.now = now;
    const hover = this.ui.hover;
    const text = hover !== null && this.ui.active === null && now - this.hoverSince > 450 ? hover.tooltip() ?? '' : '';
    if (text !== this.tipText) {
      this.tipText = text;
      this.tip.dirty = true;
    }
    for (const p of this.panels) p.update(now, this.width, this.height, this.ui, this.dpr);
    this.tip.update(now, this.width, this.height, this.ui, this.dpr);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }
}
