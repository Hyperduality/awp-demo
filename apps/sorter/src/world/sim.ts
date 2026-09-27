import { type ActionRun, type AdmitVerdict, mulberry32, type Sim } from "@awp-demo/world";
import {
  binFor,
  CELL,
  COLORS,
  type Color,
  type GripperPayload,
  ik,
  type ParcelView,
  type ProprioPayload,
  type ScenePayload,
  type SorterView,
} from "../shared/cell.ts";

interface Parcel {
  id: string;
  color: Color;
  x: number;
  z: number;
  vz: number;
  on: "belt" | "gripper" | "air";
}

const STATES: Record<string, { spawnS: number; beltMps: number }> = {
  default: { spawnS: 3.4, beltMps: 0.06 },
  rush: { spawnS: 2.0, beltMps: 0.085 },
};

const DEFAULT_SPEED = 0.6;
const MAX_SPEED = 1.0;
const GRIP_MPS = 0.2;
const TOLERANCE = 0.04;

export class SorterSim implements Sim<SorterView> {
  private readonly rand: () => number;
  private readonly spawnS: number;
  private beltMps: number;
  private time = 0;
  private tickCount = 0;
  private nextSpawn = 0.5;
  private serial = 0;
  private beltOffset = 0;
  private ee: [number, number] = [CELL.home[0], CELL.home[1]];
  private target: [number, number] | null = null;
  private width: number = CELL.gripperOpen;
  private holding: Parcel | null = null;
  private parcels: Parcel[] = [];
  private readonly bins = CELL.bins.map((b) => ({ color: b.color, count: 0, wrong: 0 }));
  private readonly stats = { sorted: 0, wrong: 0, missed: 0, dropped: 0 };

  constructor(seed: number, initialState: string) {
    this.rand = mulberry32(seed);
    const s = STATES[initialState] ?? STATES.default!;
    this.spawnS = s.spawnS;
    this.beltMps = s.beltMps;
    // Start with parcels already on the way, so there is something to do at once.
    for (const x of [-0.55, -0.2]) this.spawn(x);
  }

  // ---------------------------------------------------------------------------------------------
  // World dynamics

  step(dtMs: number): void {
    const dt = dtMs / 1000;
    this.time += dt;
    this.tickCount += 1;
    this.beltOffset = (this.beltOffset + this.beltMps * dt) % 0.1;
    if (this.time >= this.nextSpawn) {
      this.spawn(CELL.belt.x0 + 0.04);
      this.nextSpawn = this.time + this.spawnS * (0.8 + 0.4 * this.rand());
    }
    for (const p of [...this.parcels]) {
      if (p.on === "belt") {
        p.x += this.beltMps * dt;
        if (p.x > CELL.belt.x1) {
          this.remove(p);
          this.stats.missed += 1;
        }
      } else if (p.on === "air") {
        p.vz -= 9.81 * dt;
        p.z += p.vz * dt;
        const bin = CELL.bins.find((b) => Math.abs(p.x - b.x) <= b.w / 2);
        const floor = bin ? bin.z - 0.1 : onBelt(p.x) ? CELL.belt.z + CELL.parcel / 2 : CELL.parcel / 2;
        if (p.z <= floor) {
          if (bin) {
            this.remove(p);
            const b = this.bins.find((x) => x.color === bin.color)!;
            if (bin.color === p.color) {
              b.count += 1;
              this.stats.sorted += 1;
            } else {
              b.wrong += 1;
              this.stats.wrong += 1;
            }
          } else if (onBelt(p.x)) {
            p.z = floor;
            p.vz = 0;
            p.on = "belt";
          } else {
            this.remove(p);
            this.stats.dropped += 1;
          }
        }
      }
    }
    if (this.holding) {
      this.holding.x = this.ee[0];
      this.holding.z = this.ee[1] - CELL.parcel / 2 - 0.005;
    }
  }

  private spawn(x: number): void {
    const color = COLORS[Math.floor(this.rand() * COLORS.length)]!;
    this.parcels.push({ id: `P-${++this.serial}`, color, x, z: CELL.belt.z + CELL.parcel / 2, vz: 0, on: "belt" });
  }

