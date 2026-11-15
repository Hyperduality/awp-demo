import { type Pose, QID, type Quat, qAxisAngle, qMul, type Vec3 } from "./math.ts";
import { POSE_STRIDE } from "./quant.ts";
import { initRapier, type RAPIER, type Rapier } from "./rapier.ts";
import type { BodyDesc, LayoutBody, SceneDesc } from "./scene.ts";

/** How much shorter a moving cylinder's collider is than the prisms that give it feet. */
const END_INSET_M = 0.006;

export interface PhysicsOptions {
  /** Fixed step in seconds (default 1/120). */
  dt_s?: number;
  solverIterations?: number;
}

/** Something that acts on the world before every step and survives a restore, such as a vehicle. */
export interface Stepper {
  preStep(dt_s: number): void;
  /** Rebuild whatever a snapshot does not carry. */
  rebuild(): void;
}

/** One ray hit. The object is reused by the next cast. */
export interface RayHit {
  toi: number;
  nx: number;
  ny: number;
  nz: number;
  /** Index into `PhysicsWorld.ids`. */
  body: number;
  /** Index into `PhysicsWorld.materials`. */
  material: number;
}

export interface Impact {
  a: string;
  b: string;
  force_n: number;
}

export interface Snapshot {
  world: Uint8Array;
  steps: number;
}

/**
 * A Rapier world built from a declarative scene. Bodies keep the order they were added in, so a pose
 * array, a layout and a hash all index the same way, and the same scene and inputs always give the
 * same state.
 */
export class PhysicsWorld {
  readonly ids: string[] = [];
  readonly materials: string[] = [];
  readonly dt_s: number;
  world: RAPIER.World;
  steps = 0;

  private readonly handles: number[] = [];
  private readonly index = new Map<string, number>();
  private readonly layouts: LayoutBody[] = [];
  private readonly colliders = new Map<number, { body: number; material: number }>();
  private readonly steppers: Stepper[] = [];
  private readonly restoreHooks: (() => void)[] = [];
  private readonly events: RAPIER.EventQueue;
  private readonly ray: RAPIER.Ray;
  private readonly hit: RayHit = { toi: 0, nx: 0, ny: 0, nz: 0, body: 0, material: 0 };
  private pending: Impact[] = [];

  readonly R: Rapier;

  private constructor(R: Rapier, gravity: Vec3, opts: PhysicsOptions) {
    this.R = R;
    this.dt_s = opts.dt_s ?? 1 / 120;
    this.world = new R.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
    this.world.timestep = this.dt_s;
    this.world.numSolverIterations = opts.solverIterations ?? 8;
    this.events = new R.EventQueue(true);
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  }

  static async create(scene: SceneDesc, opts: PhysicsOptions = {}): Promise<PhysicsWorld> {
    const pw = new PhysicsWorld(await initRapier(), scene.gravity ?? [0, 0, -9.81], opts);
    for (const body of scene.bodies) pw.add(body);
    return pw;
  }

