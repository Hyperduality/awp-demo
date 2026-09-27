import type { ActionRun, Sim } from "@awp-demo/world";
import {
  type Cell,
  COLORS,
  DIRS,
  LAYOUTS,
  LEGEND,
  type MapPayload,
  SIGHT,
  type StatusPayload,
  type VaultView,
} from "../shared/vault.ts";

const key = ([x, y]: Cell) => `${x},${y}`;

interface Door {
  color: string;
  open: boolean;
}

export class VaultSim implements Sim<VaultView> {
  private readonly walls: boolean[][];
  private readonly width: number;
  private readonly height: number;
  private readonly items = new Map<string, string>();
  private readonly doors = new Map<string, Door>();
  private readonly exit: Cell;
  private readonly seen = new Set<string>();
  private avatar: Cell = [1, 1];
  private facing: StatusPayload["facing"] = "east";
  private inventory: string[] = [];
  private path: Cell[] = [];
  private escaped = false;
  private message = "You are in the dark. Find the gem and get out.";
  private steps = 0;

  constructor(initialState: string) {
    const rows = LAYOUTS[initialState] ?? LAYOUTS.default!;
    this.height = rows.length;
    this.width = rows[0]!.length;
    let exit: Cell = [0, 0];
    this.walls = rows.map((row, y) =>
      [...row].map((c, x) => {
        if (c === "S") this.avatar = [x, y];
        if (c === "E") exit = [x, y];
        if (c in COLORS) this.items.set(key([x, y]), `${COLORS[c]} key`);
        if (c === "G") this.items.set(key([x, y]), "gem");
        if (c.toLowerCase() in COLORS && c === c.toUpperCase())
          this.doors.set(key([x, y]), { color: COLORS[c.toLowerCase()]!, open: false });
        return c === "#";
      }),
    );
    this.exit = exit;
    this.reveal();
  }

  // ---------------------------------------------------------------------------------------------

