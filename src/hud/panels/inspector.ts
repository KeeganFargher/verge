import type { IconNode } from 'lucide';
import {
  ArrowRightLeft,
  Car,
  CircleDot,
  Crosshair,
  Map as MapIcon,
  Minus,
  Octagon,
  Plus,
  RefreshCw,
  Repeat,
  Route,
  Signpost,
  Spline,
  TrafficCone,
  Trash,
  Truck,
  X,
} from 'lucide';
import { levelOfService, type App } from '../../app/App';
import { compassName } from '../../sim/phases';
import { defaultControl, findNode, findRoad, nodeDegree, type ControlType, type DesignNode, type SignalPlan } from '../../sim/design';
import type { Gateway, Junction } from '../../sim/network';
import type { Vehicle, WaitReason } from '../../sim/vehicle';
import { reverseRoad, updateRoad } from '../../editor/ops';
import { int, pct, secs } from '../format';
import { Panel } from '../Hud';
import { losColor, theme } from '../theme';
import { Badge, Button, Divider, Dyn, Icon, Label, Para, Slider, Toggle, col, row, seg, stepper, type Widget } from '../ui';
import { Vector2 } from 'three';

const W = 300;

function section(title: string): Widget {
  return new Label(title, { size: 10, weight: 700, color: theme.faint, upper: true });
}

function stat(label: string, value: () => string): Widget {
  return row({ gap: 8, align: 'center', width: W }, new Label(label, { color: theme.dim }).flex(), new Label(value, { weight: 600 }));
}

function header(app: App, icon: IconNode, title: () => string, subtitle: () => string): Widget {
  return row(
    { gap: 10, align: 'center', width: W },
    new Icon(icon, 20, theme.accent),
    col({ gap: 1 }, new Label(title, { size: 14, weight: 700, maxWidth: 220 }), new Label(subtitle, { size: 11, color: theme.dim, maxWidth: 220 })).flex(),
    new Button({ kind: 'icon', icon: X, onClick: () => app.select(null), tip: 'Close  (Esc)' }),
  );
}

const CONTROL_ICONS: Record<ControlType, IconNode> = { signal: TrafficCone, roundabout: RefreshCw, stop: Octagon, priority: Signpost };
const CONTROL_NAMES: Record<ControlType, string> = { signal: 'Signals', roundabout: 'Roundabout', stop: 'All-way stop', priority: 'Priority' };

function nodeOf(app: App, id: number): DesignNode {
  return findNode(app.design, id);
}

function junctions(app: App, id: number): Junction[] {
  const js = app.net.junctionsByNode.get(id);
  if (js === undefined) throw new Error(`Node ${id} has no compiled junction`);
  return js;
}

/** Where a point lies relative to the middle of the network, as a compass name. */
function bearing(app: App, x: number, y: number): string {
  const ns = app.design.nodes;
  const cx = ns.reduce((s, n) => s + n.x, 0) / ns.length;
  const cy = ns.reduce((s, n) => s + n.y, 0) / ns.length;
  const d = new Vector2(x - cx, y - cy);
  return d.length() < 1 ? 'centre' : compassName(d.normalize());
}

function junctionStats(app: App, id: number): Widget {
  const agg = () => {
    const js = junctions(app, id);
    const passed = js.reduce((s, j) => s + j.stats.passed, 0);
    const delay = passed === 0 ? 0 : js.reduce((s, j) => s + j.stats.delaySum, 0) / passed;
    return { passed, delay };
  };
  const signalised = () => nodeOf(app, id).control.type === 'signal';
  return col(
    { gap: 6 },
    section('Performance'),
    row(
      { gap: 10, align: 'center', width: W },
      new Badge(
        () => (agg().passed === 0 ? '–' : levelOfService(agg().delay, signalised())),
        () => (agg().passed === 0 ? theme.faint : losColor(levelOfService(agg().delay, signalised()))),
      ).hint('Level of service from mean delay per vehicle (HCM grades A–F; signals are allowed more delay per grade).'),
      new Label(() => (agg().passed === 0 ? 'No vehicles through yet' : `${secs(agg().delay)} mean delay`), { weight: 600 }).flex(),
    ),
    stat('Vehicles through', () => int(agg().passed)),
    stat('Through per hour', () => {
      const span = app.sim.t - app.sim.metrics.windowStart;
      return span < 30 ? '—' : `${int((agg().passed / span) * 3600)}/h`;
    }),
  );
}