  add(desc: BodyDesc): number {
    if (this.index.has(desc.id)) throw new Error(`duplicate body id ${desc.id}`);
    const R = this.R;
    const q = desc.q ?? QID;
    const bd = (desc.kind === "fixed" ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
      .setTranslation(desc.p[0], desc.p[1], desc.p[2])
      .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
      .setCanSleep(desc.canSleep ?? true)
      .setCcdEnabled(desc.ccd ?? false)
      .setAdditionalSolverIterations(desc.extraSolverIterations ?? 0);
    if (desc.mass) {
      const { mass_kg, com, inertia } = desc.mass;
      bd.setAdditionalMassProperties(
        mass_kg,
        { x: com[0], y: com[1], z: com[2] },
        { x: inertia[0], y: inertia[1], z: inertia[2] },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    }
    const body = this.world.createRigidBody(bd);
    const i = this.ids.length;
    this.ids.push(desc.id);
    this.handles.push(body.handle);
    this.index.set(desc.id, i);

    // Everything is in group 0 unless it is part of a machine, whose parts share a group and skip each other.
    const bit = desc.group ? 1 << desc.group : 0;
    const groups = (((bit || 1) << 16) | (0xffff & ~bit)) >>> 0;
    const layout: LayoutBody = { id: desc.id, type: desc.type, fixed: desc.kind === "fixed", p: desc.p, q, parts: [] };
    for (const part of desc.parts) {
      const at = part.at ?? [0, 0, 0];
      const rot = part.rot ?? QID;
      layout.parts.push({ shape: part.shape, at, rot, material: part.material });
      if (part.visual) continue;
      const s = part.shape;
      const cd = (
        s.kind === "box"
          ? R.ColliderDesc.cuboid(s.half[0], s.half[1], s.half[2])
          : s.kind === "cone"
            ? R.ColliderDesc.cone(s.halfHeight, s.radius)
            : R.ColliderDesc.cylinder(s.halfHeight - (desc.kind === "dynamic" ? END_INSET_M : 0), s.radius)
      )
        .setTranslation(at[0], at[1], at[2])
        .setRotation({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] })
        .setFriction(part.friction ?? 0.6)
        .setRestitution(0)
        .setCollisionGroups(groups);
      if (desc.mass) cd.setDensity(0);
      else if (desc.kind === "dynamic") cd.setMass(part.mass_kg ?? 1);
      if (part.contactForce_n !== undefined) {
        cd.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(part.contactForce_n);
      }
      let material = this.materials.indexOf(part.material);
      if (material < 0) material = this.materials.push(part.material) - 1;
      this.colliders.set(this.world.createCollider(cd, body).handle, { body: i, material });
      if (s.kind === "cylinder" && desc.kind === "dynamic") {
        // A cylinder's flat end meets a flat surface at a single point, and a drum standing on one point
        // never comes to rest. Two weightless square prisms inside it, one turned 45 degrees, give its
        // ends eight corners to stand on; the cylinder, a hair shorter, still does the rolling.
        const side = s.radius * 0.69;
        for (const turn of [0, Math.PI / 4]) {
          const q = qMul(rot, qAxisAngle([0, 1, 0], turn));
          const foot = R.ColliderDesc.cuboid(side, s.halfHeight, side)
            .setTranslation(at[0], at[1], at[2])
            .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
            .setFriction(part.friction ?? 0.6)
            .setRestitution(0)
            .setCollisionGroups(groups)
            .setDensity(0);
          this.colliders.set(this.world.createCollider(foot, body).handle, { body: i, material });
        }
      }
    }
    this.layouts.push(layout);
    return i;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  indexOf(id: string): number {
    const i = this.index.get(id);
    if (i === undefined) throw new Error(`no body ${id}`);
    return i;
  }

  body(id: string | number): RAPIER.RigidBody {
    const handle = this.handles[typeof id === "number" ? id : this.indexOf(id)];
    return this.world.getRigidBody(handle as number);
  }

  pose(id: string | number): Pose {
    const b = this.body(id);
    const t = b.translation();
    const r = b.rotation();
    return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
  }

  linvel(id: string | number): Vec3 {
    const v = this.body(id).linvel();
    return [v.x, v.y, v.z];
  }

  angvel(id: string | number): Vec3 {
    const v = this.body(id).angvel();
    return [v.x, v.y, v.z];
  }

  sleeping(id: string | number): boolean {
    const b = this.body(id);
    return b.isFixed() || b.isSleeping();
  }

  attach(stepper: Stepper): void {
    this.steppers.push(stepper);
  }

  /** Run after a restore, for holders of joints and other handles into the old world. */
  onRestore(fn: () => void): void {
    this.restoreHooks.push(fn);
  }

  step(): void {
    for (const s of this.steppers) s.preStep(this.dt_s);
    this.world.step(this.events);
    this.events.drainContactForceEvents((e) => {
      const a = this.colliders.get(e.collider1());
      const b = this.colliders.get(e.collider2());
      if (a && b)
        this.pending.push({
          a: this.ids[a.body] as string,
          b: this.ids[b.body] as string,
          force_n: e.totalForceMagnitude(),
        });
    });
    this.steps++;
  }

  /** Contact forces above their parts' thresholds since the last call. */
  impacts(): Impact[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /**
   * The nearest hit along a ray, or null. `dir` must be a unit vector. The returned object is reused.
   * Rays see the world as of the last step, so a body added since is not there yet.
   * `skipGroup` hides one machine's parts, usually the machine the sensor is mounted on.
   */
  castRay(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    max_m: number,
    skipGroup = 0,
  ): RayHit | null {
    const { origin, dir } = this.ray;
    origin.x = ox;
    origin.y = oy;
    origin.z = oz;
    dir.x = dx;
    dir.y = dy;
    dir.z = dz;
    const r = this.world.castRayAndGetNormal(this.ray, max_m, true, undefined, rayGroups(skipGroup));
    if (!r) return null;
    const info = this.colliders.get(r.collider.handle);
    if (!info) return null;
    const hit = this.hit;
    hit.toi = r.timeOfImpact;
    hit.nx = r.normal.x;
    hit.ny = r.normal.y;
    hit.nz = r.normal.z;
    hit.body = info.body;
    hit.material = info.material;
    return hit;
  }

  /** Whether anything lies within `max_m` along the ray. */
  occluded(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    max_m: number,
    skipGroup = 0,
  ): boolean {
    const { origin, dir } = this.ray;
    origin.x = ox;
    origin.y = oy;
    origin.z = oz;
    dir.x = dx;
    dir.y = dy;
    dir.z = dz;
    return this.world.castRay(this.ray, max_m, true, undefined, rayGroups(skipGroup)) !== null;
  }

  /** Every body's pose, seven float32 each, in `ids` order. */
  poses(out = new Float32Array(this.ids.length * POSE_STRIDE)): Float32Array {
    for (let i = 0; i < this.handles.length; i++) {
      const b = this.world.getRigidBody(this.handles[i] as number);
      const t = b.translation();
      const r = b.rotation();
      const o = i * POSE_STRIDE;
      out[o] = t.x;
      out[o + 1] = t.y;
      out[o + 2] = t.z;
      out[o + 3] = r.x;
      out[o + 4] = r.y;
      out[o + 5] = r.z;
      out[o + 6] = r.w;
    }
    return out;
  }

  layout(): LayoutBody[] {
    return this.layouts;
  }

  /** A digest of every pose at full precision: equal hashes mean bit-identical states. */
  hash(): string {
    const f = new Float64Array(7);
    const bytes = new Uint8Array(f.buffer);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (const handle of this.handles) {
      const b = this.world.getRigidBody(handle);
      const t = b.translation();
      const r = b.rotation();
      f[0] = t.x;
      f[1] = t.y;
      f[2] = t.z;
      f[3] = r.x;
      f[4] = r.y;
      f[5] = r.z;
      f[6] = r.w;
      for (let i = 0; i < bytes.length; i++) {
        h1 = Math.imul(h1 ^ (bytes[i] as number), 0x01000193);
        h2 = Math.imul(h2 + (bytes[i] as number), 0x85ebca6b) ^ (h2 >>> 13);
      }
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }

  snapshot(): Snapshot {
    return { world: this.world.takeSnapshot(), steps: this.steps };
  }

  /** Return to a snapshot of this same scene. Body and collider handles carry over; vehicles are rebuilt. */
  restore(snapshot: Snapshot): void {
    this.world.free();
    this.world = this.R.World.restoreSnapshot(snapshot.world);
    this.steps = snapshot.steps;
    this.pending = [];
    for (const s of this.steppers) s.rebuild();
    for (const fn of this.restoreHooks) fn();
  }

  free(): void {
    this.world.free();
    this.events.free();
  }
}

function rayGroups(skipGroup: number): number {
  return ((0xffff << 16) | (0xffff & ~(skipGroup ? 1 << skipGroup : 0))) >>> 0;
}

export function quatOf(r: { x: number; y: number; z: number; w: number }): Quat {
  return [r.x, r.y, r.z, r.w];
}
