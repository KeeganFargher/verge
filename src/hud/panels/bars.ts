import type { IconNode } from 'lucide';
import {
  Activity,
  Car,
  ChartLine,
  CircleQuestionMark,
  Construction,
  Download,
  FlaskConical,
  Gauge,
  ImagePlus,
  LayoutGrid,
  Lock,
  LockOpen,
  Map as MapIcon,
  Minus,
  MousePointer2,
  Octagon,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Route,
  Ruler,
  Settings,
  Signpost,
  Spline,
  Timer,
  TrafficCone,
  TriangleAlert,
  Trash,
  Undo2,
  Upload,
  Waypoints,
} from 'lucide';
import { SPEEDS, type App } from '../../app/App';
import type { ToolId } from '../../editor/Editor';
import { clock, int, secs } from '../format';
import { Panel } from '../Hud';
import { theme } from '../theme';
import { Button, Divider, Dyn, Icon, Label, Para, Progress, Slider, Spacer, Toggle, col, row, seg, stepper, type Widget } from '../ui';

const PANEL = { bg: theme.panel, radius: 14, border: theme.panelBorder, shadow: true } as const;

function kpi(icon: IconNode, value: () => string, tip: string, color: () => string = () => theme.text): Widget {
  return row({ gap: 6, align: 'center', pad: [0, 6, 0, 6] }, new Icon(icon, 15, theme.dim), new Label(value, { weight: 600, color, minWidth: 34 })).hint(tip);
}

export function topBar(app: App): Panel {
  const sim = () => app.sim;
  const root = row(
    { ...PANEL, radius: 0, shadow: false, border: undefined, pad: [8, 14, 8, 14], gap: 8, align: 'center', width: () => app.hud.width, bg: 'rgba(13, 16, 23, 0.94)' },
    new Icon(Waypoints, 20, theme.accent),
    new Label('VERGE', { size: 14, weight: 800, upper: true }),
    new Label(() => app.design.name, { color: theme.dim, maxWidth: 220 }),
    new Divider(true),
    new Button({ kind: 'icon', icon: Undo2, onClick: () => app.undo(), disabled: () => !app.history.canUndo, tip: 'Undo  (Ctrl+Z)' }),
    new Button({ kind: 'icon', icon: Redo2, onClick: () => app.redo(), disabled: () => !app.history.canRedo, tip: 'Redo  (Ctrl+Shift+Z)' }),
    new Button({ kind: 'icon', icon: Download, onClick: () => app.exportProject(), tip: 'Save project file  (Ctrl+S)' }),
    new Button({ kind: 'icon', icon: Upload, onClick: () => app.importProject(), tip: 'Open project file  (Ctrl+O)\nYou can also drop a file onto the map.' }),
    new Spacer().flex(),
    row(
      { gap: 6, align: 'center', pad: 4, bg: theme.raised, radius: 10 },
      new Button({
        kind: 'icon',
        icon: Play,
        onClick: () => app.togglePause(),
        tip: 'Play  (Space)',
      }).when(() => !app.running),
      new Button({ kind: 'icon', icon: Pause, onClick: () => app.togglePause(), tip: 'Pause  (Space)' }).when(() => app.running),
      seg(
        SPEEDS.map((s, i) => ({ value: s, label: `${s}×`, tip: `Simulation speed ${s}×  (${i + 1})` })),
        () => (app.running ? app.speed : -1),
        (s) => app.setSpeed(s),
      ),
      col(
        { gap: 2, align: 'center', pad: [0, 6, 0, 6] },
        new Label(() => clock(sim().t), { mono: true, weight: 600, size: 13 }),
        new Progress(() => app.experiment?.progress ?? 0, 70).when(() => app.experiment !== null),
      ).hint('Simulated time since traffic started'),
      new Button({ kind: 'icon', icon: RotateCcw, onClick: () => app.restart(), tip: 'Restart traffic\nClears the roads; same seed gives the same arrivals.' }),
    ),
    new Spacer().flex(),
    kpi(Car, () => int(sim().vehicles.length), 'Vehicles in the network'),
    kpi(Activity, () => `${int(sim().metrics.recentThroughput(sim().t))}/h`, 'Throughput\nTrips completed per hour (last 5 minutes)'),
    kpi(Timer, () => secs(sim().metrics.recentDelay(sim().t)), 'Mean delay\nExtra time per trip versus driving the route at the limit, including waiting to enter (last 5 minutes)'),
    kpi(Gauge, () => `${Math.round(sim().meanSpeed() * 3.6)} km/h`, 'Mean speed of vehicles in the network'),
    kpi(TriangleAlert, () => int(sim().metrics.incidents), 'Incidents\nSimulation anomalies (vehicles overlapping, stranded). Should stay at zero — the analytics panel lists them.', () => theme.bad).when(
      () => sim().metrics.incidents > 0,
    ),
    new Divider(true),
    new Button({ kind: 'icon', icon: ChartLine, onClick: () => ((app.analyticsOpen = !app.analyticsOpen), app.hud.invalidate()), active: () => app.analyticsOpen, tip: 'Analytics & experiments' }),
    new Button({ kind: 'icon', icon: LayoutGrid, onClick: () => app.toggleModal('presets'), active: () => app.modal === 'presets', tip: 'Presets  (P)' }),
    new Button({ kind: 'icon', icon: Settings, onClick: () => app.toggleModal('settings'), active: () => app.modal === 'settings', tip: 'Settings' }),
    new Button({ kind: 'icon', icon: CircleQuestionMark, onClick: () => app.toggleModal('help'), active: () => app.modal === 'help', tip: 'Controls & shortcuts  (H)' }),
  );
  return new Panel(root, () => [0, 0], { live: 250 });
}

