import { clamp, compose, type Pose, qAxisAngle, qMul, rotate, type Vec3 } from "./math.ts";
import type { PhysicsWorld, Stepper } from "./world.ts";

export interface WheelDesc {
  /** Where the suspension meets the chassis, in the chassis frame. */
  at: Vec3;
  radius_m: number;
  /** Suspension length with no load on it. */
  rest_m: number;
  drive?: boolean;
  steer?: boolean;
}

export interface VehicleDesc {
  wheels: WheelDesc[];
  /** The machine's collision group, so the suspension rays pass through its own parts. */
  group: number;
  /** Bounce frequency of the chassis on its springs, Hz. Four wheels sag g / (2 pi f)^2 at rest. */
  frequency_hz: number;
  /** Damping ratio of the suspension: 1 is critical. */
  damping: number;
  /** How far a wheel moves either side of rest. */
  travel_m: number;
  /** Tyre grip: the most a wheel pushes sideways or along, as a multiple of the load on it. */
  grip: number;
  /** Rolling drag per wheel, newtons per metre a second. */
  rolling: number;
}

/** Steps over which a tyre takes up its slip. */
const SLIP_STEPS = 4;

interface WheelState {
  length: number;
  grounded: boolean;
  load_n: number;
  spin: number;
  steer: number;
}

/**
 * A raycast vehicle: each wheel is a suspension ray under the chassis, not a body, which is what keeps a
 * heavy machine stable at a 120 Hz step. The chassis is x forward, z up.
 *
 * Springs, drive and tyre grip are applied as forces at the contact points, so the solver integrates
 * them together with gravity. Impulses applied ahead of the step, as Rapier's own controller does, leave
 * the chassis buzzing at the step rate, and anything resting on the machine slowly walks off it.
 */
export class RaycastVehicle implements Stepper {
  /** Total drive force, shared by the driven wheels; negative reverses. */
  engineForce_n = 0;
  /**
   * Steering as a bicycle would have it: the yaw rate is v tan(steer) / wheelbase, positive turning left.
   * Each steered wheel gets its own angle about the turning centre this implies (Ackermann), or the pair
   * would fight each other through their grip and a tight turn would lock up.
   */
  steer_rad = 0;
  /** Braking force per wheel, newtons. */
  brake_n = 0;

  readonly desc: VehicleDesc;
  private readonly pw: PhysicsWorld;
  private readonly chassis: number;
  private readonly driven: number;
  private readonly fixedAxle: number;
  private readonly steerAxle: number;
  private readonly wheels: WheelState[];
  private pushed: number[] = [];

  constructor(pw: PhysicsWorld, chassis: number, desc: VehicleDesc) {
    this.pw = pw;
    this.chassis = chassis;
    this.desc = desc;
    this.driven = Math.max(1, desc.wheels.filter((w) => w.drive).length);
    const mean = (ws: WheelDesc[]) => ws.reduce((sum, w) => sum + w.at[0], 0) / Math.max(1, ws.length);
    this.fixedAxle = mean(desc.wheels.filter((w) => !w.steer));
    this.steerAxle = mean(desc.wheels.filter((w) => w.steer));
    this.wheels = desc.wheels.map((w) => ({ length: w.rest_m, grounded: false, load_n: 0, spin: 0, steer: 0 }));
    pw.attach(this);
  }

  /** Nothing to rebuild: the forces are recomputed every step from the bodies alone. */
  rebuild(): void {}