function signalSettings(app: App, id: number): Widget {
  const ctl = () => {
    const c = nodeOf(app, id).control;
    if (c.type !== 'signal') throw new Error('Not a signal');
    return c;
  };
  const edit = (key: string, f: (c: ReturnType<typeof ctl>) => void) =>
    app.editNode(
      id,
      (n) => {
        if (n.control.type !== 'signal') throw new Error(`Node ${id} is no longer a signal`);
        f(n.control);
      },
      `sig:${id}:${key}`,
    );
  const runtime = () => {
    const s = junctions(app, id)[0].signal;
    if (s === null) throw new Error('Signal junction without controller');
    return s;
  };
  return new Dyn(
    () => `${ctl().plan}|${ctl().actuated}|${app.netVersion}`,
    () => {
      const phases = runtime().phases;
      const live = row(
        { gap: 8, align: 'center', width: W, pad: [6, 8, 6, 8], bg: theme.raised, radius: 8 },
        new Icon(CircleDot, 14, theme.good),
        new Label(() => {
          const r = runtime();
          const ph = r.phases[r.phase];
          const left = r.remaining();
          const stage = r.stage === 'green' ? 'green' : r.stage === 'amber' ? 'amber' : 'all red';
          return `${ph.label} · ${stage}${left === null ? '' : ` · ${Math.ceil(left)} s`}`;
        }, { weight: 600 }),
      );
      const timing = ctl().actuated
        ? [
            new Slider({ label: 'Min green', min: 3, max: 30, step: 1, get: () => ctl().minGreen, set: (v) => edit('min', (c) => (c.minGreen = v)), format: (v) => `${v} s`, width: W }),
            new Slider({ label: 'Max green', min: 10, max: 120, step: 1, get: () => ctl().maxGreen, set: (v) => edit('max', (c) => (c.maxGreen = v)), format: (v) => `${v} s`, width: W }),
            new Slider({
              label: 'Gap out',
              min: 1,
              max: 8,
              step: 0.5,
              get: () => ctl().gap,
              set: (v) => edit('gap', (c) => (c.gap = v)),
              format: (v) => `${v} s`,
              width: W,
              tip: 'End the green once no car is this close (in time) to the stop line.',
            }),
          ]
        : phases.map(
            (p) =>
              new Slider({
                label: `${p.label} green`,
                min: 5,
                max: 90,
                step: 1,
                get: () => ctl().greens[p.key] ?? ctl().green,
                set: (v) => edit(`g:${p.key}`, (c) => (c.greens[p.key] = v)),
                format: (v) => `${v} s`,
                width: W,
              }),
          );
      return col(
        { gap: 8 },
        section('Signal plan'),
        seg<SignalPlan>(
          [
            { value: 'axis', label: 'Two-phase', tip: 'Opposite approaches run together; turns across traffic filter through gaps.' },
            { value: 'protected', label: 'Protected', tip: 'Each axis gets a turn-only phase first, then straight and kerb-side turns.' },
            { value: 'split', label: 'Split', tip: 'One approach at a time: no conflicts at all, but long waits.' },
          ],
          () => ctl().plan,
          (v) => edit('plan', (c) => (c.plan = v)),
          W,
        ),
        seg(
          [
            { value: false, label: 'Fixed time' },
            { value: true, label: 'Actuated', tip: 'Detectors extend greens while traffic keeps arriving and skip empty phases.' },
          ],
          () => ctl().actuated,
          (v) => edit('act', (c) => (c.actuated = v)),
          W,
        ),
        live,
        ...timing,
        new Slider({ label: 'Amber', min: 2, max: 6, step: 0.5, get: () => ctl().amber, set: (v) => edit('amber', (c) => (c.amber = v)), format: (v) => `${v} s`, width: W }),
        new Slider({ label: 'All red', min: 0, max: 5, step: 0.5, get: () => ctl().allRed, set: (v) => edit('allred', (c) => (c.allRed = v)), format: (v) => `${v} s`, width: W }),
        new Slider({
          label: 'Offset',
          min: 0,
          max: 180,
          step: 1,
          get: () => ctl().offset,
          set: (v) => edit('offset', (c) => (c.offset = v)),
          format: (v) => `${v} s`,
          width: W,
          tip: 'When the first phase starts, in sim seconds. Stagger neighbouring signals to build a green wave.',
        }).when(() => !ctl().actuated),
        stat('Cycle length', () => (ctl().actuated ? 'varies' : `${Math.round(runtime().cycleLength())} s`)),
      );
    },
  );
}

