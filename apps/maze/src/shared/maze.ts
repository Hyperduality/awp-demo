/** Maze geometry and payloads, shared by the world, the controllers, and the view. Tiles are 1 m. */

export const PORTS = { world: 8711, worldInspector: 8811, agentInspector: 8911, ui: 5171 } as const;

export const RADIUS = 0.22;
export const CORES = 5;
export const RAYS = 32;
export const RANGE_MAX = 8;
export const FOV = (110 * Math.PI) / 180;

export interface Layout {
  /** Rows of tiles: "#" wall, "." floor, "X" exit door. */
  grid: string[];
  width: number;
  height: number;
  start: [number, number];
  exit: [number, number];
  cores: [number, number][];
}

export interface PosePayload {
  x_m: number;
  y_m: number;
  yaw_rad: number;
  v_mps: number;
}

/** Where a sensor frame was captured from. */
export interface SensorOrigin {
  x_m: number;
  y_m: number;
  yaw_rad: number;
}

export interface RangesPayload {
  origin: SensorOrigin;
  /** Bearings relative to the heading, positive to the right, radians. */
  bearings_rad: number[];
  ranges_m: number[];
  max_m: number;
}

export interface VisionPayload {
  origin: SensorOrigin;
  cores: { bearing_rad: number; range_m: number }[];
  exit: { bearing_rad: number; range_m: number; open: boolean } | null;
}

export interface ProgressPayload {
  cores_collected: number;
  cores_total: number;
  exit_open: boolean;
  escaped: boolean;
  elapsed_s: number;
}

export interface MazeView {
  pose: { x: number; y: number; yaw: number; v: number };
  cores: [number, number][];
  collected: number;
  exitOpen: boolean;
  escaped: boolean;
  elapsed: number;
  safeStopped: boolean;
}

export function isWall(grid: string[], x: number, y: number): boolean {
  const row = grid[Math.floor(y)];
  if (!row) return true;
  const c = row[Math.floor(x)];
  return c === undefined || c === "#" || c === "X";
}

/** Distance along a ray to the first wall (DDA over tiles). */
export function castRay(
  grid: string[],
  x: number,
  y: number,
  angle: number,
  max: number,
): { dist: number; tile: string; side: 0 | 1 } {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let mx = Math.floor(x);
  let my = Math.floor(y);
  const ddx = Math.abs(1 / (dx || 1e-9));
  const ddy = Math.abs(1 / (dy || 1e-9));
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  let tx = dx < 0 ? (x - mx) * ddx : (mx + 1 - x) * ddx;
  let ty = dy < 0 ? (y - my) * ddy : (my + 1 - y) * ddy;
  let side: 0 | 1 = 0;
  for (let i = 0; i < 64; i++) {
    if (tx < ty) {
      tx += ddx;
      mx += sx;
      side = 0;
    } else {
      ty += ddy;
      my += sy;
      side = 1;
    }
    const tile = grid[my]?.[mx] ?? "#";
    if (tile === "#" || tile === "X") {
      const dist = side === 0 ? tx - ddx : ty - ddy;
      return { dist: Math.min(dist, max), tile, side };
    }
    if ((side === 0 ? tx - ddx : ty - ddy) > max) break;
  }
  return { dist: max, tile: ".", side };
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
