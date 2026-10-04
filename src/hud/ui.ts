import type { IconNode } from 'lucide';
import { drawIcon } from './icons';
import { font, theme } from './theme';

/*
 * A small retained-mode widget toolkit drawn with Canvas 2D. Widgets read their values through
 * getter functions every time they paint, so panels never hold stale copies of app state;
 * a panel simply repaints when it is marked dirty (or periodically for live figures).
 */

export interface UiState {
  hover: Widget | null;
  active: Widget | null;
  now: number;
}

/** Pointer position in panel coordinates. */
export interface PointerInfo {
  x: number;
  y: number;
  shift: boolean;
}

export type Getter<T> = () => T;
const always = () => true;

export abstract class Widget {
  x = 0;
  y = 0;
  w = 0;
  h = 0;
  /** Share of spare space along the parent stack's main axis. */
  grow = 0;
  visible: Getter<boolean> = always;
  tip: string | Getter<string> | null = null;
  interactive = false;

  abstract measure(g: CanvasRenderingContext2D): [number, number];

  arrange(_g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }

  abstract paint(g: CanvasRenderingContext2D, ui: UiState): void;

  inside(px: number, py: number): boolean {
    return px >= this.x && px < this.x + this.w && py >= this.y && py < this.y + this.h;
  }

  pick(px: number, py: number): Widget | null {
    return this.interactive && this.inside(px, py) ? this : null;
  }

  onDown(_p: PointerInfo): void {}
  onDrag(_p: PointerInfo): void {}
  onUp(_p: PointerInfo, _inside: boolean): void {}
  /** Returns true when the wheel was used (it then doesn't zoom the camera). */
  onWheel(_dy: number): boolean {
    return false;
  }

  tooltip(): string | null {
    if (this.tip === null) return null;
    return typeof this.tip === 'string' ? this.tip : this.tip();
  }

  /** Sets visibility from a getter; returns this for chaining in declarations. */
  when(show: Getter<boolean>): this {
    this.visible = show;
    return this;
  }

  hint(tip: string | Getter<string>): this {
    this.tip = tip;
    return this;
  }