function roundaboutSettings(app: App, id: number): Widget {
  const ctl = () => {
    const c = nodeOf(app, id).control;
    if (c.type !== 'roundabout') throw new Error('Not a roundabout');
    return c;
  };
  const edit = (key: string, f: (c: ReturnType<typeof ctl>) => void) =>
    app.editNode(
      id,
      (n) => {
        if (n.control.type !== 'roundabout') throw new Error(`Node ${id} is no longer a roundabout`);
        f(n.control);
      },
      `rb:${id}:${key}`,
    );
  return col(
    { gap: 8 },
    section('Roundabout'),
    new Slider({ label: 'Radius', min: 12, max: 45, step: 1, get: () => ctl().radius, set: (v) => edit('r', (c) => (c.radius = v)), format: (v) => `${v} m`, width: W, tip: 'Radius of the circulating carriageway (centre line).' }),
    seg(
      [
        { value: 1 as const, label: 'Single lane' },
        { value: 2 as const, label: 'Two lanes' },
      ],
      () => ctl().lanes,
      (v) => edit('lanes', (c) => (c.lanes = v)),
      W,
    ),
    new Slider({
      label: 'Entry gap',
      min: 0.3,
      max: 4,
      step: 0.1,
      get: () => ctl().entryGap,
      set: (v) => edit('gap', (c) => (c.entryGap = v)),
      format: (v) => `${v.toFixed(1)} s`,
      width: W,
      tip: 'Driver caution: spare time wanted before the next circulating car arrives. Lower = more assertive entries, higher capacity.',
    }),
    seg(
      [
        { value: 'circulating' as const, label: 'Yield on entry', tip: 'Modern rule: entering traffic gives way to traffic already on the roundabout.' },
        { value: 'entering' as const, label: 'Priority to entering', tip: 'Old-style rule: circulating traffic gives way to entering traffic. Watch what happens under load.' },
      ],
      () => ctl().priority,
      (v) => edit('prio', (c) => (c.priority = v)),
      W,
    ),
  );
}

function prioritySettings(app: App, id: number): Widget {
  const ctl = () => {
    const c = nodeOf(app, id).control;
    if (c.type !== 'priority') throw new Error('Not a priority junction');
    return c;
  };
  const editPriority = (f: (c: ReturnType<typeof ctl>) => void, key: string) =>
    app.editNode(
      id,
      (n) => {
        if (n.control.type !== 'priority') throw new Error(`Node ${id} is no longer a priority junction`);
        f(n.control);
      },
      `pr:${id}:${key}`,
    );
  const j = () => junctions(app, id)[0];
  const majorText = () => {
    const m = j().majorArms;
    if (m === null) throw new Error('Priority junction without a major road');
    return m.map((a) => compassName(j().arms[a].dir)).join(' – ');
  };
  const cycle = () => {
    const arms = j().arms;
    const pairs: [number, number][] = [];
    for (let a = 0; a < arms.length; a++) for (let b = a + 1; b < arms.length; b++) pairs.push([a, b]);
    const cur = j().majorArms;
    if (cur === null) throw new Error('Priority junction without a major road');
    const i = pairs.findIndex((p) => p[0] === Math.min(...cur) && p[1] === Math.max(...cur));
    const [a, b] = pairs[(i + 1) % pairs.length];
    const ra = arms[a].roadId;
    const rb = arms[b].roadId;
    if (ra === null || rb === null) throw new Error('Priority arms without roads');
    editPriority((c) => (c.major = [ra, rb]), 'major');
  };
  return col(
    { gap: 8 },
    section('Priority'),
    row({ gap: 8, align: 'center', width: W }, new Label('Major road', { color: theme.dim }).flex(), new Label(majorText, { weight: 600 }), new Button({ icon: Repeat, label: 'Change', onClick: cycle, tip: 'Cycle which pair of roads has priority.' })),
    seg(
      [
        { value: 'yield' as const, label: 'Minor roads yield' },
        { value: 'stop' as const, label: 'Minor roads stop' },
      ],
      () => ctl().minor,
      (v) => editPriority((c) => (c.minor = v), 'minor'),
      W,
    ),
  );
}

