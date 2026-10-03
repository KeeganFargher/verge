import type { App } from '../../app/App';
import { flyout, toolbar, topBar } from './bars';
import { inspector } from './inspector';
import { analytics, modal, toasts } from './side';

/** Adds every HUD panel, back to front. */
export function buildHud(app: App): void {
  const hud = app.hud;
  hud.add(topBar(app));
  hud.add(analytics(app));
  hud.add(inspector(app));
  hud.add(flyout(app));
  hud.add(toolbar(app));
  hud.add(toasts(app));
  hud.add(modal(app));
}
