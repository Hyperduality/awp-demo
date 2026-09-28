import { type ActionRun, mulberry32, type Sim } from "@awp-demo/world";
import {
  CORES,
  castRay,
  FOV,
  isWall,
  type Layout,
  type MazeView,
  RADIUS,
  RANGE_MAX,
  RAYS,
  wrapAngle,
} from "../shared/maze.ts";

const SIZES: Record<string, number> = { default: 8, large: 11 };
const WALK_MPS = 2.2;
const TURN_RADPS = 3.2;
const MAX_MPS = 3;
const MAX_RADPS = 4;
const ACCEL = 8;

/** A perfect maze from a recursive backtracker, with a few extra openings so there are loops. */
export function generate(seed: number, cells: number): Layout {
  const rand = mulberry32(seed);
  const size = cells * 2 + 1;
  const g: string[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => "#"));
  const stack: [number, number][] = [[0, 0]];
  const seen = new Set(["0,0"]);
  g[1]![1] = ".";
  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1]!;
    const next = (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const
    )
      .map(([dx, dy]) => [cx + dx, cy + dy] as [number, number])
      .filter(([x, y]) => x >= 0 && y >= 0 && x < cells && y < cells && !seen.has(`${x},${y}`));
    if (next.length === 0) {
      stack.pop();
      continue;
    }
    const [nx, ny] = next[Math.floor(rand() * next.length)]!;
    seen.add(`${nx},${ny}`);
    g[ny * 2 + 1]![nx * 2 + 1] = ".";
    g[cy + ny + 1]![cx + nx + 1] = ".";
    stack.push([nx, ny]);
  }
  for (let i = 0; i < cells; i++) {
    const x = 1 + Math.floor(rand() * (size - 2));
    const y = 1 + Math.floor(rand() * (size - 2));
    const horizontal = g[y]![x - 1] === "." && g[y]![x + 1] === ".";
    const vertical = g[y - 1]?.[x] === "." && g[y + 1]?.[x] === ".";
    if (g[y]![x] === "#" && (horizontal || vertical) && !(horizontal && vertical)) g[y]![x] = ".";
  }
  const exit: [number, number] = [size - 1, size - 2];
  g[exit[1]]![exit[0]] = "X";
  // Cores in dead ends far from the start, then anywhere far.
  const floors: [number, number][] = [];
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) {
      if (g[y]![x] !== ".") continue;
      if (x % 2 === 1 && y % 2 === 1) floors.push([x, y]);
    }
  const deadEnd = ([x, y]: [number, number]) =>
    [g[y]![x + 1], g[y]![x - 1], g[y + 1]![x], g[y - 1]![x]].filter((t) => t === ".").length === 1;
  const far = floors.filter(([x, y]) => x + y > 4);
  const pool = [...far.filter(deadEnd), ...far.filter((p) => !deadEnd(p))];
  const cores: [number, number][] = [];
  for (const p of pool) {
    if (cores.length >= CORES) break;
    if (cores.every(([x, y]) => Math.abs(x - p[0]) + Math.abs(y - p[1]) >= 4) && rand() < 0.8) cores.push(p);
  }
  for (const p of pool) if (cores.length < CORES && !cores.includes(p)) cores.push(p);
  return { grid: g.map((r) => r.join("")), width: size, height: size, start: [1, 1], exit, cores };
}

export class MazeSim implements Sim<MazeView> {
  readonly layout: Layout;
  private x: number;
  private y: number;
  private yaw = 0;
  private v = 0;
  private cmd = { forward: 0, strafe: 0, turn: 0 };
  private vel = { forward: 0, strafe: 0, turn: 0 };
  private remaining: [number, number][];
  private collected = 0;
  private escaped = false;
  private elapsed = 0;
  private stopped = false;

  constructor(seed: number, initialState: string) {
    this.layout = generate(seed, SIZES[initialState] ?? SIZES.default!);
    this.x = this.layout.start[0] + 0.5;
    this.y = this.layout.start[1] + 0.5;
    this.remaining = this.layout.cores.map((c) => [...c] as [number, number]);
    // Face down the open corridor, not into a wall.
    const [sx, sy] = this.layout.start;
    this.yaw = this.layout.grid[sy]![sx + 1] === "." ? 0 : Math.PI / 2;
  }

