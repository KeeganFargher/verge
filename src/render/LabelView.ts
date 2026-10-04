import { CanvasTexture, Group, LinearFilter, Raycaster, SRGBColorSpace, Sprite, SpriteMaterial, type Camera, type Vector2 } from 'three';

export interface LabelSpec {
  key: string;
  /** Design node the tag describes; clicking the tag picks it. */
  node: number;
  x: number;
  y: number;
  /** Height above the ground (m). */
  lift: number;
  text: string;
  /** Badge colour (CSS). */
  badge: string;
  badgeText: string;
}

interface Entry {
  node: number;
  sprite: Sprite;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  drawn: string;
  aspect: number;
}

const PX_HEIGHT = 24;

/** Small floating tags in the 3D view (junction level of service, entry flows), constant size on screen. */
export class LabelView {
  readonly group = new Group();
  private readonly entries = new Map<string, Entry>();
  private readonly raycaster = new Raycaster();
  private viewportHeight = 800;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);

  resize(viewportHeight: number, fovDeg: number): void {
    this.viewportHeight = viewportHeight;
    this.fovScale = Math.tan((fovDeg * Math.PI) / 360);
    for (const e of this.entries.values()) this.applyScale(e);
  }

  private fovScale = Math.tan((45 * Math.PI) / 360);

  private applyScale(e: Entry): void {
    // With sizeAttenuation off, a sprite's scale is in units of (view depth); this keeps PX_HEIGHT pixels.
    const sy = (2 * PX_HEIGHT * this.fovScale) / this.viewportHeight;
    e.sprite.scale.set(sy * e.aspect, sy, 1);
  }

  set(labels: readonly LabelSpec[]): void {
    const keep = new Set(labels.map((l) => l.key));
    for (const [key, e] of this.entries) {
      if (keep.has(key)) continue;
      this.group.remove(e.sprite);
      e.texture.dispose();
      e.sprite.material.dispose();
      this.entries.delete(key);
    }
    for (const l of labels) {
      let e = this.entries.get(l.key);
      if (e === undefined) {
        const canvas = document.createElement('canvas');
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = LinearFilter;
        texture.generateMipmaps = false;
        const sprite = new Sprite(new SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }));
        sprite.center.set(0.5, 0);
        sprite.renderOrder = 10;
        e = { node: l.node, sprite, canvas, texture, drawn: '', aspect: 1 };
        this.entries.set(l.key, e);
        this.group.add(sprite);
      }
      e.sprite.position.set(l.x, l.lift, l.y);
      const signature = `${l.badge}|${l.badgeText}|${l.text}`;
      if (signature !== e.drawn) {
        this.draw(e, l);
        e.drawn = signature;
        this.applyScale(e);
      }
    }
  }

  /**
   * Design node whose tag is under a screen point (normalised device coordinates), or null.
   * Tags float above what they describe, so they hide the very disc or junction a click aims at.
   */
  hit(ndc: Vector2, camera: Camera): number | null {
    this.raycaster.setFromCamera(ndc, camera);
    const hits = this.raycaster.intersectObjects(this.group.children, false);
    if (hits.length === 0) return null;
    for (const e of this.entries.values()) if (e.sprite === hits[0].object) return e.node;
    throw new Error('Hit a sprite that is not a tag');
  }

  private draw(e: Entry, l: LabelSpec): void {
    const font = '600 13px Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
    const measure = document.createElement('canvas').getContext('2d');
    if (measure === null) throw new Error('2D canvas unavailable');
    measure.font = font;
    const badgeW = l.badgeText === '' ? 0 : measure.measureText(l.badgeText).width + 12;
    const textW = measure.measureText(l.text).width;
    const w = Math.ceil(badgeW + textW + 16 + (badgeW > 0 ? 4 : 0));
    const h = PX_HEIGHT;
    e.canvas.width = w * this.dpr;
    e.canvas.height = h * this.dpr;
    const g = e.canvas.getContext('2d');
    if (g === null) throw new Error('2D canvas unavailable');
    g.scale(this.dpr, this.dpr);
    g.font = font;
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(17, 21, 29, 0.86)';
    g.beginPath();
    g.roundRect(0, 0, w, h, 7);
    g.fill();
    let x = 6;
    if (badgeW > 0) {
      g.fillStyle = l.badge;
      g.beginPath();
      g.roundRect(4, 4, badgeW, h - 8, 5);
      g.fill();
      g.fillStyle = '#0d1117';
      g.fillText(l.badgeText, 10, h / 2 + 0.5);
      x = badgeW + 10;
    }
    g.fillStyle = '#e8edf5';
    g.fillText(l.text, x, h / 2 + 0.5);
    e.aspect = w / h;
    // The canvas was resized, so the GPU texture must be reallocated.
    e.texture.dispose();
    e.texture.needsUpdate = true;
  }
}