  flex(grow = 1): this {
    this.grow = grow;
    return this;
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
}

function ellipsize(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

// ------------------------------------------------------------------ containers

export interface StackOpts {
  gap?: number;
  /** Padding: one value, or [top, right, bottom, left]. */
  pad?: number | [number, number, number, number];
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  width?: number | Getter<number>;
  height?: number;
  minWidth?: number;
  bg?: string;
  radius?: number;
  border?: string;
  shadow?: boolean;
}

export class Stack extends Widget {
  constructor(
    readonly dir: 'row' | 'col',
    readonly o: StackOpts,
    readonly kids: Widget[],
  ) {
    super();
  }

  private shown(): Widget[] {
    return this.kids.filter((k) => k.visible());
  }

  private pads(): [number, number, number, number] {
    const p = this.o.pad ?? 0;
    return typeof p === 'number' ? [p, p, p, p] : p;
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    const [pt, pr, pb, pl] = this.pads();
    const gap = this.o.gap ?? 0;
    const kids = this.shown();
    let main = 0;
    let cross = 0;
    for (const k of kids) {
      const [w, h] = k.measure(g);
      main += this.dir === 'row' ? w : h;
      cross = Math.max(cross, this.dir === 'row' ? h : w);
    }
    main += gap * Math.max(0, kids.length - 1);
    let w = (this.dir === 'row' ? main : cross) + pl + pr;
    let h = (this.dir === 'row' ? cross : main) + pt + pb;
    if (this.o.width !== undefined) w = typeof this.o.width === 'number' ? this.o.width : this.o.width();
    if (this.o.height !== undefined) h = this.o.height;
    if (this.o.minWidth !== undefined) w = Math.max(w, this.o.minWidth);
    return [w, h];
  }

  override arrange(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    super.arrange(g, x, y, w, h);
    const [pt, pr, pb, pl] = this.pads();
    const gap = this.o.gap ?? 0;
    const kids = this.shown();
    const sizes = kids.map((k) => k.measure(g));
    const iw = w - pl - pr;
    const ih = h - pt - pb;
    const row = this.dir === 'row';
    const innerMain = row ? iw : ih;
    const innerCross = row ? ih : iw;
    let used = gap * Math.max(0, kids.length - 1);
    for (const [kw, kh] of sizes) used += row ? kw : kh;
    let free = innerMain - used;
    const growSum = kids.reduce((s, k) => s + k.grow, 0);
    let offset = 0;
    let between = 0;
    if (growSum === 0 && free > 0) {
      const j = this.o.justify ?? 'start';
      if (j === 'center') offset = free / 2;
      else if (j === 'end') offset = free;
      else if (j === 'between' && kids.length > 1) between = free / (kids.length - 1);
    }
    if (free < 0) free = 0;
    let pos = (row ? x + pl : y + pt) + offset;
    kids.forEach((k, i) => {
      const [kw, kh] = sizes[i];
      const extra = growSum > 0 ? (free * k.grow) / growSum : 0;
      const mainSize = (row ? kw : kh) + extra;
      const align = this.o.align ?? 'start';
      const natural = row ? kh : kw;
      const crossSize = align === 'stretch' ? innerCross : Math.min(natural, innerCross);
      let crossPos = row ? y + pt : x + pl;
      if (align === 'center') crossPos += (innerCross - crossSize) / 2;
      else if (align === 'end') crossPos += innerCross - crossSize;
      if (row) k.arrange(g, pos, crossPos, mainSize, crossSize);
      else k.arrange(g, crossPos, pos, crossSize, mainSize);
      pos += mainSize + gap + between;
    });
  }

  paint(g: CanvasRenderingContext2D, ui: UiState): void {
    const r = this.o.radius ?? 0;
    if (this.o.bg !== undefined) {
      if (this.o.shadow === true) {
        g.save();
        g.shadowColor = theme.shadow;
        // Must stay well inside the panel texture's margin, or the blur is clipped into a hard edge.
        g.shadowBlur = 18;
        g.shadowOffsetY = 5;
        g.fillStyle = this.o.bg;
        roundRect(g, this.x, this.y, this.w, this.h, r);
        g.fill();
        g.restore();
      } else {
        g.fillStyle = this.o.bg;
        roundRect(g, this.x, this.y, this.w, this.h, r);
        g.fill();
      }
    }
    if (this.o.border !== undefined) {
      g.strokeStyle = this.o.border;
      g.lineWidth = 1;
      roundRect(g, this.x + 0.5, this.y + 0.5, this.w - 1, this.h - 1, r);
      g.stroke();
    }
    for (const k of this.shown()) k.paint(g, ui);
  }

  override pick(px: number, py: number): Widget | null {
    const kids = this.shown();
    for (let i = kids.length - 1; i >= 0; i--) {
      const hit = kids[i].pick(px, py);
      if (hit !== null) return hit;
    }
    return null;
  }
}

export function row(o: StackOpts, ...kids: Widget[]): Stack {
  return new Stack('row', o, kids);
}

export function col(o: StackOpts, ...kids: Widget[]): Stack {
  return new Stack('col', o, kids);
}

/**
 * Rebuilds its content whenever the key changes (e.g. the inspector when the selection changes).
 * Keys compare by identity, so an object (a vehicle) works as a key as well as a string.
 */
export class Dyn extends Widget {
  private child: Widget | null = null;
  private key: unknown = null;

  constructor(
    private readonly keyOf: Getter<unknown>,
    private readonly build: () => Widget,
  ) {
    super();
  }

  private current(): Widget {
    const k = this.keyOf();
    if (this.child === null || k !== this.key) {
      this.key = k;
      this.child = this.build();
    }
    return this.child;
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    return this.current().measure(g);
  }

  override arrange(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    super.arrange(g, x, y, w, h);
    this.current().arrange(g, x, y, w, h);
  }

  paint(g: CanvasRenderingContext2D, ui: UiState): void {
    this.current().paint(g, ui);
  }

  override pick(px: number, py: number): Widget | null {
    return this.current().pick(px, py);
  }
}

export class Spacer extends Widget {
  constructor(
    private readonly sw = 0,
    private readonly sh = 0,
  ) {
    super();
  }

  measure(): [number, number] {
    return [this.sw, this.sh];
  }

  paint(): void {}
}

export class Divider extends Widget {
  constructor(private readonly vertical = false) {
    super();
  }

  measure(): [number, number] {
    return this.vertical ? [1, 24] : [1, 1];
  }

  paint(g: CanvasRenderingContext2D): void {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    if (this.vertical) g.fillRect(this.x, this.y + 4, 1, this.h - 8);
    else g.fillRect(this.x, this.y, this.w, 1);
  }
}

// ------------------------------------------------------------------ text

export interface TextStyle {
  size?: number;
  weight?: number;
  color?: string | Getter<string>;
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
  minWidth?: number;
  upper?: boolean;
  mono?: boolean;
}

export class Label extends Widget {
  constructor(
    private readonly text: string | Getter<string>,
    private readonly s: TextStyle = {},
  ) {
    super();
  }

  value(): string {
    const t = typeof this.text === 'string' ? this.text : this.text();
    return this.s.upper === true ? t.toUpperCase() : t;
  }

  private setFont(g: CanvasRenderingContext2D): number {
    const size = this.s.size ?? 12;
    g.font = this.s.mono === true ? `${this.s.weight ?? 500} ${size}px ui-monospace, SFMono-Regular, Menlo, monospace` : font(size, this.s.weight ?? 500);
    return size;
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    const size = this.setFont(g);
    let w = g.measureText(this.value()).width;
    if (this.s.upper === true) w += this.value().length * 0.6;
    if (this.s.maxWidth !== undefined) w = Math.min(w, this.s.maxWidth);
    if (this.s.minWidth !== undefined) w = Math.max(w, this.s.minWidth);
    return [Math.ceil(w), Math.ceil(size * 1.4)];
  }

  paint(g: CanvasRenderingContext2D): void {
    this.setFont(g);
    const c = this.s.color ?? theme.text;
    g.fillStyle = typeof c === 'string' ? c : c();
    g.textBaseline = 'middle';
    const text = ellipsize(g, this.value(), this.w);
    const align = this.s.align ?? 'left';
    g.textAlign = align;
    if (this.s.upper === true) g.letterSpacing = '0.6px';
    const tx = align === 'left' ? this.x : align === 'center' ? this.x + this.w / 2 : this.x + this.w;
    g.fillText(text, tx, this.y + this.h / 2 + 0.5);
    g.letterSpacing = '0px';
    g.textAlign = 'left';
  }
}

/** Word-wrapped paragraph at a fixed width. */
export class Para extends Widget {
  private lines: string[] = [];

  constructor(
    private readonly text: string | Getter<string>,
    private readonly width: number,
    private readonly s: { size?: number; color?: string } = {},
  ) {
    super();
  }

  private wrap(g: CanvasRenderingContext2D): string[] {
    g.font = font(this.s.size ?? 12, 400);
    const words = (typeof this.text === 'string' ? this.text : this.text()).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur === '' ? w : `${cur} ${w}`;
      if (g.measureText(next).width > this.width && cur !== '') {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur !== '') lines.push(cur);
    return lines;
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    this.lines = this.wrap(g);
    return [this.width, Math.ceil(this.lines.length * (this.s.size ?? 12) * 1.45)];
  }

  paint(g: CanvasRenderingContext2D): void {
    const size = this.s.size ?? 12;
    g.font = font(size, 400);
    g.fillStyle = this.s.color ?? theme.dim;
    g.textBaseline = 'middle';
    this.lines.forEach((l, i) => g.fillText(l, this.x, this.y + (i + 0.5) * size * 1.45));
  }
}

export class Icon extends Widget {
  constructor(
    private readonly icon: IconNode,
    private readonly size = 16,
    private readonly color: string | Getter<string> = theme.dim,
  ) {
    super();
  }

  measure(): [number, number] {
    return [this.size, this.size];
  }

  paint(g: CanvasRenderingContext2D): void {
    const c = typeof this.color === 'string' ? this.color : this.color();
    drawIcon(g, this.icon, this.x + (this.w - this.size) / 2, this.y + (this.h - this.size) / 2, this.size, c, 2);
  }
}

// ------------------------------------------------------------------ controls

export type ButtonKind = 'tool' | 'plain' | 'chip' | 'seg' | 'primary' | 'ghost' | 'danger' | 'icon';

export interface ButtonOpts {
  icon?: IconNode;
  label?: string | Getter<string>;
  onClick: () => void;
  active?: Getter<boolean>;
  disabled?: Getter<boolean>;
  kind?: ButtonKind;
  tip?: string | Getter<string>;
  width?: number;
}

export class Button extends Widget {
  override interactive = true;

  constructor(private readonly o: ButtonOpts) {
    super();
    if (o.tip !== undefined) this.tip = o.tip;
  }

  private label(): string {
    const l = this.o.label;
    if (l === undefined) return '';
    return typeof l === 'string' ? l : l();
  }

  private kind(): ButtonKind {
    return this.o.kind ?? 'plain';
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    const k = this.kind();
    const label = this.label();
    if (k === 'tool') {
      g.font = font(11, 600);
      return [this.o.width ?? Math.max(62, Math.ceil(g.measureText(label).width) + 18), 60];
    }
    if (k === 'icon') return [this.o.width ?? 30, 30];
    const h = k === 'chip' || k === 'seg' ? 26 : 30;
    g.font = font(12, 600);
    const iconW = this.o.icon !== undefined ? 16 + (label !== '' ? 6 : 0) : 0;
    const textW = label !== '' ? Math.ceil(g.measureText(label).width) : 0;
    const padX = k === 'seg' ? 10 : 12;
    return [this.o.width ?? iconW + textW + padX * 2, h];
  }

  paint(g: CanvasRenderingContext2D, ui: UiState): void {
    const k = this.kind();
    const disabled = this.o.disabled?.() ?? false;
    const active = this.o.active?.() ?? false;
    const hover = ui.hover === this && !disabled;
    const pressed = ui.active === this && hover;
    g.save();
    if (disabled) g.globalAlpha = 0.38;
    let bg: string | null = null;
    let fg: string = theme.text;
    switch (k) {
      case 'primary':
        bg = pressed ? '#3d8ef0' : hover ? '#74b8ff' : theme.accent;
        fg = theme.accentText;
        break;
      case 'danger':
        bg = pressed ? 'rgba(255,93,93,0.35)' : hover ? 'rgba(255,93,93,0.25)' : 'rgba(255,93,93,0.15)';
        fg = '#ffb3b3';
        break;
      case 'ghost':
      case 'icon':
        bg = pressed ? theme.press : hover ? theme.hover : active ? theme.accentSoft : null;
        fg = active ? theme.accent : hover ? theme.text : theme.dim;
        break;
      case 'tool':
        bg = active ? theme.accentSoft : pressed ? theme.press : hover ? theme.hover : null;
        fg = active ? theme.accent : hover ? theme.text : theme.dim;
        break;
      case 'seg':
        bg = active ? theme.accent : pressed ? theme.press : hover ? theme.hover : null;
        fg = active ? theme.accentText : hover ? theme.text : theme.dim;
        break;
      default:
        bg = active ? theme.accentSoft : pressed ? theme.press : hover ? theme.hover : theme.raised;
        fg = active ? theme.accent : theme.text;
    }
    const r = k === 'tool' ? 10 : k === 'seg' ? 6 : 8;
    if (bg !== null) {
      g.fillStyle = bg;
      roundRect(g, this.x, this.y, this.w, this.h, r);
      g.fill();
    }
    const label = this.label();
    if (k === 'tool') {
      if (this.o.icon !== undefined) drawIcon(g, this.o.icon, this.x + this.w / 2 - 12, this.y + 9, 24, fg, 1.8);
      g.font = font(11, 600);
      g.fillStyle = fg;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, this.x + this.w / 2, this.y + 46);
      g.textAlign = 'left';
      if (active) {
        g.fillStyle = theme.accent;
        roundRect(g, this.x + this.w / 2 - 12, this.y + this.h - 3, 24, 3, 2);
        g.fill();
      }
    } else if (k === 'icon') {
      if (this.o.icon !== undefined) drawIcon(g, this.o.icon, this.x + (this.w - 18) / 2, this.y + (this.h - 18) / 2, 18, fg, 2);
    } else {
      g.font = font(12, 600);
      const iconW = this.o.icon !== undefined ? 16 + (label !== '' ? 6 : 0) : 0;
      const textW = label !== '' ? g.measureText(label).width : 0;
      let cx = this.x + (this.w - iconW - textW) / 2;
      if (this.o.icon !== undefined) {
        drawIcon(g, this.o.icon, cx, this.y + (this.h - 16) / 2, 16, fg, 2);
        cx += iconW;
      }
      if (label !== '') {
        g.fillStyle = fg;
        g.textBaseline = 'middle';
        g.fillText(label, cx, this.y + this.h / 2 + 0.5);
      }
    }
    g.restore();
  }

  override onUp(_p: PointerInfo, inside: boolean): void {
    if (inside && !(this.o.disabled?.() ?? false)) this.o.onClick();
  }
}

export interface SegOption<T> {
  value: T;
  label?: string;
  icon?: IconNode;
  tip?: string;
}

/** Segmented control: one choice out of a few. */
export function seg<T>(options: readonly SegOption<T>[], get: Getter<T>, set: (v: T) => void, width?: number): Stack {
  const buttons = options.map(
    (o) =>
      new Button({
        kind: 'seg',
        icon: o.icon,
        label: o.label,
        tip: o.tip,
        active: () => get() === o.value,
        onClick: () => set(o.value),
      }),
  );
  if (width !== undefined) for (const b of buttons) b.flex();
  return row({ gap: 2, pad: 2, bg: 'rgba(0,0,0,0.28)', radius: 8, width }, ...buttons);
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  get: Getter<number>;
  set: (v: number) => void;
  format?: (v: number) => string;
  width?: number;
  tip?: string;
}

export class Slider extends Widget {
  override interactive = true;