  private passable([x, y]: Cell): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || this.walls[y]![x]) return false;
    const door = this.doors.get(key([x, y]));
    if (door && !door.open) return false;
    return !(x === this.exit[0] && y === this.exit[1]);
  }

  private blocksSight([x, y]: Cell): boolean {
    if (this.walls[y]?.[x] !== false) return true;
    const door = this.doors.get(key([x, y]));
    return Boolean(door && !door.open);
  }

  /** Line of sight within SIGHT tiles; walls and closed doors are seen but block what lies beyond. */
  private reveal(): void {
    const [ax, ay] = this.avatar;
    for (let dy = -SIGHT; dy <= SIGHT; dy++)
      for (let dx = -SIGHT; dx <= SIGHT; dx++) {
        if (dx * dx + dy * dy > SIGHT * SIGHT + 1) continue;
        const tx = ax + dx;
        const ty = ay + dy;
        if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        let visible = true;
        for (let i = 1; i < steps; i++) {
          const px = Math.round(ax + (dx * i) / steps);
          const py = Math.round(ay + (dy * i) / steps);
          if (this.blocksSight([px, py])) {
            visible = false;
            break;
          }
        }
        if (visible) this.seen.add(key([tx, ty]));
      }
  }

  /** A* over tiles the explorer has seen and can walk through. */
  private plan(from: Cell, to: Cell): Cell[] | undefined {
    const goalKey = key(to);
    const open: { c: Cell; f: number; g: number }[] = [{ c: from, f: 0, g: 0 }];
    const came = new Map<string, Cell | null>([[key(from), null]]);
    const cost = new Map<string, number>([[key(from), 0]]);
    while (open.length > 0) {
      open.sort((a, b) => a.f - b.f);
      const { c, g } = open.shift()!;
      if (key(c) === goalKey) {
        const out: Cell[] = [];
        for (let n: Cell | null = c; n; n = came.get(key(n)) ?? null) out.unshift(n);
        return out.slice(1);
      }
      for (const [dx, dy] of Object.values(DIRS)) {
        const n: Cell = [c[0] + dx, c[1] + dy];
        const k = key(n);
        if (!this.seen.has(k) || !this.passable(n)) continue;
        if ((cost.get(k) ?? Infinity) <= g + 1) continue;
        cost.set(k, g + 1);
        came.set(k, c);
        open.push({ c: n, g: g + 1, f: g + 1 + Math.abs(n[0] - to[0]) + Math.abs(n[1] - to[1]) });
      }
    }
    return undefined;
  }

  private stepTo(n: Cell): string | undefined {
    if (this.passable(n)) {
      this.avatar = n;
      this.steps += 1;
      this.reveal();
      return undefined;
    }
    const door = this.doors.get(key(n));
    if (door && !door.open) return `the ${door.color} door is locked`;
    if (n[0] === this.exit[0] && n[1] === this.exit[1]) return "the exit is a door: interact with it";
    return "a wall is in the way";
  }

  // ---------------------------------------------------------------------------------------------

  step(): void {}

  start(_e: string, type: string, params: Record<string, unknown>): ActionRun {
    const done = (message: string) => {
      this.message = message;
      return { done: true as const };
    };
    const fail = (message: string) => {
      this.message = `Could not: ${message}.`;
      return { failed: "world_error", detail: message };
    };
    switch (type) {
      case "move":
        return {
          update: () => {
            const dir = params.direction as StatusPayload["facing"];
            this.facing = dir;
            const [dx, dy] = DIRS[dir];
            const blocked = this.stepTo([this.avatar[0] + dx, this.avatar[1] + dy]);
            return blocked ? fail(blocked) : done(`Moved ${dir}.`);
          },
        };
      case "walk_to": {
        const target = params.cell as Cell;
        const path = this.plan(this.avatar, target);
        const total = path?.length ?? 0;
        this.path = path ?? [];
        return {
          update: () => {
            if (!path) return fail(`no known path to (${target[0]}, ${target[1]}); explore toward it first`);
            const next = path.shift();
            if (!next) {
              this.path = [];
              return done(`Arrived at (${target[0]}, ${target[1]}).`);
            }
            const d: Cell = [next[0] - this.avatar[0], next[1] - this.avatar[1]];
            this.facing = d[0] > 0 ? "east" : d[0] < 0 ? "west" : d[1] > 0 ? "south" : "north";
            const blocked = this.stepTo(next);
            this.path = [...path];
            if (blocked) return fail(blocked);
            if (path.length === 0) {
              this.path = [];
              return done(`Arrived at (${target[0]}, ${target[1]}).`);
            }
            return { progress: 1 - path.length / total };
          },
          abort: () => {
            this.path = [];
            return 0;
          },
        };
      }
      case "wait": {
        const total = params.ticks as number;
        let left = total;
        return {
          update: () => {
            left -= 1;
            return left <= 0 ? done(`Waited ${total} ticks.`) : { progress: 1 - left / total };
          },
        };
      }
      case "interact":
        return { update: () => this.interact(params.cell as Cell, done, fail) };
      default:
        // drop
        return {
          update: () => {
            const item = params.item as string;
            if (!this.inventory.includes(item)) return fail(`you are not carrying ${item}`);
            if (this.items.has(key(this.avatar))) return fail("something already lies here");
            this.inventory = this.inventory.filter((i) => i !== item);
            this.items.set(key(this.avatar), item);
            return done(`Dropped the ${item}.`);
          },
        };
    }
  }

  private interact(
    cell: Cell,
    done: (m: string) => { done: true },
    fail: (m: string) => { failed: string; detail: string },
  ) {
    const [x, y] = cell;
    const dist = Math.abs(x - this.avatar[0]) + Math.abs(y - this.avatar[1]);
    if (dist > 1) return fail(`(${x}, ${y}) is not next to you`);
    const k = key(cell);
    const item = this.items.get(k);
    if (item) {
      this.items.delete(k);
      this.inventory.push(item);
      return done(`Picked up the ${item}.`);
    }
    const door = this.doors.get(k);
    if (door && !door.open) {
      if (!this.inventory.includes(`${door.color} key`))
        return fail(`the ${door.color} door needs the ${door.color} key`);
      door.open = true;
      this.reveal();
      return done(`Opened the ${door.color} door.`);
    }
    if (x === this.exit[0] && y === this.exit[1]) {
      if (!this.inventory.includes("gem")) return fail("the exit only opens for whoever carries the gem");
      this.escaped = true;
      return done("You left the vault with the gem.");
    }
    return fail(`there is nothing to use at (${x}, ${y})`);
  }

  safeStop(): void {
    this.path = [];
  }

  // ---------------------------------------------------------------------------------------------

  private symbol(c: Cell, known: boolean): string {
    const k = key(c);
    if (!known) return "?";
    if (c[0] === this.avatar[0] && c[1] === this.avatar[1]) return "@";
    const item = this.items.get(k);
    if (item === "gem") return "*";
    if (item) return item[0]!;
    const door = this.doors.get(k);
    if (door) return door.open ? "+" : door.color[0]!.toUpperCase();
    if (c[0] === this.exit[0] && c[1] === this.exit[1]) return "E";
    return this.walls[c[1]]![c[0]] ? "#" : ".";
  }

  private rows(all: boolean): string[] {
    return Array.from({ length: this.height }, (_, y) =>
      Array.from({ length: this.width }, (_, x) => this.symbol([x, y], all || this.seen.has(key([x, y])))).join(""),
    );
  }

  observe(channel: string): unknown {
    if (channel === "map") {
      return {
        rows: this.rows(false),
        width: this.width,
        height: this.height,
        legend: { ...LEGEND },
      } satisfies MapPayload;
    }
    return {
      position: [...this.avatar],
      facing: this.facing,
      inventory: [...this.inventory],
      message: this.message,
      escaped: this.escaped,
      steps: this.steps,
    } satisfies StatusPayload;
  }

  view(): VaultView {
    return {
      truth: this.rows(true),
      seen: Array.from({ length: this.height }, (_, y) =>
        Array.from({ length: this.width }, (_, x) => (this.seen.has(key([x, y])) ? "1" : "0")).join(""),
      ),
      avatar: [...this.avatar],
      facing: this.facing,
      inventory: [...this.inventory],
      path: [...this.path],
      escaped: this.escaped,
      message: this.message,
      steps: this.steps,
    };
  }
}
