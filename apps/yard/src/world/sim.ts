import {
  type BodyDesc,
  type Pose as BodyPose,
  type CameraFrame,
  castCamera,
  castLidar,
  compose,
  type LayoutBody,
  type LidarSweep,
  PhysicsWorld,
  POSE_STRIDE,
  packFloats,
  qAxisAngle,
  type Rgb,
  type Shading,
  toBase64,
  toLocal,
  transform,
  type Vec3,
  wrapAngle,
  yawOf,
} from "@awp-demo/physics";
import { type ActionRun, type AdmitVerdict, mulberry32, type RunStatus, type Sim } from "@awp-demo/world";
import { MATERIALS } from "../shared/materials.ts";
import {
  type Bay,
  BOUNDS,
  CAMERA,
  type DriveSetpoint,
  EMBODIMENT,
  LIDAR,
  type Proprio,
  type Scene,
  type SceneEntity,
  type SensorsView,
  type YardLayout,
  type YardView,
} from "../shared/yard.ts";
import { Follower, JOIN_M, type Kinematic, type Target } from "./drive-to.ts";
import { SENSORS, TRUCK, Truck, truckBodies, truckExtras } from "./forklift.ts";
import { type Footprint, type Leg, planRoute, type RoutePose } from "./plan.ts";
import {
  BAYS,
  LOAD_LABEL,
  type LoadKind,
  load,
  PALLET,
  pallet,
  RECEIVING,
  RECEIVING_PAD,
  yardProps,
  yardStatics,
} from "./scenarios.ts";
import { type PalletInfo, Task } from "./task.ts";

const PHYSICS_HZ = 120;
const G = 9.81;
/** Chassis origin to pallet centre with the forks fully in. */
const ENGAGED_M = TRUCK.forkHeel_m + PALLET.length_m / 2 + 0.03;
/** Fork blade centre in the carriage frame. */
const BLADE_Z = -0.345;
const TRUCK_GROUP = 1;
/** The truck starts parked by the bays, facing the trailer: the receiving pad is behind it and out of its sensors' reach. */
const START = { p: [9, -12.5, 0] as Vec3, yaw: Math.PI / 2 };
/** The sensors are read for what they show four times a second, and a thing counts as seen on two rays. */
const PERCEIVE_EVERY = 15;
const SEEN_ON_RAYS = 2;
/** The underside of a pallet's deck above its base: where the blades bear when they carry it. */
const DECK_UNDERSIDE_M = 0.122;

const SHADING: Shading = {
  albedo: Object.fromEntries(Object.entries(MATERIALS).map(([k, m]) => [k, m.color as Rgb])),
  sun: normalize([-0.45, -0.35, 0.82]),
  ambient: 0.42,
  zenith: [96, 140, 198],
  horizon: [198, 208, 216],
  shadows: true,
};

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r3v = (v: readonly number[]) => v.map(r3) as Vec3;
const r4q = (q: readonly number[]) => q.map((x) => Math.round(x * 1e4) / 1e4) as [number, number, number, number];

/** Full extents of a body's parts in its own frame. */
function sizeOf(body: BodyDesc | LayoutBody): Vec3 {
  const { lo, hi } = extent(body);
  return [r3(hi[0] - lo[0]), r3(hi[1] - lo[1]), r3(hi[2] - lo[2])];
}

/** The corners of the box around a body's parts, in its own frame. */
function extent(body: BodyDesc | LayoutBody): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const part of body.parts) {
    const s = part.shape;
    // A cylinder or cone lies along y unless turned upright.
    const half: Vec3 =
      s.kind === "box" ? s.half : part.rot ? [s.radius, s.radius, s.halfHeight] : [s.radius, s.halfHeight, s.radius];
    const at = part.at ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i] as number, (at[i] as number) - (half[i] as number));
      hi[i] = Math.max(hi[i] as number, (at[i] as number) + (half[i] as number));
    }
  }
  return { lo, hi };
}

type StepResult = "busy" | "next" | { failed: string; detail?: string };

let layoutSerial = 0;

/**
 * A freight yard as rigid bodies. One forklift takes orders to move pallets into bays; what happens to
 * the loads on the way is physics. The same seed lays out the same yard, loads and orders (AWP-REP-001).
 */
export class YardSim implements Sim<YardView> {
  readonly pw: PhysicsWorld;
  readonly truck: Truck;
  readonly task: Task;
  readonly bays: Bay[];
  private readonly pallets: PalletInfo[];
  private readonly statics: BodyDesc[];
  private readonly extras: LayoutBody[];
  private readonly key: string;
  private readonly cooldown = new Map<string, number>();
  private time_s = 0;
  private steps = 0;
  private residual_ms = 0;
  private target: YardView["target"] = null;
  private path: [number, number][] | null = null;
  /** Which action holds the mast, so a pick and a `set_forks` cannot fight over it. */
  private mastOwner: "macro" | "set_forks" | undefined;
  private carried: { step: number; id: string | null } = { step: -1, id: null };
  private camera: ({ step: number } & CameraFrame) | undefined;
  private lidar: ({ step: number } & LidarSweep) | undefined;
  /**
   * What the truck's sensors have picked out, by entity: where it was when last seen, when, and whether
   * it is in view now. The truck's own skills work from this and the site map, never from the world's
   * truth: a pallet it has not seen is a pallet it cannot go and fetch.
   */
  private readonly seen = new Map<string, { pose: BodyPose; t_s: number; visible: boolean }>();
  /** Which pallet each loose item started on. */
  private readonly loadOf = new Map<string, string>();
  private perceivedAt = -1;