  constructor(private readonly o: SliderOpts) {
    super();
    if (o.tip !== undefined) this.tip = o.tip;
  }

  measure(): [number, number] {
    return [this.o.width ?? 240, 40];
  }

  private trackX0(): number {
    return this.x + 8;
  }

  private trackX1(): number {
    return this.x + this.w - 8;
  }

  private setFrom(px: number): void {
    const t = Math.max(0, Math.min(1, (px - this.trackX0()) / (this.trackX1() - this.trackX0())));
    const raw = this.o.min + t * (this.o.max - this.o.min);
    const stepped = Math.round(raw / this.o.step) * this.o.step;
    const v = Math.max(this.o.min, Math.min(this.o.max, Number(stepped.toFixed(6))));
    if (v !== this.o.get()) this.o.set(v);
  }

  paint(g: CanvasRenderingContext2D, ui: UiState): void {
    const v = this.o.get();
    g.font = font(12, 500);
    g.fillStyle = theme.dim;
    g.textBaseline = 'middle';
    g.fillText(this.o.label, this.x, this.y + 9);
    const text = this.o.format ? this.o.format(v) : String(v);
    g.font = font(12, 600);
    g.fillStyle = theme.text;
    g.textAlign = 'right';
    g.fillText(text, this.x + this.w, this.y + 9);
    g.textAlign = 'left';
    const t = (v - this.o.min) / (this.o.max - this.o.min);
    const x0 = this.trackX0();
    const x1 = this.trackX1();
    const ty = this.y + 28;
    g.fillStyle = theme.track;
    roundRect(g, x0, ty - 2, x1 - x0, 4, 2);
    g.fill();
    g.fillStyle = theme.accent;
    roundRect(g, x0, ty - 2, (x1 - x0) * t, 4, 2);
    g.fill();
    const hot = ui.hover === this || ui.active === this;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(x0 + (x1 - x0) * t, ty, hot ? 8 : 6.5, 0, Math.PI * 2);
    g.fill();
  }