  private remove(p: Parcel): void {
    this.parcels = this.parcels.filter((x) => x !== p);
    if (this.holding === p) this.holding = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Actions

  admit(embodiment: string, type: string, params: Record<string, unknown>): AdmitVerdict {
    if (embodiment === "arm_0" && type === "move_to") {
      const x = params.x_m as number;
      const z = params.z_m as number;
      if (z < 0.05) return { error: "AWP_ENVELOPE_EXCEEDED", detail: `z ${z.toFixed(2)} m is below the work surface` };
      if (!ik(x, z))
        return { error: "AWP_ENVELOPE_EXCEEDED", detail: `(${x.toFixed(2)}, ${z.toFixed(2)}) is out of reach` };
    }
    return { ok: true };
  }

  start(embodiment: string, type: string, params: Record<string, unknown>): ActionRun {
    if (embodiment === "arm_0") {
      if (type === "stop") {
        return {
          update: () => {
            this.target = null;
            return { done: true };
          },
        };
      }
      const goal: [number, number] = [params.x_m as number, params.z_m as number];
      const speed = Math.min(MAX_SPEED, (params.max_velocity_mps as number | undefined) ?? DEFAULT_SPEED);
      const from: [number, number] = [...this.ee];
      const total = Math.hypot(goal[0] - from[0], goal[1] - from[1]);
      this.target = goal;
      return {
        update: (dtMs) => {
          const step = (speed * dtMs) / 1000;
          const dx = goal[0] - this.ee[0];
          const dz = goal[1] - this.ee[1];
          const left = Math.hypot(dx, dz);
          if (left <= step) {
            this.ee = [...goal];
            this.target = null;
            return { done: true };
          }
          this.ee = [this.ee[0] + (dx / left) * step, this.ee[1] + (dz / left) * step];
          return { progress: total > 0 ? 1 - (left - step) / total : 1 };
        },
        abort: () => {
          this.target = null;
          return 150;
        },
      };
    }
    // Gripper.
    const closing = type === "grip";
    return {
      update: (dtMs) => {
        const step = (GRIP_MPS * dtMs) / 1000;
        if (closing) {
          const stopAt = this.parcelUnderGripper() ? CELL.parcel : 0;
          this.width = Math.max(stopAt, this.width - step);
          if (this.width <= stopAt + 1e-6) {
            const p = this.parcelUnderGripper();
            if (p) {
              p.on = "gripper";
              this.holding = p;
            }
            return { done: true };
          }
          return { progress: 1 - (this.width - stopAt) / (CELL.gripperOpen - stopAt) };
        }
        if (this.holding) {
          this.holding.on = "air";
          this.holding.vz = 0;
          this.holding = null;
        }
        this.width = Math.min(CELL.gripperOpen, this.width + step);
        return this.width >= CELL.gripperOpen - 1e-6 ? { done: true } : { progress: this.width / CELL.gripperOpen };
      },
      abort: () => 0,
    };
  }

  private parcelUnderGripper(): Parcel | undefined {
    if (this.holding) return this.holding;
    const [x, z] = this.ee;
    return this.parcels.find(
      (p) =>
        p.on === "belt" && Math.abs(p.x - x) < TOLERANCE && Math.abs(p.z + CELL.parcel / 2 - (z - 0.005)) < TOLERANCE,
    );
  }

  safeStop(embodiment: string): void {
    if (embodiment === "arm_0") this.target = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Observations

  observe(channel: string): unknown {
    const q = ik(this.ee[0], this.ee[1]) ?? [0, 0];
    switch (channel) {
      case "proprio":
        return {
          q_rad: [round(q[0]), round(q[1])],
          ee_m: [round(this.ee[0]), round(this.ee[1])],
          moving: this.target !== null,
        } satisfies ProprioPayload;
      case "gripper_state":
        return { width_m: round(this.width), holding: this.holding?.id ?? null } satisfies GripperPayload;
      case "scene":
        return this.scene();
      default:
        throw new Error(`no channel ${channel}`);
    }
  }

  private scene(): ScenePayload {
    const entities: ScenePayload["entities"] = [
      {
        id: "belt",
        class: "conveyor",
        pose: { frame: "base", p_m: [round((CELL.belt.x0 + CELL.belt.x1) / 2), 0, CELL.belt.z], q: [0, 0, 0, 1] },
        state: { speed_mps: this.beltMps, x_min_m: CELL.belt.x0, x_max_m: CELL.belt.x1 },
      },
      ...CELL.bins.map((b) => ({
        id: `bin_${b.color}`,
        class: "bin" as const,
        pose: {
          frame: "base" as const,
          p_m: [b.x, 0, b.z] as [number, number, number],
          q: [0, 0, 0, 1] as [0, 0, 0, 1],
        },
        state: { color: b.color, width_m: b.w, count: this.bins.find((x) => x.color === b.color)!.count },
      })),
      ...this.parcels.map((p) => ({
        id: p.id,
        class: "parcel" as const,
        pose: {
          frame: "base" as const,
          p_m: [round(p.x), 0, round(p.z)] as [number, number, number],
          q: [0, 0, 0, 1] as [0, 0, 0, 1],
        },
        affordances: ["graspable"],
        state: { color: p.color, on: p.on },
      })),
    ];
    const relations = this.parcels
      .filter((p) => p.on !== "air")
      .map((p) => ({
        type: p.on === "belt" ? "on_top_of" : "held_by",
        subject: p.id,
        object: p.on === "belt" ? "belt" : "gripper_0",
      }));
    return { entities, relations, stats: { ...this.stats } };
  }

  view(): SorterView {
    const q = ik(this.ee[0], this.ee[1]) ?? [0, 0];
    return {
      tick: this.tickCount,
      timeS: this.time,
      arm: { q, ee: [...this.ee], target: this.target },
      gripper: { width: this.width, holding: this.holding?.id ?? null },
      parcels: this.parcels.map((p): ParcelView => ({ id: p.id, color: p.color, x: p.x, z: p.z, on: p.on })),
      bins: this.bins.map((b) => ({ ...b })),
      belt: { offset: this.beltOffset, speed: this.beltMps },
      stats: { ...this.stats },
    };
  }

  staticView() {
    return CELL;
  }

  operator(name: string, args: unknown): unknown {
    if (name === "nudge") {
      // Knock the parcel nearest the gripper along the belt, so a controller has to replan.
      const p = this.parcels
        .filter((x) => x.on === "belt")
        .sort((a, b) => Math.abs(a.x - this.ee[0]) - Math.abs(b.x - this.ee[0]))[0];
      if (p) p.x = Math.min(CELL.belt.x1 - 0.02, p.x + 0.12);
      return { nudged: p?.id ?? null };
    }
    if (name === "belt") {
      const speed = Number((args as { speed?: number })?.speed);
      if (Number.isFinite(speed)) this.beltMps = Math.max(0, Math.min(0.15, speed));
      return { speed: this.beltMps };
    }
    return undefined;
  }
}

function onBelt(x: number): boolean {
  return x >= CELL.belt.x0 && x <= CELL.belt.x1;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export { binFor };