  private constructor(
    pw: PhysicsWorld,
    statics: BodyDesc[],
    pallets: PalletInfo[],
    orders: { pallet: string; bay: string }[],
    key: string,
  ) {
    this.pw = pw;
    this.statics = statics;
    this.pallets = pallets;
    this.bays = BAYS;
    this.truck = new Truck(pw, EMBODIMENT, TRUCK_GROUP);
    this.extras = truckExtras(EMBODIMENT);
    this.task = new Task(pallets, orders, BAYS);
    this.key = key;
    for (const p of pallets) for (const item of p.items) this.loadOf.set(item, p.id);
  }

  static async create(seed: number, initialState: string): Promise<YardSim> {
    const rand = mulberry32(seed);
    const statics = yardStatics();
    const bodies: BodyDesc[] = [...statics, ...truckBodies(EMBODIMENT, TRUCK_GROUP, START.p, START.yaw)];
    const pallets: PalletInfo[] = [];
    const orders: { pallet: string; bay: string }[] = [];
    if (initialState !== "empty") {
      bodies.push(...yardProps(rand));
      const kinds: LoadKind[] = ["crate", "stack", "cartons", "barrels"];
      const place = (n: number, kind: LoadKind, p: Vec3, yaw: number) => {
        const id = `pallet_${n}`;
        const items = load(kind, `load_${n}`, p, yaw);
        bodies.push(pallet(id, p, yaw), ...items);
        pallets.push({ id, label: `Pallet ${n} (${LOAD_LABEL[kind]})`, items: items.map((b) => b.id) });
      };
      RECEIVING.forEach((slot, i) => {
        const kind = kinds[Math.floor(rand() * kinds.length)] as LoadKind;
        place(i + 1, kind, slot.p, slot.yaw + (rand() - 0.5) * 0.08);
      });
      // One load no hoist of this size can raise, to show the force limit.
      place(RECEIVING.length + 1, "block", [5, 3, 0.002], Math.PI / 2);

      const picks = [0, 1, 2, 3, 4, 5].sort(() => rand() - 0.5).slice(0, 3);
      const ground = ["bay_a", "bay_b", "bay_c"].sort(() => rand() - 0.5);
      const slots =
        initialState === "trailer" ? ["trailer_1", "trailer_2", "trailer_3"] : [ground[0], ground[1], "trailer_2"];
      for (const [i, p] of picks.entries()) orders.push({ pallet: `pallet_${p + 1}`, bay: slots[i] as string });
    }
    const pw = await PhysicsWorld.create({ bodies }, { dt_s: 1 / PHYSICS_HZ, solverIterations: 16 });
    const sim = new YardSim(pw, statics, pallets, orders, `${initialState}:${seed}:${++layoutSerial}`);
    // Let the truck settle on its wheels and take a first look, so the first observation is a real one.
    for (let i = 0; i < PHYSICS_HZ / 2; i++) {
      sim.truck.update(pw.dt_s);
      pw.step();
    }
    sim.perceive();
    return sim;
  }

  // -------------------------------------------------------------------------------------------
  // Time

