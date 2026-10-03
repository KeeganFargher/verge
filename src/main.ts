import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import { App } from './app/App';
import { Input } from './app/Input';
import { buildHud } from './hud/panels';

async function start(): Promise<void> {
  // The HUD paints text into canvases, which only use a web font once it has loaded.
  await Promise.all(['400', '500', '600', '700', '800'].map((w) => document.fonts.load(`${w} 13px Inter`)));
  const canvas = document.getElementById('view');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing #view canvas');
  const app = new App(canvas);
  buildHud(app);
  const input = new Input(canvas, app);
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    app.resize(w, h, Math.min(2, window.devicePixelRatio || 1));
  };
  window.addEventListener('resize', resize);
  resize();
  let last = performance.now();
  const loop = (now: number) => {
    input.applyKeys(Math.min(0.1, (now - last) / 1000));
    last = now;
    app.frame(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Handy for poking at the simulation from the browser console.
  Object.assign(window, { verge: app });
}

void start();
