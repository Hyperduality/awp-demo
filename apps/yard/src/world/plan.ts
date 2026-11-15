import { BOUNDS } from "../shared/yard.ts";

/** An obstacle's footprint on the ground: a rectangle about (x, y), turned by yaw. */
export interface Footprint {
  x: number;
  y: number;
  hx: number;
  hy: number;
  yaw: number;
}

export type Point = [number, number];

export interface RoutePose {
  x: number;
  y: number;
  /** Heading to arrive with; any heading when undefined. */
  yaw?: number;
}

/** One stretch of a route driven in one direction: the points the chassis origin passes through. */
export interface Leg {
  reverse: boolean;
  points: Point[];
}

const CELL_M = 0.5;
const COLS = Math.round((BOUNDS.max[0] - BOUNDS.min[0]) / CELL_M);
const ROWS = Math.round((BOUNDS.max[1] - BOUNDS.min[1]) / CELL_M);
const HEADINGS = 32;
const STEP_M = 0.8;
const LIMIT = 160_000;

/** Distance from a point to a footprint's edge; 0 inside. */
function distance(f: Footprint, x: number, y: number): number {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  const lx = Math.abs((x - f.x) * c + (y - f.y) * s) - f.hx;
  const ly = Math.abs(-(x - f.x) * s + (y - f.y) * c) - f.hy;
  return Math.hypot(Math.max(lx, 0), Math.max(ly, 0));
}

/**
 * A route for the truck from one pose to another, as the driver of a real one would take it: arcs it
 * can actually turn, forward or in reverse, arriving on the heading asked for.
 *
 * It searches poses (x, y and heading on a grid) by stepping along arcs of the truck's comfortable
 * turning radius, left, right or straight, either way (hybrid A*). Reversing costs more than driving
 * forward and changing direction costs more still, so it backs up only where that saves a long way
 * round. The truck is three discs along its length, the front one over the forks and their load, and
 * every pose keeps all three clear of every footprint. Returns null when there is no way.
 */
