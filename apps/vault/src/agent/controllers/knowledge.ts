import type { ControlContext } from "@awp-demo/agent";
import { type Cell, DIRS, type MapPayload, type StatusPayload } from "../../shared/vault.ts";

const PASSABLE = new Set([".", "+", "@", "r", "b", "y", "*"]);

/** What the explorer knows, read from its own observations. */
export class Knowledge {
  readonly map: MapPayload;
  readonly status: StatusPayload;

  constructor(map: MapPayload, status: StatusPayload) {
    this.map = map;
    this.status = status;
  }

  static read(ctx: ControlContext<unknown>): Knowledge | undefined {
    const map = ctx.latest<MapPayload>("map");
    const status = ctx.latest<StatusPayload>("status");
    return map && status ? new Knowledge(map, status) : undefined;
  }

  at([x, y]: Cell): string {
    return this.map.rows[y]?.[x] ?? "#";
  }

  find(symbols: string): Cell[] {
    const out: Cell[] = [];
    this.map.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (symbols.includes(row[x]!)) out.push([x, y]);
    });
    return out;
  }

  carries(item: string): boolean {
    return this.status.inventory.includes(item);
  }

  /** Breadth-first distances over known walkable tiles from the explorer. */
  reach(): Map<string, { d: number; prev: string | null }> {
    const start = this.status.position;
    const out = new Map<string, { d: number; prev: string | null }>([
      [`${start[0]},${start[1]}`, { d: 0, prev: null }],
    ]);
    const queue: Cell[] = [start];
    while (queue.length > 0) {
      const c = queue.shift()!;
      const d = out.get(`${c[0]},${c[1]}`)!.d;
      for (const [dx, dy] of Object.values(DIRS)) {
        const n: Cell = [c[0] + dx, c[1] + dy];
        const k = `${n[0]},${n[1]}`;
        if (out.has(k) || !PASSABLE.has(this.at(n))) continue;
        out.set(k, { d: d + 1, prev: `${c[0]},${c[1]}` });
        queue.push(n);
      }
    }
    return out;
  }

  /** The nearest reachable tile satisfying `pred`, or next to a tile satisfying it when `adjacent`. */
  nearest(pred: (c: Cell) => boolean, adjacent = false): Cell | undefined {
    const reach = this.reach();
    let best: { c: Cell; d: number } | undefined;
    for (const [k, { d }] of reach) {
      const c = k.split(",").map(Number) as Cell;
      const ok = adjacent ? Object.values(DIRS).some(([dx, dy]) => pred([c[0] + dx, c[1] + dy])) : pred(c);
      if (ok && (!best || d < best.d)) best = { c, d };
    }
    return best?.c;
  }

  /** The explored map with coordinate rulers, for a model to read. */
  text(): string {
    const w = this.map.width;
    const tens = Array.from({ length: w }, (_, x) => (x % 10 === 0 ? String(Math.floor(x / 10)) : " ")).join("");
    const ones = Array.from({ length: w }, (_, x) => String(x % 10)).join("");
    const rows = this.map.rows.map((r, y) => `${String(y).padStart(2)} ${r}`);
    return [`   ${tens}`, `   ${ones}`, ...rows].join("\n");
  }
}

export function same(a: Cell, b: Cell): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