function junctionInspector(app: App, id: number): Widget {
  const type = () => nodeOf(app, id).control.type;
  const degree = nodeDegree(app.design, id);
  return col(
    { gap: 12 },
    header(app, CONTROL_ICONS[type()], () => `${CONTROL_NAMES[type()]}`, () => `Junction #${id} · ${degree} roads`),
    seg(
      (['signal', 'roundabout', 'stop', 'priority'] as const).map((t) => ({ value: t, icon: CONTROL_ICONS[t], tip: CONTROL_NAMES[t] })),
      type,
      (t) => {
        if (t !== type()) app.editNode(id, (n) => (n.control = defaultControl(t)), `type:${id}`);
      },
      W,
    ),
    new Dyn(
      () => type(),
      () => {
        switch (type()) {
          case 'signal':
            return signalSettings(app, id);
          case 'roundabout':
            return roundaboutSettings(app, id);
          case 'priority':
            return prioritySettings(app, id);
          case 'stop':
            return new Para('Every approach stops; drivers then go in arrival order, crossing movements one at a time.', W);
        }
      },
    ),
    new Divider(),
    junctionStats(app, id),
  );
}

function gatewayInspector(app: App, id: number): Widget {
  const node = () => nodeOf(app, id);
  const gw = (): Gateway => {
    const g = app.net.gatewaysByNode.get(id);
    if (g === undefined) throw new Error(`Node ${id} is not an entry/exit`);
    return g;
  };
  const state = () => {
    const s = app.sim.gateways.find((x) => x.gateway.nodeId === id);
    if (s === undefined) throw new Error(`No arrivals for gateway ${id}`);
    return s;
  };
  const weight = (dest: number) => node().demand.split[String(dest)] ?? 1;
  const total = () => gw().reachable.reduce((s, d) => s + weight(d.nodeId), 0);
  const where = bearing(app, node().x, node().y);
  const canEnter = gw().source !== null;
  return col(
    { gap: 10 },
    header(app, MapIcon, () => (canEnter ? 'Entry & exit' : 'Exit only'), () => `#${id} · ${where} edge`),
    ...(canEnter
      ? [
          new Slider({
            label: 'Inflow',
            min: 0,
            max: 2400,
            step: 25,
            get: () => node().demand.inflow,
            set: (v) => app.editNode(id, (n) => (n.demand.inflow = v), `in:${id}`),
            format: (v) => `${v} veh/h`,
            width: W,
            tip: 'Vehicles per hour arriving here, before the global demand multiplier.',
          }),
          stat('After demand multiplier', () => `${int(node().demand.inflow * app.design.traffic.demandScale)} veh/h`),
          new Divider(),
          section('Where they go'),
          ...gw().reachable.map(
            (d) =>
              new Slider({
                label: `→ #${d.nodeId} (${bearing(app, d.position.x, d.position.y)})`,
                min: 0,
                max: 10,
                step: 0.5,
                get: () => weight(d.nodeId),
                set: (v) => app.editNode(id, (n) => (n.demand.split[String(d.nodeId)] = v), `split:${id}:${d.nodeId}`),
                format: (v) => (total() === 0 ? '0%' : pct(v / total())),
                width: W,
              }),
          ),
          new Divider(),
          stat('Spawned', () => int(state().spawned)),
          stat('Waiting to enter', () => int(state().queue.length)),
        ]
      : [new Para('Every lane here points out of the network, so traffic only leaves here.', W)]),
  );
}

function roadInspector(app: App, id: number): Widget {
  const r = () => findRoad(app.design, id);
  const edit = (patch: Parameters<typeof updateRoad>[2], key: string) => app.commit(updateRoad(app.design, id, patch), undefined, `road:${id}:${key}`);
  const len = () => {
    const c = app.net.roadsById.get(id);
    return c === undefined ? 0 : c.center.length;
  };
  return col(
    { gap: 10 },
    header(app, Route, () => `Road #${id}`, () => `${Math.round(len())} m between junctions · ${r().speed} km/h`),
    stepper('Lanes →', () => r().lanesAB, (v) => edit({ lanesAB: v }, 'ab'), 1, r().lanesBA === 0 ? 1 : 0, 4, (v) => String(v), Minus, Plus),
    stepper('Lanes ←', () => r().lanesBA, (v) => edit({ lanesBA: v }, 'ba'), 1, r().lanesAB === 0 ? 1 : 0, 4, (v) => String(v), Minus, Plus),
    stepper('Speed limit', () => r().speed, (v) => edit({ speed: v }, 'speed'), 10, 20, 130, (v) => `${v} km/h`, Minus, Plus),
    row(
      { gap: 8 },
      new Button({ icon: ArrowRightLeft, label: 'Reverse', onClick: () => app.commit(reverseRoad(app.design, id), 'Reversed road'), tip: 'Swap the two directions (turns a one-way road around).' }),
      new Button({ icon: Spline, label: 'Straighten', onClick: () => edit({ curve: null }, 'curve'), disabled: () => r().curve === null }),
      new Button({ kind: 'danger', icon: Trash, label: 'Delete', onClick: () => app.deleteSelection() }),
    ),
    new Para('Tip: in the Select tool, drag the middle of a road to bend it.', W),
  );
}