export function planRoute(
  from: Required<RoutePose>,
  to: RoutePose,
  obstacles: Footprint[],
  loaded = false,
): Leg[] | null {
  // How far each cell's centre is from the nearest thing, the yard's edge included.
  const clear = new Float32Array(COLS * ROWS);
  for (let i = 0; i < clear.length; i++) {
    const x = BOUNDS.min[0] + ((i % COLS) + 0.5) * CELL_M;
    const y = BOUNDS.min[1] + (Math.floor(i / COLS) + 0.5) * CELL_M;
    let d = Math.min(x - BOUNDS.min[0], BOUNDS.max[0] - x, y - BOUNDS.min[1], BOUNDS.max[1] - y);
    for (const f of obstacles) {
      if (d <= 0) break;
      d = Math.min(d, distance(f, x, y));
    }
    clear[i] = d;
  }
  const clearance = (x: number, y: number) => {
    const cx = Math.floor((x - BOUNDS.min[0]) / CELL_M);
    const cy = Math.floor((y - BOUNDS.min[1]) / CELL_M);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return -1;
    return clear[cy * COLS + cx] as number;
  };
  // Disc centres ahead of the chassis origin, and their radius: tail, front axle, forks.
  const discs: [number, number][] = [
    [-0.75, 0.8],
    [0.55, 0.8],
    [loaded ? 2.1 : 1.9, loaded ? 0.9 : 0.7],
  ];
  const fits = (x: number, y: number, yaw: number) => {
    // Where it starts and where it is going, the truck is beside things by design: it has just backed
    // out of a pallet, or is about to go into one. There it need only not touch; elsewhere it keeps a margin.
    const near = Math.min(Math.hypot(x - from.x, y - from.y), Math.hypot(x - to.x, y - to.y)) < 3;
    const margin = near ? -0.15 : 0.45;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (const [ahead, r] of discs) if (clearance(x + c * ahead, y + s * ahead) < r + margin) return false;
    return true;
  };

  const radius = loaded ? 2.8 : 2.2;
  const turn = STEP_M / radius;
  const bin = (yaw: number) => ((Math.round((yaw / (2 * Math.PI)) * HEADINGS) % HEADINGS) + HEADINGS) % HEADINGS;
  const key = (x: number, y: number, yaw: number) => {
    const cx = Math.floor((x - BOUNDS.min[0]) / CELL_M);
    const cy = Math.floor((y - BOUNDS.min[1]) / CELL_M);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return -1;
    return (cy * COLS + cx) * HEADINGS + bin(yaw);
  };
  const size = COLS * ROWS * HEADINGS;
  const g = new Float32Array(size).fill(Infinity);
  const parent = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const px = new Float32Array(size);
  const py = new Float32Array(size);
  const pyaw = new Float32Array(size);
  /** How each pose was reached: 1 forward, -1 in reverse, 0 for the start. */
  const way = new Int8Array(size);

  const start = key(from.x, from.y, from.yaw);
  if (start < 0) return null;
  g[start] = 0;
  px[start] = from.x;
  py[start] = from.y;
  pyaw[start] = from.yaw;
  const off = (a: number) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  const there = (i: number) =>
    Math.hypot((px[i] as number) - to.x, (py[i] as number) - to.y) < 0.6 &&
    (to.yaw === undefined || off((pyaw[i] as number) - to.yaw) < 0.25);
  // Straight-line distance, plus the turning still owed at the turning radius once close.
  const h = (i: number) => {
    const d = Math.hypot((px[i] as number) - to.x, (py[i] as number) - to.y);
    return d + (to.yaw === undefined || d > 6 ? 0 : off((pyaw[i] as number) - to.yaw) * radius * 0.5);
  };

  const heap: [number, number][] = [[h(start), start]];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heap[p] as [number, number])[0] <= item[0]) break;
      heap[i] = heap[p] as [number, number];
      i = p;
    }
    heap[i] = item;
  };
  const pop = (): [number, number] => {
    const top = heap[0] as [number, number];
    const last = heap.pop() as [number, number];
    if (heap.length > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && (heap[c + 1] as [number, number])[0] < (heap[c] as [number, number])[0]) c++;
        if ((heap[c] as [number, number])[0] >= last[0]) break;
        heap[i] = heap[c] as [number, number];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };

  let goal = -1;
  for (let n = 0; heap.length > 0 && n < LIMIT; n++) {
    const [, i] = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (there(i)) {
      goal = i;
      break;
    }
    const x = px[i] as number;
    const y = py[i] as number;
    const yaw = pyaw[i] as number;
    for (const dir of [1, -1]) {
      for (const bend of [0, 1, -1]) {
        // One step along the arc: the heading turns by `turn`, the position moves along the chord.
        const dyaw = bend * turn * dir;
        const mid = yaw + dyaw / 2;
        const nx = x + Math.cos(mid) * STEP_M * dir;
        const ny = y + Math.sin(mid) * STEP_M * dir;
        const nyaw = yaw + dyaw;
        const k = key(nx, ny, nyaw);
        if (k < 0 || closed[k] || !fits(nx, ny, nyaw)) continue;
        const cost =
          (g[i] as number) +
          STEP_M * (dir > 0 ? 1 : 1.7) +
          (bend !== 0 ? 0.12 : 0) +
          (way[i] !== 0 && way[i] !== dir ? 2.5 : 0);
        if (cost < (g[k] as number)) {
          g[k] = cost;
          parent[k] = i;
          px[k] = nx;
          py[k] = ny;
          pyaw[k] = nyaw;
          way[k] = dir;
          push([cost + h(k), k]);
        }
      }
    }
  }
  if (goal < 0) return null;

  // Walk back from the goal, then cut the route where the direction changes.
  const chain: number[] = [];
  for (let i = goal; i !== -1; i = parent[i] as number) chain.push(i);
  chain.reverse();
  const legs: Leg[] = [];
  for (let n = 1; n < chain.length; n++) {
    const i = chain[n] as number;
    const reverse = way[i] === -1;
    let leg = legs[legs.length - 1];
    if (!leg || leg.reverse !== reverse) {
      const prev = chain[n - 1] as number;
      leg = { reverse, points: [[px[prev] as number, py[prev] as number]] };
      legs.push(leg);
    }
    leg.points.push([px[i] as number, py[i] as number]);
  }
  return legs;
}