  override onDown(p: PointerInfo): void {
    this.setFrom(p.x);
  }

  override onDrag(p: PointerInfo): void {
    this.setFrom(p.x);
  }

  override onWheel(dy: number): boolean {
    const v = this.o.get() + (dy < 0 ? this.o.step : -this.o.step);
    this.o.set(Math.max(this.o.min, Math.min(this.o.max, Number(v.toFixed(6)))));
    return true;
  }
}

export class Toggle extends Widget {
  override interactive = true;

  constructor(
    private readonly label: string,
    private readonly get: Getter<boolean>,
    private readonly set: (v: boolean) => void,
  ) {
    super();
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    g.font = font(12, 500);
    return [Math.ceil(g.measureText(this.label).width) + 52, 26];
  }

  paint(g: CanvasRenderingContext2D, ui: UiState): void {
    const on = this.get();
    g.font = font(12, 500);
    g.fillStyle = ui.hover === this ? theme.text : theme.dim;
    g.textBaseline = 'middle';
    g.fillText(this.label, this.x, this.y + this.h / 2);
    const sw = 34;
    const sx = this.x + this.w - sw;
    const sy = this.y + (this.h - 18) / 2;
    g.fillStyle = on ? theme.accent : theme.track;
    roundRect(g, sx, sy, sw, 18, 9);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(on ? sx + sw - 9 : sx + 9, sy + 9, 6.5, 0, Math.PI * 2);
    g.fill();
  }