  step(dtMs: number): void {
    this.residual_ms += dtMs;
    const sub = 1000 / PHYSICS_HZ;
    while (this.residual_ms >= sub - 1e-6) {
      this.residual_ms -= sub;
      this.truck.update(this.pw.dt_s);
      this.pw.step();
    }
    this.steps++;
    this.truck.loaded = this.carrying() !== null;
    if (this.steps % PERCEIVE_EVERY === 0) this.perceive();
    this.time_s += dtMs / 1000;
    this.task.update(dtMs / 1000, {
      carrying: this.carrying(),
      restingIn: (id) => this.restingIn(id),
      itemsOn: (id) => this.itemsOn(id).length,
      tipped: this.truck.tipped,
      stalled: this.truck.stalled,
    });
    for (const hit of this.pw.impacts()) {
      const key = hit.a < hit.b ? `${hit.a}|${hit.b}` : `${hit.b}|${hit.a}`;
      if ((this.cooldown.get(key) ?? -Infinity) > this.time_s) continue;
      this.cooldown.set(key, this.time_s + 3);
      this.task.note(`Hard impact between ${hit.a} and ${hit.b} (${Math.round(hit.force_n / 1000)} kN)`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // What the truck knows about its load

  private kin(): Kinematic {
    const s = this.truck.state();
    return { x: s.base.p[0], y: s.base.p[1], yaw: s.yaw_rad, v: s.v_mps };
  }

  /**
   * Where a pallet is relative to the forks. `inside`: the blades are in its pockets. `resting`: its deck
   * sits on them, measured as the gap between the blades' top and the deck's underside along the pallet's
   * own up, so the mast's tilt does not matter. `held` is the same with slack, for letting go.
   */
  private onForks(id: string): { inside: boolean; resting: boolean; held: boolean } {
    const carriage = this.truck.carriagePose();
    const pose = this.pw.pose(id);
    const l = toLocal(carriage, pose.p);
    const dz = l[2] - BLADE_Z;
    const inside = l[0] > 0.4 && l[0] < 1.15 && Math.abs(l[1]) < 0.3 && dz > -0.3 && dz < 0.02;
    const gap = DECK_UNDERSIDE_M - toLocal(pose, transform(carriage, [0.6, 0, BLADE_Z + 0.02]))[2];
    return { inside, resting: inside && gap < 0.012, held: inside && gap < 0.03 };
  }

  /** The pallet the forks are holding off the ground, if any. */
  carrying(): string | null {
    if (this.carried.step !== this.steps) {
      // Once held, a pallet stays held until its deck is clearly off the blades again.
      const held = this.carried.id;
      const id =
        held && this.onForks(held).held ? held : (this.pallets.find((p) => this.onForks(p.id).resting)?.id ?? null);
      this.carried = { step: this.steps, id };
    }
    return this.carried.id;
  }

  private itemsOn(id: string): string[] {
    const info = this.pallets.find((p) => p.id === id);
    if (!info) return [];
    const pose = this.pw.pose(id);
    return info.items.filter((item) => {
      const l = toLocal(pose, this.pw.pose(item).p);
      return Math.abs(l[0]) < 0.78 && Math.abs(l[1]) < 0.68 && l[2] > 0.1;
    });
  }

  private loadKg(id: string): number {
    let kg = PALLET.mass_kg;
    for (const item of this.itemsOn(id)) kg += this.pw.body(item).mass();
    return kg;
  }

  private restingIn(id: string): string | null {
    const pose = this.pw.pose(id);
    if (this.onForks(id).inside) return null;
    const v = this.pw.linvel(id);
    if (Math.hypot(v[0], v[1], v[2]) > 0.08) return null;
    for (const bay of this.bays) {
      const l = toLocal({ p: bay.p_m, q: qAxisAngle([0, 0, 1], bay.yaw_rad) }, pose.p);
      if (Math.abs(l[0]) < bay.size_m[0] / 2 && Math.abs(l[1]) < bay.size_m[1] / 2 && Math.abs(l[2]) < 0.12)
        return bay.id;
    }
    return null;
  }

  /**
   * What is in the truck's way within its stopping distance: three rays at bumper height, cast from the
   * fork tips or the far side of their load, since neither shows up in a ray. Returns the body's id.
   */
  private blockedBy(reverse: boolean, ignore: Set<string>, within_m?: number): string | null {
    const chassis = this.truck.chassisPose();
    const v = Math.abs(this.truck.state().v_mps);
    const range = within_m ?? 0.45 + (v * v) / (2 * TRUCK.decel_mps2);
    const front = TRUCK.forkHeel_m + TRUCK.forkLength_m + (this.carrying() ? 0.25 : 0.05);
    const dir = transform({ p: [0, 0, 0], q: chassis.q }, [reverse ? -1 : 1, 0, 0]);
    for (const y of [-0.5, 0, 0.5]) {
      const o = transform(chassis, [reverse ? -1.2 : front, y, -0.25]);
      const hit = this.pw.castRay(o[0], o[1], o[2], dir[0], dir[1], dir[2], range, TRUCK_GROUP);
      if (!hit) continue;
      const id = this.pw.ids[hit.body] as string;
      if (!ignore.has(id)) return id;
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  admit(_embodiment: string, type: string, params: Record<string, unknown>): AdmitVerdict {
    if (this.truck.tipped && type !== "stop")
      return { error: "AWP_BUSY", detail: "the truck has tipped over; reset the world", retryable: false };
    const inYard = (x: unknown, y: unknown) =>
      typeof x === "number" &&
      typeof y === "number" &&
      x >= BOUNDS.min[0] &&
      x <= BOUNDS.max[0] &&
      y >= BOUNDS.min[1] &&
      y <= BOUNDS.max[1];
    const outside = (x: unknown, y: unknown): AdmitVerdict => ({
      error: "AWP_ENVELOPE_EXCEEDED",
      detail: `(${x}, ${y}) is outside the yard, x ${BOUNDS.min[0]}..${BOUNDS.max[0]} and y ${BOUNDS.min[1]}..${BOUNDS.max[1]}`,
    });
    switch (type) {
      case "drive_to":
        return inYard(params.x_m, params.y_m) ? { ok: true } : outside(params.x_m, params.y_m);
      case "pick_pallet": {
        const id = params.pallet as string;
        if (!this.pw.has(id) || !/^(pallet|spare)_\d+$/.test(id))
          return { error: "AWP_PARAMS_INVALID", detail: `no pallet ${id}` };
        return { ok: true };
      }
      case "place_pallet": {
        if (typeof params.bay === "string") {
          if (!this.bays.some((b) => b.id === params.bay))
            return { error: "AWP_PARAMS_INVALID", detail: `no bay ${params.bay}` };
          return { ok: true };
        }
        if (typeof params.x_m !== "number" || typeof params.y_m !== "number")
          return { error: "AWP_PARAMS_INVALID", detail: "give a bay, or x_m and y_m" };
        return inYard(params.x_m, params.y_m) ? { ok: true } : outside(params.x_m, params.y_m);
      }
      default:
        return { ok: true };
    }
  }

  start(_embodiment: string, type: string, params: Record<string, unknown>): ActionRun {
    switch (type) {
      case "drive_to":
        return this.driveTo(params);
      case "set_forks":
        return this.setForks(params);
      case "pick_pallet":
        return this.pick(params.pallet as string);
      case "place_pallet":
        return this.place(params);
      case "teleop":
        return this.teleop();
      default:
        return {
          update: () => {
            this.truck.halt();
            this.target = null;
            return { done: true };
          },
        };
    }
  }

  safeStop(): void {
    this.truck.halt();
  }

  /** Stopping from full speed, with a margin: how long a safe abort takes. */
  private stopMs(): number {
    return Math.round((Math.abs(this.truck.state().v_mps) / TRUCK.decel_mps2) * 1000) + 300;
  }

  private tippedFailure(): RunStatus | undefined {
    return this.truck.tipped ? { failed: "x-yard.tipped", detail: "the truck went over" } : undefined;
  }

  /** One leg of driving, shared by `drive_to` and the pallet actions. */
  private leg(target: Target, ignore: Set<string> = new Set(), guard = true): () => StepResult {
    let follower: Follower | undefined;
    let blockedFor = 0;
    let stuckFor = 0;
    let reversing = () => !!target.reverse;
    return () => {
      if (!follower) {
        const route = guard && !target.reverse ? this.route(target, ignore) : [];
        if (!route)
          return {
            failed: "x-yard.blocked",
            detail: `there is no clear way to (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`,
          };
        follower = new Follower({ ...target, route, gentle: this.truck.loaded }, this.kin());
        this.path = route.length > 0 ? [...route.flatMap((l) => l.points), [target.x, target.y]] : null;
        reversing = () => follower?.reversing ?? !!target.reverse;
      }
      this.target = { x_m: target.x, y_m: target.y, ...(target.yaw === undefined ? {} : { yaw_rad: target.yaw }) };
      const k = this.kin();
      const cmd = follower.step(k);
      if (cmd.arrived) {
        this.truck.setpoint.v_mps = 0;
        this.truck.setpoint.steer_rad = 0;
        return Math.abs(k.v) < 0.05 ? "next" : "busy";
      }
      const dt = 1 / 60;
      // Something within stopping distance slows the truck to a crawl; within arm's reach, it waits, then gives up.
      const near = guard ? this.blockedBy(reversing(), ignore, 0.35) : null;
      const ahead = guard && !near ? this.blockedBy(reversing(), ignore) : near;
      blockedFor = near ? blockedFor + dt : 0;
      // Not moving at even a quarter of what was asked, with nothing seen ahead: it is up against something.
      stuckFor = Math.abs(k.v) < Math.min(0.03, Math.abs(cmd.v_mps) * 0.25) && !near ? stuckFor + dt : 0;
      if (blockedFor > 2) return { failed: "x-yard.blocked", detail: `${near} is in the way` };
      if (stuckFor > 4)
        return { failed: "x-yard.blocked", detail: "the truck is pushing against something and not moving" };
      this.truck.setpoint.v_mps = near
        ? 0
        : ahead
          ? Math.sign(cmd.v_mps) * Math.min(Math.abs(cmd.v_mps), 0.4)
          : cmd.v_mps;
      this.truck.setpoint.steer_rad = cmd.steer_rad;
      return "busy";
    };
  }

  /**
   * A route to where a leg's own steering takes over: the target, or a point on the line into it, a
   * little before it and heading along it. Empty when the truck is already lined up; null when there is
   * no way.
   */
  private route(target: Target, ignore: Set<string>): Leg[] | null {
    const k = this.kin();
    let goal: RoutePose = { x: target.x, y: target.y };
    if (target.yaw !== undefined) {
      const dx = Math.cos(target.yaw);
      const dy = Math.sin(target.yaw);
      const along = (target.x - k.x) * dx + (target.y - k.y) * dy;
      const cross = (k.y - target.y) * dx - (k.x - target.x) * dy;
      if (along > 1 && Math.abs(cross) < 0.5 && Math.abs(wrapAngle(target.yaw - k.yaw)) < 0.4) return [];
      goal = { x: target.x - dx * JOIN_M, y: target.y - dy * JOIN_M, yaw: target.yaw };
    }
    if (Math.hypot(goal.x - k.x, goal.y - k.y) < 1 && target.yaw === undefined) return [];
    // Planned against the site map and what the truck has seen, where it last saw it. Anything else
    // in the way is for the bumper rays to find.
    const obstacles: Footprint[] = [];
    const footprint = (body: BodyDesc | LayoutBody, pose: BodyPose) => {
      const { lo, hi } = extent(body);
      const centre = transform(pose, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0]);
      obstacles.push({
        x: centre[0],
        y: centre[1],
        hx: (hi[0] - lo[0]) / 2,
        hy: (hi[1] - lo[1]) / 2,
        yaw: yawOf(pose.q),
      });
    };
    for (const b of this.statics)
      if (b.type !== "ground" && b.type !== "wall") footprint(b, { p: b.p, q: b.q ?? [0, 0, 0, 1] });
    const layout = new Map(this.pw.layout().map((b) => [b.id, b]));
    for (const [id, entry] of this.seen) if (!ignore.has(id)) footprint(layout.get(id) as LayoutBody, entry.pose);
    return planRoute(k, goal, obstacles, this.truck.loaded);
  }

  /** Move the mast and wait for it; fails if the hoist stalls. */
  private mast(height: () => number | undefined, tilt?: number): () => StepResult {
    let set = false;
    return () => {
      if (!set) {
        const h = height();
        if (h !== undefined) this.truck.liftGoal_m = Math.max(0, Math.min(TRUCK.liftMax_m, h));
        if (tilt !== undefined) this.truck.tiltGoal_rad = tilt;
        set = true;
      }
      if (this.truck.stalled) {
        this.truck.liftGoal_m = Math.max(0, this.truck.state().fork_height_m - 0.05);
        return {
          failed: "x-yard.overload",
          detail: `the hoist cannot lift this: it is pushing ${TRUCK.liftForce_n} N, its limit`,
        };
      }
      return this.truck.liftSettled && this.truck.tiltSettled ? "next" : "busy";
    };
  }

  private sequence(steps: (() => StepResult)[], usesMast: boolean): ActionRun {
    let i = 0;
    if (usesMast) this.mastOwner = "macro";
    const end = () => {
      if (usesMast && this.mastOwner === "macro") this.mastOwner = undefined;
      this.target = null;
      this.path = null;
    };
    return {
      update: (): RunStatus => {
        const tipped = this.tippedFailure();
        if (tipped) {
          end();
          return tipped;
        }
        const step = steps[i];
        if (!step) {
          end();
          return { done: true };
        }
        const r = step();
        if (r === "next") i++;
        else if (r !== "busy") {
          this.truck.halt();
          end();
          return r;
        }
        if (i >= steps.length) {
          end();
          return { done: true };
        }
        return { progress: i / steps.length };
      },
      abort: () => {
        const ms = this.stopMs();
        this.truck.halt();
        end();
        return ms;
      },
    };
  }

  private driveTo(params: Record<string, unknown>): ActionRun {
    const target: Target = {
      x: params.x_m as number,
      y: params.y_m as number,
      vMax: Math.min((params.max_velocity_mps as number | undefined) ?? 2, TRUCK.maxSpeed_mps),
      ...(typeof params.yaw_rad === "number" ? { yaw: params.yaw_rad } : {}),
      reverse: params.reverse === true,
    };
    const carried = this.carrying();
    const ignore = new Set(carried ? [carried, ...this.itemsOn(carried)] : []);
    const leg = this.leg(target, ignore);
    let follower: Follower | undefined;
    const run = this.sequence([leg], false);
    return {
      ...run,
      update: () => {
        follower ??= new Follower(target, this.kin());
        const status = run.update(0);
        return "progress" in status ? { progress: follower.progress(this.kin()) } : status;
      },
    };
  }

  private setForks(params: Record<string, unknown>): ActionRun {
    if (this.mastOwner === "macro")
      return { update: () => ({ failed: "x-yard.busy", detail: "a pallet action is using the mast" }) };
    this.mastOwner = "set_forks";
    const from = this.truck.state().fork_height_m;
    const to = params.height_m as number;
    const step = this.mast(() => to, params.tilt_rad as number | undefined);
    const release = () => {
      if (this.mastOwner === "set_forks") this.mastOwner = undefined;
    };
    return {
      update: (): RunStatus => {
        if (this.mastOwner !== "set_forks") return { failed: "x-yard.busy", detail: "a pallet action took the mast" };
        const r = step();
        if (r === "busy") {
          const span = Math.abs(to - from) || 1;
          return { progress: Math.min(1, Math.abs(this.truck.state().fork_height_m - from) / span) };
        }
        release();
        return r === "next" ? { done: true } : r;
      },
      abort: () => {
        this.truck.liftGoal_m = this.truck.state().fork_height_m;
        this.truck.tiltGoal_rad = this.truck.state().tilt_rad;
        release();
        return 300;
      },
    };
  }

  /** The truck heading that enters a pallet's pockets from the end nearer the truck. */
  private entryYaw(palletPose: BodyPose): number {
    const yaw = yawOf(palletPose.q);
    const k = this.kin();
    const behind = (k.x - palletPose.p[0]) * Math.cos(yaw) + (k.y - palletPose.p[1]) * Math.sin(yaw);
    return behind < 0 ? yaw : wrapAngle(yaw + Math.PI);
  }

  private pick(id: string): ActionRun {
    // Where the truck last saw the pallet: all it has to go on until the pallet is in view again.
    let pose: BodyPose = this.seen.get(id)?.pose ?? { p: [0, 0, 0], q: [0, 0, 0, 1] };
    let yaw = 0;
    const ignore = new Set([id, ...(this.pallets.find((p) => p.id === id)?.items ?? [])]);
    const unseen = (detail: string): StepResult => ({ failed: "x-yard.unseen", detail });
    const at = (back: number): Target => ({
      x: pose.p[0] - Math.cos(yaw) * back,
      y: pose.p[1] - Math.sin(yaw) * back,
      yaw,
      vMax: 2,
    });
    let approach: (() => StepResult) | undefined;
    let insert: (() => StepResult) | undefined;
    let retreat: (() => StepResult) | undefined;
    const raised = () => pose.p[2] > 0.3;
    return this.sequence(
      [
        () => {
          if (this.carrying()) return { failed: "x-yard.busy", detail: `the forks already hold ${this.carrying()}` };
          this.perceive();
          const known = this.seen.get(id);
          if (!known) return unseen(`the truck's sensors have not seen ${id}: drive to where they can`);
          pose = known.pose;
          yaw = this.entryYaw(pose);
          return "next";
        },
        // Out to the line of the pockets with the forks coming down to their height.
        () => {
          this.truck.liftGoal_m = Math.max(0, pose.p[2] - 0.005);
          this.truck.tiltGoal_rad = 0;
          approach ??= this.leg({ ...at(ENGAGED_M + 1.6), tolerance: 0.1, precise: true }, ignore);
          return approach();
        },
        this.mast(() => undefined),
        // Lined up and close: the forks go in on what the sensors show now, not on a memory.
        () => {
          this.perceive();
          const known = this.seen.get(id);
          if (!known?.visible) return unseen(`${id} is not where the truck last saw it`);
          pose = known.pose;
          return "next";
        },
        () => {
          insert ??= this.leg({ ...at(ENGAGED_M), vMax: 0.45, tolerance: 0.03 }, ignore, false);
          return insert();
        },
        this.mast(() => this.truck.liftGoal_m + 0.3, 0.07),
        () =>
          this.carrying() === id ? "next" : { failed: "x-yard.missed", detail: `the forks came up without ${id}` },
        // Back straight out, clear of the neighbours, before turning; off a trailer, before lowering too.
        () => {
          const k = this.kin();
          retreat ??= this.leg(
            {
              x: k.x - Math.cos(yaw) * 1.6,
              y: k.y - Math.sin(yaw) * 1.6,
              yaw,
              vMax: 0.8,
              reverse: true,
              tolerance: 0.1,
            },
            ignore,
          );
          return retreat();
        },
        this.mast(() => (raised() ? 0.3 : undefined)),
      ],
      true,
    );
  }

  private place(params: Record<string, unknown>): ActionRun {
    const bay = typeof params.bay === "string" ? this.bays.find((b) => b.id === params.bay) : undefined;
    const p: Vec3 = bay ? bay.p_m : [params.x_m as number, params.y_m as number, 0];
    const yaw = bay ? bay.yaw_rad : ((params.yaw_rad as number | undefined) ?? this.kin().yaw);
    const at = (back: number): Target => ({
      x: p[0] - Math.cos(yaw) * back,
      y: p[1] - Math.sin(yaw) * back,
      yaw,
      vMax: 1.6,
    });
    const ignore = new Set<string>();
    let approach: (() => StepResult) | undefined;
    let insert: (() => StepResult) | undefined;
    let retreat: (() => StepResult) | undefined;
    return this.sequence(
      [
        () => {
          const id = this.carrying();
          if (!id) return { failed: "x-yard.empty", detail: "there is no pallet on the forks" };
          ignore.add(id);
          for (const item of this.itemsOn(id)) ignore.add(item);
          return "next";
        },
        () => {
          // Short of a raised surface by enough to lift the load clear before going in.
          approach ??= this.leg({ ...at(ENGAGED_M + (p[2] > 0.1 ? 2.2 : 1.2)), tolerance: 0.1, precise: true }, ignore);
          return approach();
        },
        this.mast(() => (p[2] > 0.1 ? p[2] + 0.2 : undefined)),
        () => {
          insert ??= this.leg({ ...at(ENGAGED_M), vMax: 0.4, tolerance: 0.04 }, ignore, false);
          return insert();
        },
        this.mast(() => p[2] + 0.06, 0),
        this.mast(() => p[2] - 0.005),
        () => {
          const k = this.kin();
          retreat ??= this.leg(
            {
              x: k.x - Math.cos(yaw) * 1.8,
              y: k.y - Math.sin(yaw) * 1.8,
              yaw,
              vMax: 0.7,
              reverse: true,
              tolerance: 0.1,
            },
            ignore,
            false,
          );
          return retreat();
        },
        this.mast(() => (p[2] > 0.3 ? 0.15 : undefined)),
      ],
      true,
    );
  }

  private teleop(): ActionRun {
    this.target = null;
    return {
      update: (): RunStatus => this.tippedFailure() ?? {},
      // AWP-CMD-006: every setpoint is checked against the envelope before it acts. One asking for more
      // than the speed limit is dropped, and the truck keeps its last setpoint. Steering, hoist and tilt
      // are the machine's own limits, not the envelope's: it takes what it can of those.
      command: (payload) => {
        const s = payload as Partial<DriveSetpoint> | null;
        const fields = [s?.v_mps, s?.steer_rad, s?.lift_mps ?? 0, s?.tilt_radps ?? 0];
        if (!s || fields.some((v) => typeof v !== "number" || !Number.isFinite(v))) return { rejected: true };
        if (Math.abs(fields[0] as number) > TRUCK.maxSpeed_mps) return { rejected: true };
        const { setpoint } = Truck.limit(
          {
            v_mps: fields[0] as number,
            steer_rad: fields[1] as number,
            lift_mps: fields[2] as number,
            tilt_radps: fields[3] as number,
          },
          this.truck.state().v_mps,
        );
        this.truck.setpoint = setpoint;
        return {};
      },
      abort: () => {
        const ms = this.stopMs();
        this.truck.halt();
        return ms;
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Observations

  observe(channel: string): unknown {
    switch (channel) {
      case "proprio":
        return this.proprio();
      case "scene":
        return this.scene();
      case "task":
        return this.task.observe();
      case "awp.tf":
        return this.tf();
      case "depth":
        return { bytes: bytesOf(this.cameraFrame().depth) };
      case "rgb":
        return { bytes: this.cameraFrame().rgb };
      case "lidar":
        return { bytes: bytesOf(this.lidarFrame().points) };
      default:
        return null;
    }
  }

  private proprio(): Proprio {
    const s = this.truck.state();
    const carrying = this.carrying();
    const load_kg = carrying ? Math.round(this.loadKg(carrying)) : 0;
    return {
      pose: { frame: "world", p_m: r3v(s.base.p), q: r4q(s.base.q) },
      yaw_rad: r3(s.yaw_rad),
      v_mps: r3(s.v_mps),
      yaw_rate_radps: r3(s.yaw_rate_radps),
      steer_rad: r3(s.steer_rad),
      fork_height_m: r3(s.fork_height_m),
      tilt_rad: r3(s.tilt_rad),
      // The hoist's load cell: the carriage and what rests on it, or its limit when it has stalled.
      lift_force_n: s.stalled ? TRUCK.liftForce_n : Math.round((150 + load_kg) * G),
      load_kg,
      carrying,
      stalled: s.stalled,
      tipped: s.tipped,
      wheels_grounded: s.wheels_grounded,
    };
  }

  private tf() {
    const s = this.truck.state();
    return {
      transforms: [
        { frame: "base", parent: "world", p_m: r3v(s.base.p), q: r4q(s.base.q) },
        {
          frame: "forks",
          parent: "base",
          p_m: r3v([TRUCK.forkHeel_m, 0, Truck.forkFloor_m + s.fork_height_m]),
          q: r4q(qAxisAngle([0, 1, 0], -s.tilt_rad)),
        },
      ],
    };
  }

  private scene(): Scene {
    this.perceive();
    const s = this.truck.state();
    const carrying = this.carrying();
    const at = (p: BodyPose) => ({ frame: "world", p_m: r3v(p.p), q: r4q(p.q) });
    const entities: SceneEntity[] = [
      {
        id: EMBODIMENT,
        class: "forklift",
        pose: { frame: "world", p_m: r3v(s.base.p), q: r4q(s.base.q) },
        size_m: [2.3 + TRUCK.forkLength_m, 1.16, Truck.top_m],
        state: { yaw_rad: r3(s.yaw_rad), fork_height_m: r3(s.fork_height_m), carrying },
      },
    ];
    const relations: Scene["relations"] = [];
    // The site map: what is built here, and where pallets go. The truck knows it without looking.
    for (const b of this.statics) {
      if (b.type === "ground" || b.type === "lamp" || b.type === "wall") continue;
      entities.push({
        id: b.id,
        class: b.type,
        pose: at(this.pw.pose(b.id)),
        size_m: sizeOf(b),
        state: { source: "site_map" },
      });
    }
    for (const bay of this.bays) {
      entities.push({
        id: bay.id,
        class: "bay",
        pose: { frame: "world", p_m: bay.p_m, q: r4q(qAxisAngle([0, 0, 1], bay.yaw_rad)) },
        size_m: [bay.size_m[0], bay.size_m[1], 0],
        state: {
          source: "site_map",
          label: bay.label,
          surface_height_m: bay.p_m[2],
          approach_yaw_rad: r3(bay.yaw_rad),
        },
      });
    }
    entities.push({
      id: RECEIVING_PAD.id,
      class: "zone",
      pose: { frame: "world", p_m: RECEIVING_PAD.p_m, q: [0, 0, 0, 1] },
      size_m: [RECEIVING_PAD.size_m[0], RECEIVING_PAD.size_m[1], 0],
      state: { source: "site_map", label: RECEIVING_PAD.label },
    });
    // What the sensors pick out right now. Nothing here is remembered: out of sight, it is gone from the list.
    const layout = new Map(this.pw.layout().map((b) => [b.id, b]));
    for (const [id, entry] of this.seen) {
      if (!entry.visible) continue;
      const body = layout.get(id) as LayoutBody;
      const info = this.pallets.find((p) => p.id === id);
      entities.push({
        id,
        class: body.type,
        pose: at(entry.pose),
        size_m: body.type === "pallet" ? [PALLET.length_m, PALLET.width_m, PALLET.height_m] : sizeOf(body),
        ...(body.type === "pallet" ? { affordances: ["forkable"] } : {}),
        state: {
          source: "sensors",
          ...(info ? { label: info.label } : {}),
          ...(body.type === "pallet" ? { yaw_rad: r3(yawOf(entry.pose.q)) } : {}),
        },
      });
      if (carrying === id) relations.push({ type: "on_forks_of", subject: id, object: EMBODIMENT });
      // Which bay a pallet stands in is plain to see from where it is.
      const bay = body.type === "pallet" ? this.restingIn(id) : null;
      if (bay) relations.push({ type: "in", subject: id, object: bay });
    }
    return { entities, relations };
  }

  private sensorPose(mount: { chassis: Vec3; q: [number, number, number, number] }): BodyPose {
    return compose(this.truck.chassisPose(), { p: mount.chassis, q: mount.q });
  }

  private cameraFrame() {
    if (this.camera?.step !== this.steps) {
      const frame = castCamera(this.pw, this.sensorPose(SENSORS.camera), CAMERA, SHADING, TRUCK_GROUP);
      this.camera = { step: this.steps, ...frame };
    }
    return this.camera;
  }

  private lidarFrame() {
    if (this.lidar?.step !== this.steps) {
      const sweep = castLidar(
        this.pw,
        this.sensorPose(SENSORS.lidar),
        {
          rings_rad: LIDAR.rings_deg.map((d) => (d * Math.PI) / 180),
          azimuths: LIDAR.azimuths,
          maxRange_m: LIDAR.maxRange_m,
        },
        TRUCK_GROUP,
      );
      this.lidar = { step: this.steps, ...sweep };
    }
    return this.lidar;
  }

  /**
   * The truck's object detector: which movable things the camera's and the lidar's rays land on this
   * instant. It stands in for a perception stack, and a generous one: anything two rays touch is
   * recognised, with its tag read and its pose exact. What it cannot do is see through things, round
   * corners, or past the sensors' range. A load still on its pallet is seen as that pallet.
   */
  perceive(): void {
    if (this.perceivedAt === this.steps) return;
    this.perceivedAt = this.steps;
    const rays = new Map<number, number>();
    for (const b of this.cameraFrame().bodies) if (b >= 0) rays.set(b, (rays.get(b) ?? 0) + 1);
    for (const b of this.lidarFrame().bodies) rays.set(b, (rays.get(b) ?? 0) + 1);
    const units = new Map<string, number>();
    const layout = this.pw.layout();
    for (const [index, count] of rays) {
      const body = layout[index] as LayoutBody;
      if (body.fixed) continue;
      const pallet = this.loadOf.get(body.id);
      const unit = pallet && this.itemsOn(pallet).includes(body.id) ? pallet : body.id;
      units.set(unit, (units.get(unit) ?? 0) + count);
    }
    const carried = this.carrying();
    if (carried) units.set(carried, SEEN_ON_RAYS);
    for (const entry of this.seen.values()) entry.visible = false;
    for (const [id, count] of units) {
      if (count >= SEEN_ON_RAYS) this.seen.set(id, { pose: this.pw.pose(id), t_s: this.time_s, visible: true });
    }
  }

  // -------------------------------------------------------------------------------------------
  // UI

  view(): YardView {
    const n = this.pw.ids.length;
    const poses = new Float32Array((n + this.extras.length) * POSE_STRIDE);
    this.pw.poses(poses);
    this.truck.extraPoses().forEach((pose, i) => {
      poses.set([...pose.p, ...pose.q], (n + i) * POSE_STRIDE);
    });
    const s = this.truck.state();
    const carrying = this.carrying();
    return {
      key: this.key,
      step: this.steps,
      t_ms: Math.round(this.time_s * 1000),
      poses: packFloats(poses),
      truck: {
        v_mps: r3(s.v_mps),
        steer_rad: r3(s.steer_rad),
        fork_height_m: r3(s.fork_height_m),
        tilt_rad: r3(s.tilt_rad),
        load_kg: carrying ? Math.round(this.loadKg(carrying)) : 0,
        carrying,
        stalled: s.stalled,
        tipped: s.tipped,
      },
      task: this.task.view(),
      target: this.target,
      path: this.path,
    };
  }

  staticView(): YardLayout {
    return {
      key: this.key,
      bodies: [...this.pw.layout(), ...this.extras],
      bays: this.bays,
      bounds: BOUNDS,
      sensors: {
        camera: { p_m: SENSORS.camera.chassis, q: [...SENSORS.camera.q] },
        lidar: { p_m: SENSORS.lidar.chassis, q: [...SENSORS.lidar.q] },
      },
      truck: EMBODIMENT,
    };
  }

  /** What the truck's sensors see now, for the UI's overlay. */
  sensorsView(): SensorsView {
    const chassis = this.truck.chassisPose();
    const cam = this.cameraFrame();
    return {
      step: this.steps,
      chassis: { p_m: chassis.p, q: chassis.q },
      depth: packFloats(cam.depth),
      rgb: toBase64(cam.rgb),
      lidar: packFloats(this.lidarFrame().points),
      seen: [...this.seen].filter(([, e]) => e.visible).map(([id]) => id),
    };
  }
}

function bytesOf(values: Float32Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}
