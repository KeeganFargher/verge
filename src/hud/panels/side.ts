import {
  CircleAlert,
  CircleCheck,
  Info,
  LayoutGrid,
  Minus,
  Plus,
  RotateCcw,
  Settings,
  Trash,
  X,
  Keyboard,
} from 'lucide';
import type { App } from '../../app/App';
import { presets } from '../../presets';
import { int, secs } from '../format';
import { Panel } from '../Hud';
import { theme } from '../theme';
import {
  Button,
  Clickable,
  Divider,
  Graph,
  Icon,
  Label,
  Para,
  Toggle,
  col,
  row,
  seg,
  stepper,
  Table,
  Dyn,
  type Widget,
} from '../ui';
import { experimentButton } from './bars';

const W = 300;

function title(app: App, text: string, close: () => void): Widget {
  void app;
  return row({ gap: 8, align: 'center', width: W }, new Label(text, { size: 14, weight: 700 }).flex(), new Button({ kind: 'icon', icon: X, onClick: close }));
}

/** Last N samples of one series, for the sparklines. */
function series(app: App, pick: (s: App['sim']['metrics']['samples'][number]) => number): () => number[] {
  return () => app.sim.metrics.samples.slice(-144).map(pick);
}

export function analytics(app: App): Panel {
  const close = () => {
    app.analyticsOpen = false;
    app.hud.invalidate();
  };
  const root = col(
    { bg: theme.panel, radius: 14, border: theme.panelBorder, shadow: true, pad: 14, gap: 12 },
    title(app, 'Analytics', close),
    new Graph({ label: 'Throughput (trips/h)', values: series(app, (s) => s.throughput), color: '#5aa9ff', format: (v) => int(v), width: W }),
    new Graph({ label: 'Mean delay (s)', values: series(app, (s) => s.delay), color: '#ffb547', format: (v) => v.toFixed(1), width: W }),
    new Graph({ label: 'Vehicles in network', values: series(app, (s) => s.vehicles), color: '#46d39a', format: (v) => int(v), width: W }),
    new Graph({ label: 'Mean speed (km/h)', values: series(app, (s) => s.speed), color: '#c792ea', format: (v) => int(v), width: W }),
    new Divider(),
    row({ gap: 8, align: 'center', width: W }, new Label('EXPERIMENTS', { size: 10, weight: 700, color: theme.faint }).flex(), new Button({ kind: 'ghost', icon: Trash, label: 'Clear', onClick: () => ((app.experiments = []), app.hud.invalidate()), disabled: () => app.experiments.length === 0 })),
    seg(
      [10, 15, 30, 60].map((m) => ({ value: m, label: `${m} min` })),
      () => app.experimentMinutes,
      (m) => ((app.experimentMinutes = m), app.hud.invalidate()),
      W,
    ),
    experimentButton(app),
    new Table(
      [
        { label: '#', width: 22 },
        { label: 'Setup', width: 114 },
        { label: 'veh/h', width: 50, align: 'right' },
        { label: 'delay', width: 58, align: 'right' },
        { label: 'stops', width: 56, align: 'right' },
      ],
      () => app.experiments.map((r) => [String(r.id), r.label, int(r.throughput), secs(r.delay), r.stops.toFixed(1)]),
      () => {
        // Highlight the run with the lowest delay.
        if (app.experiments.length < 2) return -1;
        let best = 0;
        app.experiments.forEach((r, i) => {
          if (r.delay < app.experiments[best].delay) best = i;
        });
        return best;
      },
    ),
    new Para('Same seed, same arrivals: change one thing (a junction type, a timing), run again and compare. The best run is highlighted.', W, { size: 11 }),
    col(
      { gap: 4 },
      row({ gap: 6, align: 'center' }, new Icon(CircleAlert, 14, theme.bad), new Label(() => `${app.sim.metrics.incidents} simulation incidents`, { color: theme.bad, weight: 600 })),
      new Dyn(
        () => app.sim.metrics.incidentLog.join('|'),
        () => col({ gap: 2 }, ...app.sim.metrics.incidentLog.slice(-4).map((l) => new Para(l, W, { size: 10, color: theme.dim }))),
      ),
    ).when(() => app.sim.metrics.incidents > 0),
  );
  return new Panel(root, () => [14, 64], { visible: () => app.analyticsOpen && app.modal === null, live: 1000 });
}

function presetsModal(app: App): Widget {
  const cards = presets.map((p) =>
    new Clickable(
      col({ pad: 12, gap: 6, width: 250 }, new Label(p.name, { weight: 700, size: 13 }), new Para(p.description, 226, { size: 11 })),
      () => app.loadPreset(p.id),
      () => app.design.name === p.name,
    ),
  );
  const rows: Widget[] = [];
  for (let i = 0; i < cards.length; i += 3) rows.push(row({ gap: 10 }, ...cards.slice(i, i + 3)));
  return col(
    { gap: 12 },
    row({ gap: 10, align: 'center', width: 770 }, new Icon(LayoutGrid, 20, theme.accent), new Label('Presets', { size: 16, weight: 700 }).flex(), new Button({ kind: 'icon', icon: X, onClick: () => app.toggleModal('presets') })),
    new Para('Start from a ready-made layout. Loading replaces the current network (undo brings it back).', 770),
    ...rows,
  );
}

