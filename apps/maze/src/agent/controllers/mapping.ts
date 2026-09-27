import type { ControlContext } from "@awp-demo/agent";
import type {
  SensorOrigin as Origin,
  PosePayload,
  ProgressPayload,
  RangesPayload,
  VisionPayload,
} from "../../shared/maze.ts";

type Tile = [number, number];
const key = ([x, y]: Tile) => `${x},${y}`;
const DIRS: Tile[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * What the agent has learned of the maze from its own sensors: free and wall tiles from the range
 * scan, cores and the exit from vision. The world's layout is never read.
 */
export class TileMap {
  /** Evidence per tile: rays that passed through it against rays that ended on it. */
  private readonly cells = new Map<string, { free: number; wall: number }>();
  readonly cores = new Map<string, Tile>();
  readonly visited = new Set<string>();
  exit: Tile | undefined;

  constructor(ctx: ControlContext<unknown>) {
    // Each frame carries the pose it was captured from, so readings land where they were taken.
    ctx.onFrame<RangesPayload>("ranges", (r) => this.scan(r.origin, r));
    ctx.onFrame<VisionPayload>("vision", (v) => this.see(v.origin, v));
    ctx.onFrame<PosePayload>("pose", (p) => {
      const here = tileOf(p.x_m, p.y_m);
      this.visited.add(key(here));
      // A core is collected on reaching its centre, not merely its tile.
      const core = this.cores.get(key(here));
      if (core && Math.hypot(core[0] + 0.5 - p.x_m, core[1] + 0.5 - p.y_m) < 0.4) this.cores.delete(key(here));
    });
  }

  private mark(t: Tile, kind: "free" | "wall", weight = 1): void {
    const c = this.cells.get(key(t)) ?? { free: 0, wall: 0 };
    c[kind] += weight;
    this.cells.set(key(t), c);
  }

  private state(t: Tile): "free" | "wall" | undefined {
    const c = this.cells.get(key(t));
    if (!c) return undefined;
    return c.wall > c.free ? "wall" : "free";
  }

  private scan(pose: Origin, r: RangesPayload): void {
    this.mark(tileOf(pose.x_m, pose.y_m), "free", 5);
    r.ranges_m.forEach((range, i) => {
      const a = pose.yaw_rad + r.bearings_rad[i]!;
      const c = Math.cos(a);
      const s = Math.sin(a);
      let last = "";
      for (let d = 0.2; d < range - 0.1; d += 0.2) {
        const t = tileOf(pose.x_m + c * d, pose.y_m + s * d);
        if (key(t) !== last) this.mark(t, "free");
        last = key(t);
      }
      if (range < r.max_m - 0.01)
        this.mark(tileOf(pose.x_m + c * (range + 0.05), pose.y_m + s * (range + 0.05)), "wall");
    });
  }

  private see(pose: Origin, v: VisionPayload): void {
    for (const core of v.cores) {
      const a = pose.yaw_rad + core.bearing_rad;
      const t = tileOf(pose.x_m + Math.cos(a) * core.range_m, pose.y_m + Math.sin(a) * core.range_m);
      this.cores.set(key(t), t);
    }
    if (v.exit) {
      const a = pose.yaw_rad + v.exit.bearing_rad;
      this.exit = tileOf(
        pose.x_m + Math.cos(a) * (v.exit.range_m + 0.1),
        pose.y_m + Math.sin(a) * (v.exit.range_m + 0.1),
      );
    }
  }

  free(t: Tile): boolean {
    return this.state(t) === "free";
  }

  /** Breadth-first path over known free tiles, from → to (inclusive), or undefined. */
  path(from: Tile, to: Tile | ((t: Tile) => boolean)): Tile[] | undefined {
    const goal = typeof to === "function" ? to : (t: Tile) => t[0] === to[0] && t[1] === to[1];
    const prev = new Map<string, Tile | null>([[key(from), null]]);
    const queue: Tile[] = [from];
    while (queue.length > 0) {
      const t = queue.shift()!;
      if (goal(t)) {
        const out: Tile[] = [];
        for (let c: Tile | null = t; c; c = prev.get(key(c)) ?? null) out.unshift(c);
        return out;
      }
      for (const [dx, dy] of DIRS) {
        const n: Tile = [t[0] + dx, t[1] + dy];
        if (prev.has(key(n)) || !this.free(n)) continue;
        prev.set(key(n), t);
        queue.push(n);
      }
    }
    return undefined;
  }

  /** The nearest known free tile next to an unknown one. */
  frontier(from: Tile): Tile[] | undefined {
    return this.path(
      from,
      (t) =>
        DIRS.some(([dx, dy]) => !this.cells.has(key([t[0] + dx, t[1] + dy]))) &&
        !(t[0] === from[0] && t[1] === from[1]),
    );
  }

  /** The nearest dead end not yet visited: where an unseen core is most likely to be. */
  unvisitedDeadEnd(from: Tile): Tile[] | undefined {
    return this.path(
      from,
      (t) => !this.visited.has(key(t)) && DIRS.filter(([dx, dy]) => this.free([t[0] + dx, t[1] + dy])).length === 1,
    );
  }

  /** The explored maze as text, rows north to south: # wall, . free, ? unknown, @ you, C core, E exit. */
  ascii(pose: PosePayload | undefined): string {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const k of this.cells.keys()) {
      const [x, y] = k.split(",").map(Number) as Tile;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(x0)) return "(nothing mapped yet)";
    const me = pose ? key(tileOf(pose.x_m, pose.y_m)) : "";
    const rows: string[] = [`   x ${x0}..${x1}`];
    for (let y = y0; y <= y1; y++) {
      let row = "";
      for (let x = x0; x <= x1; x++) {
        const k = key([x, y]);
        row +=
          k === me
            ? "@"
            : this.cores.has(k)
              ? "C"
              : this.exit && key(this.exit) === k
                ? "E"
                : this.state([x, y]) === "wall"
                  ? "#"
                  : this.state([x, y]) === "free"
                    ? "."
                    : "?";
      }
      rows.push(`${String(y).padStart(2)} ${row}`);
    }
    return rows.join("\n");
  }
}