const WAIT_TEXT: Record<WaitReason, string> = {
  'red-light': 'Waiting at a red light',
  'amber-light': 'Stopping for amber',
  'stop-sign': 'Coming to a full stop',
  'stop-queue': 'Waiting its turn at the stop',
  'give-way': 'Giving way to traffic with priority',
  conflict: 'Waiting for crossing traffic to clear',
  'exit-blocked': 'Exit blocked — keeping the junction clear',
  'lane-end': 'Needs to change lanes',
};

function doing(v: Vehicle): string {
  if (v.wait !== null) return WAIT_TEXT[v.wait];
  if (v.v < 0.5) return v.heldBy !== null ? 'Queued behind traffic' : 'Pulling away';
  if (v.lateral !== 0) return 'Changing lanes';
  return v.acc < -1 ? 'Slowing down' : 'Driving';
}

function vehicleInspector(app: App, veh: Vehicle): Widget {
  const driving = () => app.sim.vehicles.includes(veh);
  return new Dyn(driving, () => {
    if (!driving()) {
      return col({ gap: 10 }, header(app, Car, () => `Vehicle #${veh.id}`, () => 'Reached its destination'), new Para('This vehicle has left the network.', W));
    }
    return col(
      { gap: 8 },
      header(app, veh.kind === 'truck' ? Truck : Car, () => `${veh.kind === 'truck' ? 'Truck' : 'Car'} #${veh.id}`, () => `Heading for exit #${veh.dest.nodeId}`),
      row({ gap: 8, align: 'center', width: W, pad: [6, 8, 6, 8], bg: theme.raised, radius: 8 }, new Icon(CircleDot, 14, theme.accent), new Label(() => doing(veh), { weight: 600 })),
      stat('Speed', () => `${Math.round(veh.v * 3.6)} km/h`),
      stat('Trip time', () => secs(app.sim.t - veh.arrivalTime)),
      stat('Stops', () => int(veh.stops)),
      stat('Route', () => `${veh.routeIdx + 1} of ${veh.route.length} roads`),
      stat('Length', () => `${veh.length.toFixed(1)} m`),
      new Toggle('Follow with camera', () => app.follow === veh, (on) => ((app.follow = on ? veh : null), app.hud.invalidate())),
      row({ gap: 8 }, new Button({ icon: Crosshair, label: 'Centre view', onClick: () => app.world.rig.setGoal(veh.x, veh.y, Math.min(app.world.rig.distance, 120)) })),
    );
  });
}

export function inspector(app: App): Panel {
  const root = col(
    { bg: theme.panel, radius: 14, border: theme.panelBorder, shadow: true, pad: 14, gap: 10 },
    new Dyn(
      () => {
        const s = app.selection;
        if (s === null) return 'none';
        if (s.kind === 'node') return `n${s.id}:${nodeDegree(app.design, s.id)}:${app.netVersion}`;
        if (s.kind === 'road') return `r${s.id}:${app.netVersion}`;
        return s.vehicle;
      },
      () => {
        const s = app.selection;
        if (s === null) return new Label('');
        switch (s.kind) {
          case 'vehicle':
            return vehicleInspector(app, s.vehicle);
          case 'road':
            return roadInspector(app, s.id);
          case 'node': {
            const d = nodeDegree(app.design, s.id);
            if (d === 1) return gatewayInspector(app, s.id);
            if (d === 2) {
              return col(
                { gap: 10 },
                header(app, Route, () => 'Bend', () => `Node #${s.id} · joins two roads`),
                new Para('Two roads meet here, so there is nothing to control. Drag it to reshape the road, or connect a third road to make a junction.', W),
                new Button({ kind: 'danger', icon: Trash, label: 'Delete with its roads', onClick: () => app.deleteSelection() }),
              );
            }
            return junctionInspector(app, s.id);
          }
        }
      },
    ),
  );
  return new Panel(root, (sw, _sh, w) => [sw - w - 14, 64], { visible: () => app.selection !== null && app.modal === null, live: 300 });
}