interface ToolDef {
  id: ToolId;
  icon: IconNode;
  label: string;
  key: string;
  tip: string;
}

const TOOLS: ToolDef[] = [
  { id: 'select', icon: MousePointer2, label: 'Select', key: 'V', tip: 'Inspect and move. Click anything to inspect it; drag junctions to move them; drag a road to bend it.' },
  { id: 'road', icon: Route, label: 'Roads', key: 'R', tip: 'Draw roads. Crossing another road creates a junction.' },
  { id: 'bulldoze', icon: Construction, label: 'Bulldoze', key: 'B', tip: 'Remove roads and junctions.' },
  { id: 'junction', icon: TrafficCone, label: 'Junctions', key: 'J', tip: 'Swap junction types: signals, roundabout, all-way stop, priority.' },
  { id: 'traffic', icon: Car, label: 'Traffic', key: 'T', tip: 'Demand: how much traffic enters, where it goes, trucks.' },
  { id: 'map', icon: MapIcon, label: 'Map', key: 'M', tip: 'Place a map screenshot under the network to trace real roads.' },
];

export function toolbar(app: App): Panel {
  const root = row(
    { ...PANEL, pad: 6, gap: 4 },
    ...TOOLS.map(
      (t) =>
        new Button({
          kind: 'tool',
          icon: t.icon,
          label: t.label,
          onClick: () => app.setTool(t.id),
          active: () => app.tool === t.id,
          tip: `${t.label}  (${t.key})\n${t.tip}`,
        }),
    ),
  );
  return new Panel(root, (sw, sh, w, h) => [(sw - w) / 2, sh - h - 14]);
}

function hint(text: string | (() => string)): Widget {
  return new Para(text, 520, { size: 12, color: theme.dim });
}

/** A one-line remark beside controls: sized to its text, where a hint reserves its full wrap width. */
function note(text: string | (() => string)): Widget {
  return new Label(text, { color: theme.dim, weight: 400 });
}

