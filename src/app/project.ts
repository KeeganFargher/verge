import type { Design } from '../sim/design';

/**
 * A map screenshot placed under the network to trace roads from. Kept outside the design so
 * undo snapshots stay small (the image can be megabytes).
 */
export interface Background {
  /** Image as a data URL (so a saved project is a single self-contained file). */
  src: string;
  /** Image size in pixels. */
  width: number;
  height: number;
  /** Plan position (m) of the image centre. */
  x: number;
  y: number;
  metersPerPixel: number;
  /** Rotation in radians (clockwise on screen). */
  rotation: number;
  opacity: number;
  locked: boolean;
}

/** Everything a saved file contains. */
export interface Project {
  design: Design;
  background: Background | null;
}