export function tileOf(x: number, y: number): Tile {
  return [Math.floor(x), Math.floor(y)];
}

/** Collapses a tile path into straight runs: [heading, tiles] pairs. */
export function segments(path: Tile[]): { yaw: number; tiles: number; end: Tile }[] {
  const out: { yaw: number; tiles: number; end: Tile }[] = [];
  for (let i = 1; i < path.length; i++) {
    const [px, py] = path[i - 1]!;
    const [x, y] = path[i]!;
    const yaw = Math.atan2(y - py, x - px);
    const last = out[out.length - 1];
    if (last && Math.abs(last.yaw - yaw) < 1e-6) {
      last.tiles += 1;
      last.end = path[i]!;
    } else out.push({ yaw, tiles: 1, end: path[i]! });
  }
  return out;
}

/** Drives a tile path with turn and move actions. Returns false if an action did not complete. */
export async function followPath(ctx: ControlContext<unknown>, path: Tile[], maxSegments = Infinity): Promise<boolean> {
  let n = 0;
  for (const seg of segments(path)) {
    if (n++ >= maxSegments) break;
    const pose = ctx.latest<PosePayload>("pose");
    if (!pose) return false;
    const turn = Math.atan2(Math.sin(seg.yaw - pose.yaw_rad), Math.cos(seg.yaw - pose.yaw_rad));
    if (Math.abs(turn) > 0.03) {
      const t = await ctx.settle(await ctx.submit("turn", { angle_rad: round(turn) }, { preempt: "replace" }));
      if (t.state !== "completed") return false;
    }
    const now = ctx.latest<PosePayload>("pose")!;
    const tx = seg.end[0] + 0.5;
    const ty = seg.end[1] + 0.5;
    const dist = Math.hypot(tx - now.x_m, ty - now.y_m);
    const m = await ctx.settle(await ctx.submit("move", { distance_m: round(dist) }, { preempt: "replace" }));
    if (m.state !== "completed") return false;
  }
  return true;
}

export function progressOf(ctx: ControlContext<unknown>): ProgressPayload | undefined {
  return ctx.latest<ProgressPayload>("progress");
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