function settingsModal(app: App): Widget {
  const W2 = 360;
  return col(
    { gap: 12, width: W2 },
    row({ gap: 10, align: 'center', width: W2 }, new Icon(Settings, 20, theme.accent), new Label('Settings', { size: 16, weight: 700 }).flex(), new Button({ kind: 'icon', icon: X, onClick: () => app.toggleModal('settings') })),
    new Label('DRIVE ON THE', { size: 10, weight: 700, color: theme.faint }),
    seg(
      [
        { value: 'left' as const, label: 'Left', tip: 'UK, South Africa, Australia, Japan, India…' },
        { value: 'right' as const, label: 'Right', tip: 'Americas, continental Europe, China…' },
      ],
      () => app.design.drivingSide,
      (v) => app.setDrivingSide(v),
      W2,
    ),
    new Para('Mirrors everything: lane positions, which turns cross traffic, and roundabout direction.', W2, { size: 11 }),
    new Divider(),
    new Label('VEHICLE COLOURS', { size: 10, weight: 700, color: theme.faint }),
    seg(
      [
        { value: 'type' as const, label: 'Paint' },
        { value: 'speed' as const, label: 'Speed', tip: 'Red when stopped, green at the speed it wants.' },
        { value: 'destination' as const, label: 'Destination', tip: 'One colour per exit: see where traffic flows.' },
      ],
      () => app.view.colorMode,
      (v) => ((app.view.colorMode = v), app.hud.invalidate()),
      W2,
    ),
    new Toggle('Junction & entry labels  (L)', () => app.view.labels, (v) => ((app.view.labels = v), app.hud.invalidate())),
    new Toggle('Ground grid  (G)', () => app.view.grid, (v) => ((app.view.grid = v), app.hud.invalidate())),
    new Divider(),
    stepper(
      'Random seed',
      () => app.design.traffic.seed,
      (v) => app.editDesign((d) => (d.traffic.seed = v), 'seed'),
      1,
      1,
      9999,
      (v) => String(v),
      Minus,
      Plus,
    ).hint('Changes arrival times, destinations and drivers. Same seed = identical demand between runs.'),
    new Button({ icon: RotateCcw, label: 'Restart traffic', onClick: () => app.restart() }),
  );
}

function helpModal(app: App): Widget {
  const W2 = 520;
  const line = (keys: string, what: string) => row({ gap: 12, width: W2 }, new Label(keys, { weight: 700, minWidth: 170 }), new Label(what, { color: theme.dim }).flex());
  return col(
    { gap: 7, width: W2 },
    row({ gap: 10, align: 'center', width: W2 }, new Icon(Keyboard, 20, theme.accent), new Label('Controls', { size: 16, weight: 700 }).flex(), new Button({ kind: 'icon', icon: X, onClick: () => app.toggleModal('help') })),
    line('Right-drag / drag empty ground', 'Pan'),
    line('Middle-drag / Alt + drag', 'Rotate and tilt'),
    line('Scroll, + / −', 'Zoom (towards the pointer)'),
    line('W A S D / arrows, Q E', 'Pan and rotate with the keyboard'),
    line('F', 'Frame the whole network'),
    new Divider(),
    line('V  R  B  J  T  M', 'Select · Roads · Bulldoze · Junctions · Traffic · Map'),
    line('Space,  1 – 5', 'Pause / play, speed 1× – 16×'),
    line('Ctrl+Z,  Ctrl+Shift+Z', 'Undo, redo'),
    line('Delete', 'Remove the selected road or junction'),
    line('Esc / right-click', 'Stop drawing, cancel, deselect'),
    line('Ctrl+S,  Ctrl+O', 'Save / open a project file'),
    line('P,  H,  L,  G', 'Presets, this help, labels, grid'),
    new Divider(),
    new Para('Trace a real place: open the Map tool, load (or drop / paste) a Google Maps screenshot, calibrate its scale with a known distance, then draw roads over it. Swap a junction for a roundabout and run an experiment before and after to compare.', W2),
  );
}

export function modal(app: App): Panel {
  const root = col(
    { bg: theme.panel, radius: 16, border: theme.panelBorder, shadow: true, pad: 18 },
    new Dyn(
      () => String(app.modal),
      () => {
        switch (app.modal) {
          case 'presets':
            return presetsModal(app);
          case 'settings':
            return settingsModal(app);
          case 'help':
            return helpModal(app);
          case null:
            return new Label('');
        }
      },
    ),
  );
  return new Panel(root, (sw, sh, w, h) => [(sw - w) / 2, Math.max(64, (sh - h) / 2)], { visible: () => app.modal !== null });
}

export function toasts(app: App): Panel {
  const root = new Dyn(
    () => app.toasts.map((t) => t.id).join(','),
    () =>
      col(
        { gap: 6, align: 'center' },
        ...app.toasts.map((t) =>
          row(
            { gap: 8, align: 'center', pad: [7, 12, 7, 10], bg: 'rgba(17, 21, 29, 0.95)', radius: 18, border: theme.panelBorder },
            new Icon(t.kind === 'error' ? CircleAlert : t.kind === 'success' ? CircleCheck : Info, 15, t.kind === 'error' ? theme.bad : t.kind === 'success' ? theme.good : theme.accent),
            new Label(t.text, { weight: 600, maxWidth: 560 }),
          ),
        ),
      ),
  );
  return new Panel(root, (sw, _sh, w) => [(sw - w) / 2, 62], { visible: () => app.toasts.length > 0 });
}