  preStep(dt_s: number): void {
    const d = this.desc;
    const pw = this.pw;
    const body = pw.body(this.chassis);
    body.resetForces(false);
    body.resetTorques(false);
    for (const i of this.pushed) pw.body(i).resetForces(false);
    this.pushed = [];

    const pose = pw.pose(this.chassis);
    const lv = body.linvel();
    const av = body.angvel();
    const share = body.mass() / d.wheels.length;
    const omega = 2 * Math.PI * d.frequency_hz;
    const k = share * omega * omega;
    const c = 2 * d.damping * share * omega;
    const down = rotate(pose.q, [0, 0, -1]);
    const straight = Math.abs(this.steer_rad) < 1e-4;
    // The turning centre lies on the fixed axle's line, this far to the left.
    const centre = straight ? 0 : Math.abs(this.fixedAxle - this.steerAxle) / Math.tan(this.steer_rad);

    d.wheels.forEach((w, i) => {
      const state = this.wheels[i] as WheelState;
      state.steer = w.steer && !straight ? Math.atan((w.at[0] - this.fixedAxle) / (centre - w.at[1])) : 0;
      const o = rotate(pose.q, w.at);
      const ox = pose.p[0] + o[0];
      const oy = pose.p[1] + o[1];
      const oz = pose.p[2] + o[2];
      const reach = w.rest_m + d.travel_m + w.radius_m;
      const hit = pw.castRay(ox, oy, oz, down[0], down[1], down[2], reach, d.group);
      if (!hit) {
        state.grounded = false;
        state.load_n = 0;
        state.length = w.rest_m + d.travel_m;
        return;
      }
      const length = Math.max(w.rest_m - d.travel_m, hit.toi - w.radius_m);
      const n: Vec3 = [hit.nx, hit.ny, hit.nz];
      // The contact point, and how fast the chassis moves there.
      const r: Vec3 = [o[0] + down[0] * hit.toi, o[1] + down[1] * hit.toi, o[2] + down[2] * hit.toi];
      const v: Vec3 = [
        lv.x + av.y * r[2] - av.z * r[1],
        lv.y + av.z * r[0] - av.x * r[2],
        lv.z + av.x * r[1] - av.y * r[0],
      ];
      const closing = -(v[0] * n[0] + v[1] * n[1] + v[2] * n[2]);
      const load = Math.max(0, k * (w.rest_m - length) + c * closing);
      state.grounded = true;
      state.length = length;
      state.load_n = load;

      // The wheel's heading and its axle, both lying in the ground plane.
      const fwd = rotate(pose.q, [Math.cos(state.steer), Math.sin(state.steer), 0]);
      const dot = fwd[0] * n[0] + fwd[1] * n[1] + fwd[2] * n[2];
      let f: Vec3 = [fwd[0] - n[0] * dot, fwd[1] - n[1] * dot, fwd[2] - n[2] * dot];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      f = [f[0] / fl, f[1] / fl, f[2] / fl];
      const s: Vec3 = [n[1] * f[2] - n[2] * f[1], n[2] * f[0] - n[0] * f[2], n[0] * f[1] - n[1] * f[0]];
      const along = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
      const across = v[0] * s[0] + v[1] * s[1] + v[2] * s[2];
      state.spin += (along / w.radius_m) * dt_s;

      // A tyre pushes back in proportion to how fast it slips, up to what the load on it allows. The
      // rate is set so slip dies away over a few steps: cancelling it in one makes the forces chatter
      // at the step rate, and the chassis with them.
      const stiff = share / (dt_s * SLIP_STEPS);
      let side = -across * stiff;
      let push = (w.drive ? this.engineForce_n / this.driven : 0) - along * d.rolling;
      if (this.brake_n > 0) push += clamp(-along * stiff, -this.brake_n, this.brake_n);
      const limit = d.grip * load;
      const total = Math.hypot(side, push);
      if (total > limit) {
        side *= limit / total;
        push *= limit / total;
      }
      const fx = n[0] * load + f[0] * push + s[0] * side;
      const fy = n[1] * load + f[1] * push + s[1] * side;
      const fz = n[2] * load + f[2] * push + s[2] * side;
      const at = { x: pose.p[0] + r[0], y: pose.p[1] + r[1], z: pose.p[2] + r[2] };
      body.addForceAtPoint({ x: fx, y: fy, z: fz }, at, true);
      // Whatever is under the wheel is pushed back, if it can move.
      const under = pw.body(hit.body);
      if (under.isDynamic()) {
        under.addForceAtPoint({ x: -fx, y: -fy, z: -fz }, at, true);
        this.pushed.push(hit.body);
      }
    });
  }

  /** Signed ground speed along the chassis' heading. */
  speed_mps(): number {
    const [fx, fy] = rotate(this.pw.pose(this.chassis).q, [1, 0, 0]);
    const v = this.pw.body(this.chassis).linvel();
    return (v.x * fx + v.y * fy) / (Math.hypot(fx, fy) || 1);
  }

  grounded(i: number): boolean {
    return this.wheels[i]?.grounded ?? false;
  }

  /** The load the suspension is carrying at a wheel. */
  load_n(i: number): number {
    return this.wheels[i]?.load_n ?? 0;
  }

  /** The wheel's world pose for drawing: suspension travel, steering, then spin about its axle (local y). */
  wheelPose(i: number): Pose {
    const w = this.desc.wheels[i] as WheelDesc;
    const state = this.wheels[i] as WheelState;
    const q = qMul(qAxisAngle([0, 0, 1], state.steer), qAxisAngle([0, 1, 0], state.spin));
    return compose(this.pw.pose(this.chassis), { p: [w.at[0], w.at[1], w.at[2] - state.length], q });
  }
}