  override onUp(_p: PointerInfo, inside: boolean): void {
    if (inside) this.set(!this.get());
  }
}

/** Label with [−] value [+] controls. */
export function stepper(label: string, get: Getter<number>, set: (v: number) => void, step: number, min: number, max: number, format: (v: number) => string, minus: IconNode, plus: IconNode): Stack {
  const clamp = (v: number) => Math.max(min, Math.min(max, Number(v.toFixed(6))));
  return row(
    { gap: 4, align: 'center' },
    new Label(label, { color: theme.dim }).flex(),
    new Button({ kind: 'icon', icon: minus, onClick: () => set(clamp(get() - step)), disabled: () => get() <= min, width: 26 }),
    new Label(() => format(get()), { weight: 600, align: 'center', minWidth: 54 }),
    new Button({ kind: 'icon', icon: plus, onClick: () => set(clamp(get() + step)), disabled: () => get() >= max, width: 26 }),
  );
}

export class Progress extends Widget {
  constructor(
    private readonly get: Getter<number>,
    private readonly width = 240,
  ) {
    super();
  }

  measure(): [number, number] {
    return [this.width, 8];
  }

  paint(g: CanvasRenderingContext2D): void {
    g.fillStyle = theme.track;
    roundRect(g, this.x, this.y + 2, this.w, 4, 2);
    g.fill();
    g.fillStyle = theme.accent;
    roundRect(g, this.x, this.y + 2, this.w * Math.max(0, Math.min(1, this.get())), 4, 2);
    g.fill();
  }
}

export interface GraphOpts {
  label: string;
  values: Getter<ArrayLike<number>>;
  color: string;
  format: (v: number) => string;
  width?: number;
  height?: number;
}

/** Sparkline with the latest value. */
export class Graph extends Widget {
  constructor(private readonly o: GraphOpts) {
    super();
  }