function roadFlyout(app: App): Widget {
  const t = () => app.roadTool;
  const set = (patch: Partial<App['roadTool']>) => {
    Object.assign(app.roadTool, patch);
    app.hud.invalidate();
  };
  return col(
    { gap: 10 },
    row(
      { gap: 14, align: 'center' },
      col({ gap: 4 }, new Label('LANES EACH WAY', { size: 10, weight: 700, color: theme.faint }), seg([1, 2, 3].map((n) => ({ value: n, label: String(n) })), () => t().lanes, (v) => set({ lanes: v }))),
      col(
        { gap: 4 },
        new Label('DIRECTION', { size: 10, weight: 700, color: theme.faint }),
        seg(
          [
            { value: false, label: 'Two-way' },
            { value: true, label: 'One-way' },
          ],
          () => t().oneWay,
          (v) => set({ oneWay: v }),
        ),
      ),
      col(
        { gap: 4 },
        new Label('SPEED LIMIT', { size: 10, weight: 700, color: theme.faint }),
        seg([30, 40, 50, 60, 80, 100].map((v) => ({ value: v, label: String(v) })), () => t().speed, (v) => set({ speed: v })),
      ),
      col(
        { gap: 4 },
        new Label('SHAPE', { size: 10, weight: 700, color: theme.faint }),
        seg(
          [
            { value: false, label: 'Straight', icon: Ruler },
            { value: true, label: 'Curved', icon: Spline },
          ],
          () => t().curved,
          (v) => set({ curved: v }),
        ),
      ),
      col(
        { gap: 2 },
        new Toggle('Grid', () => t().gridSnap, (v) => set({ gridSnap: v })),
        new Toggle('15° snap', () => t().angleSnap, (v) => set({ angleSnap: v })),
      ),
    ),
    row(
      { gap: 12, align: 'center' },
      hint(() =>
        app.editor.roadStart === null
          ? 'Click to start a road — on empty ground, a junction, or anywhere along a road.'
          : t().curved && app.editor.roadControl === null
            ? 'Click to place the bend, then the end. Right-click or Esc to stop.'
            : 'Click to place the end; drawing continues from there. Right-click or Esc to stop. Hold Shift to snap angles.',
      ),
      new Label(() => {
        const l = app.editor.draftLength();
        return l === null ? '' : `${Math.round(l)} m`;
      }, { weight: 700, color: theme.accent }),
    ),
  );
}

function junctionFlyout(app: App): Widget {
  return col(
    { gap: 10 },
    seg(
      [
        { value: 'signal' as const, label: 'Signals', icon: TrafficCone },
        { value: 'roundabout' as const, label: 'Roundabout', icon: RefreshCw },
        { value: 'stop' as const, label: 'All-way stop', icon: Octagon },
        { value: 'priority' as const, label: 'Priority', icon: Signpost },
      ],
      () => app.junctionType,
      (v) => {
        app.junctionType = v;
        app.hud.invalidate();
      },
    ),
    hint('Click a junction to convert it, then fine-tune timings and rules in the inspector. Undo (Ctrl+Z) restores the previous layout.'),
  );
}

function trafficFlyout(app: App): Widget {
  const tr = () => app.design.traffic;
  return col(
    { gap: 6 },
    row(
      { gap: 18 },
      new Slider({
        label: 'Demand',
        min: 0,
        max: 3,
        step: 0.05,
        get: () => tr().demandScale,
        set: (v) => app.editDesign((d) => (d.traffic.demandScale = v), 'demand'),
        format: (v) => `×${v.toFixed(2)}`,
        width: 230,
        tip: 'Multiplies every entry’s inflow. Push it up to find where the network breaks down.',
      }),
      new Slider({
        label: 'Trucks',
        min: 0,
        max: 0.4,
        step: 0.01,
        get: () => tr().truckShare,
        set: (v) => app.editDesign((d) => (d.traffic.truckShare = v), 'trucks'),
        format: (v) => `${Math.round(v * 100)}%`,
        width: 200,
        tip: 'Share of new vehicles that are trucks: longer, slower to accelerate.',
      }),
    ),
    hint('Click an entry (the blue disc at a road end, or its flow tag) to set how much traffic it sends and where to. Click a car to see what it is doing.'),
  );
}