  private get exitOpen(): boolean {
    return this.remaining.length === 0;
  }

  step(dtMs: number): void {
    const dt = dtMs / 1000;
    if (!this.escaped) this.elapsed += dt;
    // Accelerate toward the commanded linear velocities, then move with wall sliding. Turn rate
    // takes effect at once, so mouse look has no lag or overshoot.
    const approach = (cur: number, want: number, rate: number) =>
      cur + Math.max(-rate * dt, Math.min(rate * dt, want - cur));
    this.vel.forward = approach(this.vel.forward, this.cmd.forward, ACCEL);
    this.vel.strafe = approach(this.vel.strafe, this.cmd.strafe, ACCEL);
    this.vel.turn = this.cmd.turn;
    this.yaw = wrapAngle(this.yaw + this.vel.turn * dt);
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const dx = (this.vel.forward * c - this.vel.strafe * s) * dt;
    const dy = (this.vel.forward * s + this.vel.strafe * c) * dt;
    const before = [this.x, this.y];
    if (!this.blocked(this.x + dx, this.y)) this.x += dx;
    if (!this.blocked(this.x, this.y + dy)) this.y += dy;
    this.v = Math.hypot(this.x - before[0]!, this.y - before[1]!) / Math.max(dt, 1e-6);
    for (const core of [...this.remaining]) {
      if (Math.hypot(core[0] + 0.5 - this.x, core[1] + 0.5 - this.y) < 0.45) {
        this.remaining = this.remaining.filter((k) => k !== core);
        this.collected += 1;
      }
    }
  }

  private blocked(x: number, y: number): boolean {
    const r = RADIUS;
    for (const [ox, oy] of [
      [-r, -r],
      [r, -r],
      [-r, r],
      [r, r],
    ] as const) {
      if (isWall(this.layout.grid, x + ox, y + oy)) return true;
    }
    return false;
  }

  private nearExit(): boolean {
    const [ex, ey] = this.layout.exit;
    return Math.hypot(ex + 0.5 - this.x, ey + 0.5 - this.y) < 1.4;
  }

  start(_e: string, type: string, params: Record<string, unknown>): ActionRun {
    this.stopped = false;
    const halt = () => {
      this.cmd = { forward: 0, strafe: 0, turn: 0 };
    };
    switch (type) {
      case "teleop":
        halt();
        return {
          update: () => ({}),
          command: (p) => {
            const d = p as { forward_mps?: number; strafe_mps?: number; turn_radps?: number };
            const want = { forward: d.forward_mps ?? 0, strafe: d.strafe_mps ?? 0, turn: d.turn_radps ?? 0 };
            // The envelope rejects setpoints beyond its limits (AWP-CMD-006); the last good one holds.
            if (Math.hypot(want.forward, want.strafe) > MAX_MPS || Math.abs(want.turn) > MAX_RADPS)
              return { rejected: true };
            this.cmd = want;
            return {};
          },
          abort: () => {
            halt();
            return 120;
          },
        };
      case "move": {
        const distance = params.distance_m as number;
        const sign = Math.sign(distance);
        const total = Math.abs(distance);
        const from = [this.x, this.y];
        let elapsed = 0;
        let stuck = 0;
        this.cmd = { forward: sign * WALK_MPS, strafe: 0, turn: 0 };
        return {
          update: (dtMs) => {
            const done = Math.hypot(this.x - from[0]!, this.y - from[1]!);
            const left = total - done;
            if (left <= 0.02) {
              halt();
              return { done: true };
            }
            // Slow down for the last stretch so the stop lands on target.
            this.cmd.forward = sign * Math.max(0.25, Math.min(WALK_MPS, left * 3));
            elapsed += dtMs;
            stuck = elapsed > 300 && this.v < 0.05 ? stuck + dtMs : 0;
            if (stuck > 250) {
              halt();
              return { failed: "world_error", detail: `blocked by a wall after ${done.toFixed(2)} m` };
            }
            return { progress: done / total };
          },
          abort: () => {
            halt();
            return 150;
          },
        };
      }
      case "turn": {
        const angle = params.angle_rad as number;
        const total = Math.abs(angle);
        let turned = 0;
        let last = this.yaw;
        return {
          update: () => {
            turned += wrapAngle(this.yaw - last) * Math.sign(angle || 1);
            last = this.yaw;
            const left = total - turned;
            if (left < 0.01) {
              halt();
              return { done: true };
            }
            this.cmd = {
              forward: 0,
              strafe: 0,
              turn: Math.sign(angle) * Math.max(0.4, Math.min(TURN_RADPS, left * 5)),
            };
            return { progress: total > 0 ? turned / total : 1 };
          },
          abort: () => {
            halt();
            return 100;
          },
        };
      }
      case "stop":
        return {
          update: () => {
            halt();
            return { done: true };
          },
        };
      default:
        // interact: next to an open exit, escape.
        return {
          update: () => {
            if (!this.nearExit())
              return {
                failed: "world_error",
                detail: "nothing to interact with here; interact works next to the exit door",
              };
            if (!this.exitOpen)
              return { failed: "world_error", detail: `the exit is locked; ${this.remaining.length} cores remain` };
            this.escaped = true;
            return { done: true };
          },
        };
    }
  }