  measure(): [number, number] {
    return [this.o.width ?? 260, this.o.height ?? 66];
  }

  paint(g: CanvasRenderingContext2D): void {
    const vals = this.o.values();
    const n = vals.length;
    g.font = font(11, 600);
    g.fillStyle = theme.dim;
    g.textBaseline = 'middle';
    g.letterSpacing = '0.5px';
    g.fillText(this.o.label.toUpperCase(), this.x, this.y + 8);
    g.letterSpacing = '0px';
    g.font = font(13, 700);
    g.fillStyle = theme.text;
    g.textAlign = 'right';
    g.fillText(n > 0 ? this.o.format(vals[n - 1]) : '—', this.x + this.w, this.y + 8);
    g.textAlign = 'left';
    const top = this.y + 20;
    const bottom = this.y + this.h - 2;
    g.fillStyle = 'rgba(255,255,255,0.03)';
    roundRect(g, this.x, top, this.w, bottom - top, 6);
    g.fill();
    if (n < 2) return;
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, vals[i]);
    max = max <= 0 ? 1 : max * 1.15;
    const px = (i: number) => this.x + (i / (n - 1)) * this.w;
    const py = (v: number) => bottom - (v / max) * (bottom - top - 4);
    g.beginPath();
    g.moveTo(px(0), py(vals[0]));
    for (let i = 1; i < n; i++) g.lineTo(px(i), py(vals[i]));
    g.strokeStyle = this.o.color;
    g.lineWidth = 1.6;
    g.stroke();
    g.lineTo(px(n - 1), bottom);
    g.lineTo(px(0), bottom);
    g.closePath();
    const grad = g.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, this.o.color + '55');
    grad.addColorStop(1, this.o.color + '00');
    g.fillStyle = grad;
    g.fill();
  }
}

