import type { Design } from '../sim/design';

interface Entry {
  json: string;
  key: string | null;
  at: number;
}

/**
 * Undo/redo over whole-design snapshots. Designs are small, so snapshots are simpler and more
 * robust than recording inverse operations. Rapid edits from one control (a slider being
 * dragged) coalesce into a single step.
 */
export class History {
  private past: Entry[] = [];
  private future: string[] = [];
  private static readonly LIMIT = 150;
  private static readonly COALESCE_MS = 1500;

  /** Remember `before` as the state to return to, unless it continues the last coalescing edit. */
  record(before: Design, key: string | null = null): void {
    const now = performance.now();
    const last = this.past[this.past.length - 1];
    if (key !== null && last !== undefined && last.key === key && now - last.at < History.COALESCE_MS) {
      last.at = now;
    } else {
      this.past.push({ json: JSON.stringify(before), key, at: now });
      if (this.past.length > History.LIMIT) this.past.shift();
    }
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(current: Design): Design | null {
    const e = this.past.pop();
    if (e === undefined) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(e.json) as Design;
  }

  redo(current: Design): Design | null {
    const json = this.future.pop();
    if (json === undefined) return null;
    this.past.push({ json: JSON.stringify(current), key: null, at: 0 });
    return JSON.parse(json) as Design;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
