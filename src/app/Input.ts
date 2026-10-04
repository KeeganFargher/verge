import { Vector2, Vector3 } from 'three';
import type { App } from './App';
import { SPEEDS } from './App';
import type { WorldPointer } from '../editor/Editor';

type Gesture = 'none' | 'hud' | 'tool' | 'pan' | 'rotate';

/**
 * Single entry point for pointer and keyboard input on the canvas. The HUD gets first say;
 * then the active tool; whatever is left drives the camera. Keeping one router (rather than
 * separate DOM listeners per consumer) is what lets the HUD live inside the 3D canvas.
 */
export class Input {
  private gesture: Gesture = 'none';
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = false;
  private button = 0;
  private readonly keys = new Set<string>();
  private readonly ndc = new Vector2();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly app: App,
  ) {
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => {
      if (this.gesture === 'none') app.hud.leave();
    });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('dragover', (e) => e.preventDefault());
    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files[0];
      if (f !== undefined) void app.openFile(f);
    });
    window.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file !== undefined && file !== null) void app.openFile(file);
    });
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private worldPointer(x: number, y: number, shift: boolean): WorldPointer {
    this.ndc.set((x / this.app.hud.width) * 2 - 1, -(y / this.app.hud.height) * 2 + 1);
    const g = this.app.world.rig.groundAt(this.ndc);
    const world = g === null ? null : new Vector2(g.x, g.z);
    const tag = this.app.views.labels.hit(this.ndc, this.app.world.rig.camera);
    return { world, pixel: this.app.pixelSize(world), shift, tag };
  }

  private down(e: PointerEvent): void {
    const [x, y] = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.downX = this.lastX = x;
    this.downY = this.lastY = y;
    this.moved = false;
    this.button = e.button;
    if (this.app.hud.pointerDown(x, y, e.shiftKey)) {
      this.gesture = 'hud';
      return;
    }
    if (e.button === 0 && !e.altKey && this.app.editor.down(this.worldPointer(x, y, e.shiftKey))) {
      this.gesture = 'tool';
      return;
    }
    this.gesture = e.button === 1 || (e.button === 0 && e.altKey) ? 'rotate' : 'pan';
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (Math.hypot(x - this.downX, y - this.downY) > 4) this.moved = true;
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    switch (this.gesture) {
      case 'hud':
        this.app.hud.pointerMove(x, y, e.shiftKey);
        return;
      case 'pan': {
        // Grab the ground: the point under the pointer stays under it.
        const prev = this.worldPointer(x - dx, y - dy, false).world;
        const cur = this.worldPointer(x, y, false).world;
        if (prev !== null && cur !== null) this.app.world.rig.shift(prev.x - cur.x, prev.y - cur.y);
        return;
      }
      case 'rotate':
        this.app.world.rig.rotate(-dx * 0.006, dy * 0.004);
        return;
      case 'tool':
        this.app.editor.move(this.worldPointer(x, y, e.shiftKey));
        return;
      case 'none': {
        if (this.app.hud.pointerMove(x, y, e.shiftKey)) {
          this.app.editor.hover = null;
          this.canvas.style.cursor = 'default';
          return;
        }
        const p = this.worldPointer(x, y, e.shiftKey);
        this.app.editor.move(p);
        this.app.editor.trackCursor(p);
        this.canvas.style.cursor = this.app.editor.hover !== null || this.app.tool === 'road' ? 'crosshair' : 'grab';
      }
    }
  }

  private up(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const g = this.gesture;
    this.gesture = 'none';
    switch (g) {
      case 'hud':
        this.app.hud.pointerUp(x, y, e.shiftKey);
        return;
      case 'tool':
        this.app.editor.up(this.worldPointer(x, y, e.shiftKey), !this.moved);
        return;
      case 'pan':
        // A right click that didn't drag backs out of the current action, or clears the selection.
        if (this.button === 2 && !this.moved && !this.app.editor.cancel()) this.app.select(null);
        // A plain left click on empty ground clears the selection.
        if (this.button === 0 && !this.moved && this.app.tool !== 'map') this.app.select(null);
        this.app.hud.invalidate();
        return;
      case 'rotate':
      case 'none':
        return;
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const [x, y] = this.local(e);
    if (this.app.hud.wheel(x, y, e.deltaY)) return;
    const p = this.worldPointer(x, y, false).world;
    // Pinch gestures arrive as ctrl+wheel with small deltas; scale them up.
    const delta = e.ctrlKey ? e.deltaY * 4 : e.deltaY;
    const factor = Math.exp(Math.max(-60, Math.min(60, delta)) * 0.0028);
    this.app.world.rig.zoom(factor, p === null ? null : new Vector3(p.x, 0, p.y));
  }

  private keyDown(e: KeyboardEvent): void {
    const app = this.app;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
      return;
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      app.redo();
      return;
    }
    if (mod && e.code === 'KeyS') {
      e.preventDefault();
      app.exportProject();
      return;
    }
    if (mod && e.code === 'KeyO') {
      e.preventDefault();
      app.importProject();
      return;
    }
    if (mod) return;
    this.keys.add(e.code);
    const tools: Record<string, Parameters<App['setTool']>[0]> = { KeyV: 'select', KeyR: 'road', KeyB: 'bulldoze', KeyJ: 'junction', KeyT: 'traffic', KeyM: 'map' };
    const tool = tools[e.code];
    if (tool !== undefined) {
      app.setTool(tool);
      return;
    }
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        app.togglePause();
        return;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4':
      case 'Digit5':
        app.setSpeed(SPEEDS[Number(e.code.slice(5)) - 1]);
        return;
      case 'Escape':
        if (app.modal !== null) app.modal = null;
        else if (!app.editor.cancel()) app.select(null);
        app.hud.invalidate();
        return;
      case 'Delete':
      case 'Backspace':
        app.deleteSelection();
        return;
      case 'KeyH':
        app.toggleModal('help');
        return;
      case 'KeyP':
        app.toggleModal('presets');
        return;
      case 'KeyL':
        app.view.labels = !app.view.labels;
        app.hud.invalidate();
        return;
      case 'KeyG':
        app.view.grid = !app.view.grid;
        app.hud.invalidate();
        return;
      case 'KeyF':
        app.frameDesign();
        return;
    }
  }

  /** Continuous camera movement from held keys. */
  applyKeys(dt: number): void {
    const k = this.keys;
    const rig = this.app.world.rig;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (f !== 0 || r !== 0) rig.panView(f * dt * 1.1, r * dt * 1.1);
    const rot = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (rot !== 0) rig.rotate(rot * dt * 1.6, 0);
    const zoom = (k.has('Minus') || k.has('NumpadSubtract') ? 1 : 0) - (k.has('Equal') || k.has('NumpadAdd') ? 1 : 0);
    if (zoom !== 0) rig.zoom(Math.exp(zoom * dt * 1.8), null);
  }
}