export interface Column {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

/** Simple table with a header row. */
export class Table extends Widget {
  constructor(
    private readonly columns: Column[],
    private readonly rows: Getter<string[][]>,
    private readonly highlight: Getter<number> = () => -1,
  ) {
    super();
  }

  measure(): [number, number] {
    const w = this.columns.reduce((s, c) => s + c.width, 0);
    return [w, 22 + Math.max(1, this.rows().length) * 22];
  }

  paint(g: CanvasRenderingContext2D): void {
    g.textBaseline = 'middle';
    let x = this.x;
    g.font = font(10, 700);
    g.fillStyle = theme.faint;
    for (const c of this.columns) {
      g.textAlign = c.align ?? 'left';
      g.fillText(c.label.toUpperCase(), c.align === 'right' ? x + c.width - 4 : x + 4, this.y + 10);
      x += c.width;
    }
    const rows = this.rows();
    const hi = this.highlight();
    rows.forEach((r, i) => {
      const y = this.y + 22 + i * 22;
      if (i === hi) {
        g.fillStyle = theme.accentSoft;
        roundRect(g, this.x, y, this.w, 22, 5);
        g.fill();
      } else if (i % 2 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.025)';
        g.fillRect(this.x, y, this.w, 22);
      }
      let cx = this.x;
      g.font = font(12, 500);
      g.fillStyle = theme.text;
      this.columns.forEach((c, k) => {
        g.textAlign = c.align ?? 'left';
        const text = ellipsize(g, r[k] ?? '', c.width - 8);
        g.fillText(text, c.align === 'right' ? cx + c.width - 4 : cx + 4, y + 11);
        cx += c.width;
      });
    });
    if (rows.length === 0) {
      g.font = font(12, 400);
      g.fillStyle = theme.faint;
      g.textAlign = 'left';
      g.fillText('No runs yet', this.x + 4, this.y + 33);
    }
    g.textAlign = 'left';
  }
}

/** Small coloured badge (e.g. level of service). */
export class Badge extends Widget {
  constructor(
    private readonly text: Getter<string>,
    private readonly color: Getter<string>,
  ) {
    super();
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    g.font = font(12, 700);
    return [Math.max(24, Math.ceil(g.measureText(this.text()).width) + 14), 22];
  }

  paint(g: CanvasRenderingContext2D): void {
    g.fillStyle = this.color();
    roundRect(g, this.x, this.y, this.w, this.h, 6);
    g.fill();
    g.font = font(12, 700);
    g.fillStyle = '#0d1117';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(this.text(), this.x + this.w / 2, this.y + this.h / 2 + 0.5);
    g.textAlign = 'left';
  }
}

/** Makes any widget a button: hover highlight, active state and a click handler. */
export class Clickable extends Widget {
  override interactive = true;

  constructor(
    private readonly child: Widget,
    private readonly onClick: () => void,
    private readonly active: Getter<boolean> = () => false,
  ) {
    super();
  }

  measure(g: CanvasRenderingContext2D): [number, number] {
    return this.child.measure(g);
  }

  override arrange(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    super.arrange(g, x, y, w, h);
    this.child.arrange(g, x, y, w, h);
  }

  paint(g: CanvasRenderingContext2D, ui: UiState): void {
    const hot = ui.hover === this;
    const bg = this.active() ? theme.accentSoft : ui.active === this && hot ? theme.press : hot ? theme.hover : theme.raised;
    g.fillStyle = bg;
    roundRect(g, this.x, this.y, this.w, this.h, 10);
    g.fill();
    if (this.active()) {
      g.strokeStyle = theme.accent;
      g.lineWidth = 1.5;
      roundRect(g, this.x + 0.75, this.y + 0.75, this.w - 1.5, this.h - 1.5, 10);
      g.stroke();
    }
    this.child.paint(g, ui);
  }

  override onUp(_p: PointerInfo, inside: boolean): void {
    if (inside) this.onClick();
  }
}
