import type { Design } from '../sim/design';
import type { Background, Project } from './project';

/** Offers the project as a downloadable JSON file. */
export function downloadProject(project: Project): void {
  const blob = new Blob([JSON.stringify({ format: 'verge-project', ...project }, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.design.name.replace(/[^\w\- ]+/g, '').trim() || 'network'}.verge.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Parses a saved project, failing loudly on anything that isn't one. */
export function parseProject(text: string): Project {
  const data: unknown = JSON.parse(text);
  if (typeof data !== 'object' || data === null || (data as { format?: unknown }).format !== 'verge-project') {
    throw new Error('Not a Verge project file');
  }
  const p = data as { design?: Design; background?: Background | null };
  if (p.design === undefined || !Array.isArray(p.design.nodes) || !Array.isArray(p.design.roads)) throw new Error('Project file has no network');
  if (p.background === undefined) throw new Error('Project file has no background entry');
  return { design: p.design, background: p.background };
}

/** Lets the user pick a file; must be called from inside a user gesture (a click). */
export function pickFile(accept: string, onFile: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f !== undefined) onFile(f);
  };
  input.click();
}

export function readText(file: File): Promise<string> {
  return file.text();
}

/** Reads an image file into a background, centred on a point, at an initial guess of scale. */
export function readImage(file: File, x: number, y: number): Promise<Background> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image the browser can show'));
      img.onload = () =>
        // Google Maps at street zoom is roughly 0.3–0.6 m per pixel; calibrate from there.
        resolve({ src, width: img.naturalWidth, height: img.naturalHeight, x, y, metersPerPixel: 0.5, rotation: 0, opacity: 0.85, locked: false });
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}
