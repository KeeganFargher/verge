import type { IconNode } from 'lucide';

const cache = new WeakMap<IconNode, Path2D[]>();

function num(v: string | number | undefined): number {
  if (v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

function points(attr: string | number | undefined): number[] {
  return String(attr ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
}

/** Lucide icons are 24×24 stroke drawings described as SVG elements; turn them into Path2D once. */
function compile(icon: IconNode): Path2D[] {
  const out: Path2D[] = [];
  for (const [tag, a] of icon) {
    switch (tag) {
      case 'path':
        out.push(new Path2D(String(a.d)));
        break;
      case 'circle': {
        const p = new Path2D();
        p.arc(num(a.cx), num(a.cy), num(a.r), 0, Math.PI * 2);
        out.push(p);
        break;
      }
      case 'ellipse': {
        const p = new Path2D();
        p.ellipse(num(a.cx), num(a.cy), num(a.rx), num(a.ry), 0, 0, Math.PI * 2);
        out.push(p);
        break;
      }
      case 'rect': {
        const p = new Path2D();
        p.roundRect(num(a.x), num(a.y), num(a.width), num(a.height), num(a.rx));
        out.push(p);
        break;
      }
      case 'line': {
        const p = new Path2D();
        p.moveTo(num(a.x1), num(a.y1));
        p.lineTo(num(a.x2), num(a.y2));
        out.push(p);
        break;
      }
      case 'polyline':
      case 'polygon': {
        const pts = points(a.points);
        const p = new Path2D();
        for (let i = 0; i + 1 < pts.length; i += 2) {
          if (i === 0) p.moveTo(pts[i], pts[i + 1]);
          else p.lineTo(pts[i], pts[i + 1]);
        }
        if (tag === 'polygon') p.closePath();
        out.push(p);
        break;
      }
      default:
        throw new Error(`Unsupported icon element <${tag}>`);
    }
  }
  return out;
}

/** Draws an icon with its top-left corner at (x, y). */
export function drawIcon(g: CanvasRenderingContext2D, icon: IconNode, x: number, y: number, size: number, color: string, stroke = 2): void {
  let paths = cache.get(icon);
  if (paths === undefined) {
    paths = compile(icon);
    cache.set(icon, paths);
  }
  g.save();
  g.translate(x, y);
  g.scale(size / 24, size / 24);
  g.strokeStyle = color;
  g.lineWidth = stroke;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const p of paths) g.stroke(p);
  g.restore();
}