  safeStop(): void {
    this.cmd = { forward: 0, strafe: 0, turn: 0 };
    this.vel = { forward: 0, strafe: 0, turn: 0 };
    this.stopped = true;
  }

  observe(channel: string): unknown {
    switch (channel) {
      case "pose":
        return { x_m: r3(this.x), y_m: r3(this.y), yaw_rad: r3(this.yaw), v_mps: r3(this.v) };
      case "ranges": {
        const bearings: number[] = [];
        const ranges: number[] = [];
        for (let i = 0; i < RAYS; i++) {
          const b = wrapAngle((i / RAYS) * Math.PI * 2);
          bearings.push(r3(b));
          ranges.push(r3(castRay(this.layout.grid, this.x, this.y, this.yaw + b, RANGE_MAX).dist));
        }
        return { origin: this.origin(), bearings_rad: bearings, ranges_m: ranges, max_m: RANGE_MAX };
      }
      case "vision":
        return this.vision();
      case "progress":
        return {
          cores_collected: this.collected,
          cores_total: this.layout.cores.length,
          exit_open: this.exitOpen,
          escaped: this.escaped,
          elapsed_s: Math.round(this.elapsed * 10) / 10,
        };
      default:
        throw new Error(`no channel ${channel}`);
    }
  }

  private visible(tx: number, ty: number): { bearing: number; range: number } | undefined {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const range = Math.hypot(dx, dy);
    const bearing = wrapAngle(Math.atan2(dy, dx) - this.yaw);
    if (Math.abs(bearing) > FOV / 2 || range > RANGE_MAX) return undefined;
    const hit = castRay(this.layout.grid, this.x, this.y, this.yaw + bearing, RANGE_MAX);
    return hit.dist + 0.3 >= range ? { bearing, range } : undefined;
  }

  private vision() {
    const cores = this.remaining
      .map(([x, y]) => this.visible(x + 0.5, y + 0.5))
      .filter((v) => v !== undefined)
      .map((v) => ({ bearing_rad: r3(v.bearing), range_m: r3(v.range) }));
    const [ex, ey] = this.layout.exit;
    // The door is seen from inside the maze: aim at its face.
    const face = this.visible(ex + 0.02, ey + 0.5);
    return {
      origin: this.origin(),
      cores,
      exit: face ? { bearing_rad: r3(face.bearing), range_m: r3(face.range), open: this.exitOpen } : null,
    };
  }

  private origin() {
    return { x_m: r3(this.x), y_m: r3(this.y), yaw_rad: r3(this.yaw) };
  }

  view(): MazeView {
    return {
      pose: { x: this.x, y: this.y, yaw: this.yaw, v: this.v },
      cores: this.remaining,
      collected: this.collected,
      exitOpen: this.exitOpen,
      escaped: this.escaped,
      elapsed: this.elapsed,
      safeStopped: this.stopped,
    };
  }

  staticView(): Layout {
    return this.layout;
  }
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