function mapFlyout(app: App): Widget {
  const bg = () => app.project.background;
  const ed = app.editor;
  const setBg = (patch: Partial<NonNullable<App['project']['background']>>) => {
    const b = bg();
    if (b === null) throw new Error('No background to edit');
    app.setBackground({ ...b, ...patch });
  };
  return new Dyn(
    () => `${bg() === null}|${ed.calibration === null}`,
    () => {
      if (bg() === null) {
        return col(
          { gap: 10 },
          row({ gap: 10, align: 'center' }, new Button({ kind: 'primary', icon: ImagePlus, label: 'Load map image', onClick: () => app.importImage() }), note('…or drop / paste a Google Maps screenshot onto the view.')),
          hint('Then calibrate its scale and trace the roads on top with the Roads tool.'),
        );
      }
      if (ed.calibration !== null) {
        const c = ed.calibration;
        const measured = () => (c.a !== null && c.b !== null ? c.a.distanceTo(c.b) : null);
        return col(
          { gap: 8 },
          hint(() =>
            c.a === null ? 'Click the first point of a known distance — the ends of the map’s scale bar work well.' : c.b === null ? 'Click the second point.' : `Measured ${measured()!.toFixed(1)} m at the current scale. Set the real distance and apply.`,
          ),
          row(
            { gap: 10, align: 'center' },
            stepper('Real distance', () => c.meters, (v) => ((c.meters = v), app.hud.invalidate()), 5, 5, 2000, (v) => `${v} m`, Minus, Plus),
            new Button({
              kind: 'primary',
              label: 'Apply scale',
              disabled: () => measured() === null,
              onClick: () => {
                const m = measured();
                const b = bg();
                if (m === null || b === null) throw new Error('Calibration incomplete');
                setBg({ metersPerPixel: (b.metersPerPixel * c.meters) / m });
                ed.calibration = null;
                app.toast('Map scale calibrated', 'success');
              },
            }),
            new Button({ kind: 'ghost', label: 'Cancel', onClick: () => ((ed.calibration = null), app.hud.invalidate()) }),
          ),
        );
      }
      return col(
        { gap: 6 },
        row(
          { gap: 18 },
          new Slider({ label: 'Opacity', min: 0.1, max: 1, step: 0.05, get: () => bg()!.opacity, set: (v) => setBg({ opacity: v }), format: (v) => `${Math.round(v * 100)}%`, width: 160 }),
          new Slider({ label: 'Scale', min: 0.05, max: 3, step: 0.01, get: () => bg()!.metersPerPixel, set: (v) => setBg({ metersPerPixel: v }), format: (v) => `${v.toFixed(2)} m/px`, width: 180 }),
          new Slider({ label: 'Rotation', min: -180, max: 180, step: 1, get: () => (bg()!.rotation * 180) / Math.PI, set: (v) => setBg({ rotation: (v * Math.PI) / 180 }), format: (v) => `${Math.round(v)}°`, width: 160 }),
        ),
        row(
          { gap: 8, align: 'center' },
          new Button({ icon: Ruler, label: 'Calibrate', onClick: () => ((ed.calibration = { a: null, b: null, meters: 100 }), app.hud.invalidate()), tip: 'Measure a known distance on the image to set its scale.' }),
          new Button({ icon: Lock, label: 'Lock', onClick: () => setBg({ locked: true }), tip: 'Stop the image moving when you drag' }).when(() => !bg()!.locked),
          new Button({ icon: LockOpen, label: 'Unlock', onClick: () => setBg({ locked: false }), active: () => true }).when(() => bg()!.locked),
          new Button({ icon: ImagePlus, label: 'Replace', onClick: () => app.importImage() }),
          new Button({ kind: 'danger', icon: Trash, label: 'Remove', onClick: () => app.setBackground(null) }),
          note(() => (bg()!.locked ? 'Image locked.' : 'Drag the image to move it.')),
        ),
      );
    },
  );
}

export function flyout(app: App): Panel {
  const root = col(
    { ...PANEL, pad: [12, 16, 12, 16], gap: 6 },
    new Dyn(
      () => app.tool,
      () => {
        switch (app.tool) {
          case 'select':
            return hint('Click a junction, road or car to inspect it · drag a junction to move it · drag a road to bend it · H for all controls');
          case 'road':
            return roadFlyout(app);
          case 'bulldoze':
            return hint('Click a road or a junction to remove it. Undo with Ctrl+Z.');
          case 'junction':
            return junctionFlyout(app);
          case 'traffic':
            return trafficFlyout(app);
          case 'map':
            return mapFlyout(app);
        }
      },
    ),
  );
  return new Panel(root, (sw, sh, w, h) => [(sw - w) / 2, sh - h - 92], { visible: () => app.modal === null, live: 500 });
}

export function experimentButton(app: App): Widget {
  return new Button({
    kind: 'primary',
    icon: FlaskConical,
    label: () => (app.experiment === null ? 'Run experiment' : `Running… ${Math.round(app.experiment.progress * 100)}%`),
    disabled: () => app.experiment !== null || app.design.roads.length === 0,
    onClick: () => app.runExperiment(),
    tip: 'Restarts traffic with the same seed (identical arrivals), warms up for 5 simulated minutes, then measures. Change one thing and run again to compare.',
  });
}
