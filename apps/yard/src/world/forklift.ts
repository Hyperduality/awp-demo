import {
  approach,
  type BodyDesc,
  boxInertia,
  clamp,
  compose,
  type LayoutBody,
  type PhysicsWorld,
  type Pose,
  QID,
  qAxisAngle,
  qYaw,
  type RAPIER,
  RaycastVehicle,
  toLocal,
  transform,
  upZ,
  type Vec3,
  type VehicleDesc,
  yawOf,
} from "@awp-demo/physics";

/** A 2.5 tonne counterbalance truck: front drive, rear steer, a tilting mast and a carriage with two forks. */
export const TRUCK = {
  mass_kg: 3600,
  wheelbase_m: 1.6,
  /** Chassis origin above the ground when at rest. */
  ride_m: 0.6,
  maxSpeed_mps: 3,
  accel_mps2: 1.5,
  decel_mps2: 2.5,
  maxSteer_rad: 1.2,
  steerRate_radps: 1.6,
  /** Steering narrows with speed to keep cornering under this. */
  maxLateral_mps2: 2.2,
  driveForce_n: 9000,
  parkForce_n: 20_000,
  liftMax_m: 3,
  liftRate_mps: 0.45,
  /** What the hoist can push: it stalls under more, about 2.4 t on the forks. */
  liftForce_n: 25_000,
  /** Positive tilts the mast back, towards the driver. */
  tiltBack_rad: 0.17,
  tiltForward_rad: 0.1,
  tiltRate_radps: 0.12,
  /** Past this lean the truck has tipped. */
  tipped_rad: 0.45,
  /** Fork blade: its heel is this far ahead of the chassis origin, and it is this long. */
  forkHeel_m: 1.415,
  forkLength_m: 1.075,
} as const;

const MAST_AT: Vec3 = [1.22, 0, -0.35];
const CARRIAGE_AT: Vec3 = [0.12, 0, 0.166];
/** Fork underside above the ground with the carriage down. */
const FORK_FLOOR_M = 0.055;
const TOP_M = 2.2;

const vehicle = (group: number): VehicleDesc => ({
  wheels: [
    { at: [0.8, 0.48, -0.14], radius_m: 0.33, rest_m: 0.15, drive: true },
    { at: [0.8, -0.48, -0.14], radius_m: 0.33, rest_m: 0.15, drive: true },
    { at: [-0.8, 0.44, -0.21], radius_m: 0.27, rest_m: 0.15, steer: true },
    { at: [-0.8, -0.44, -0.21], radius_m: 0.27, rest_m: 0.15, steer: true },
  ],
  group,
  // A forklift has almost no suspension: stiff tyres and a stiff axle.
  frequency_hz: 5,
  damping: 0.9,
  travel_m: 0.1,
  grip: 1.1,
  rolling: 60,
});

const WHEEL_NAMES = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"] as const;
const X90 = qAxisAngle([1, 0, 0], Math.PI / 2);

/** The truck's three rigid bodies, placed with the chassis over `at` on the ground. */
export function truckBodies(id: string, group: number, at: Vec3, yaw: number): BodyDesc[] {
  const base: Pose = { p: [at[0], at[1], at[2] + TRUCK.ride_m], q: qYaw(yaw) };
  const mast = compose(base, { p: MAST_AT, q: QID });
  const carriage = compose(mast, { p: CARRIAGE_AT, q: QID });
  const box = (half: Vec3, p: Vec3, material: string, extra: object = {}) => ({
    shape: { kind: "box" as const, half },
    at: p,
    material,
    ...extra,
  });
  const visual = { visual: true };
  return [
    {
      id,
      kind: "dynamic",
      type: "forklift",
      p: base.p,
      q: base.q,
      group,
      canSleep: false,
      // The counterweight puts the centre of mass low and behind the middle.
      mass: { mass_kg: TRUCK.mass_kg, com: [-0.3, 0, -0.2], inertia: boxInertia(TRUCK.mass_kg, [1.1, 0.55, 0.45]) },
      parts: [
        box([0.62, 0.56, 0.3], [0.38, 0, -0.15], "truck_paint", { friction: 0.4, contactForce_n: 30_000 }),
        box([0.5, 0.58, 0.45], [-0.68, 0, 0], "truck_iron", { friction: 0.4, contactForce_n: 30_000 }),
        box([0.65, 0.5, 0.025], [-0.1, 0, 1.58], "truck_frame"),
        // Hood, seat, dash, and the overhead guard's posts.
        box([0.3, 0.5, 0.12], [-0.05, 0, 0.27], "truck_paint", visual),
        box([0.22, 0.24, 0.06], [-0.1, 0, 0.45], "truck_seat", visual),
        box([0.04, 0.24, 0.26], [-0.34, 0, 0.7], "truck_seat", visual),
        box([0.05, 0.3, 0.2], [0.72, 0, 0.35], "truck_frame", visual),
        box([0.025, 0.025, 0.72], [0.52, 0.47, 0.86], "truck_frame", visual),
        box([0.025, 0.025, 0.72], [0.52, -0.47, 0.86], "truck_frame", visual),
        box([0.025, 0.025, 0.57], [-0.72, 0.47, 1.01], "truck_frame", visual),
        box([0.025, 0.025, 0.57], [-0.72, -0.47, 1.01], "truck_frame", visual),
        box([0.06, 0.06, 0.03], [0.5, 0.4, 1.64], "truck_lamp", visual),
        box([0.06, 0.06, 0.03], [0.5, -0.4, 1.64], "truck_lamp", visual),
      ],
    },
    {
      id: `${id}.mast`,
      kind: "dynamic",
      type: "forklift_mast",
      p: mast.p,
      q: mast.q,
      group,
      canSleep: false,
      extraSolverIterations: 8,
      parts: [
        box([0.05, 0.04, 1.1], [0, 0.36, 1], "truck_mast", { mass_kg: 140 }),
        box([0.05, 0.04, 1.1], [0, -0.36, 1], "truck_mast", { mass_kg: 140 }),
        box([0.04, 0.4, 0.05], [0, 0, 2.05], "truck_mast", { mass_kg: 10 }),
        box([0.04, 0.4, 0.05], [0, 0, 0.05], "truck_mast", { mass_kg: 10 }),
        {
          shape: { kind: "cylinder", halfHeight: 0.9, radius: 0.045 },
          at: [-0.02, 0, 0.95],
          rot: X90,
          material: "truck_chrome",
          visual: true,
        },
      ],
    },
    {
      id: `${id}.carriage`,
      kind: "dynamic",
      type: "forklift_carriage",
      p: carriage.p,
      q: carriage.q,
      group,
      canSleep: false,
      ccd: true,
      extraSolverIterations: 8,
      parts: [
        box([0.025, 0.5, 0.2], [0, 0, 0], "truck_frame", { mass_kg: 70 }),
        box([0.02, 0.5, 0.03], [0, 0, 0.9], "truck_frame", { mass_kg: 5 }),
        box([0.02, 0.03, 0.36], [0, 0.47, 0.54], "truck_frame", { mass_kg: 5 }),
        box([0.02, 0.03, 0.36], [0, -0.47, 0.54], "truck_frame", { mass_kg: 5 }),
        box([0.02, 0.03, 0.36], [0, 0.16, 0.54], "truck_frame", { mass_kg: 2 }),
        box([0.02, 0.03, 0.36], [0, -0.16, 0.54], "truck_frame", { mass_kg: 2 }),
        box([0.55, 0.05, 0.02], [0.6, 0.24, -0.345], "truck_fork", { mass_kg: 26, friction: 0.9 }),
        box([0.55, 0.05, 0.02], [0.6, -0.24, -0.345], "truck_fork", { mass_kg: 26, friction: 0.9 }),
        // The shanks: what a pallet comes up against when the forks are all the way in.
        box([0.025, 0.05, 0.18], [0.05, 0.24, -0.185], "truck_fork", { mass_kg: 8 }),
        box([0.025, 0.05, 0.18], [0.05, -0.24, -0.185], "truck_fork", { mass_kg: 8 }),
      ],
    },
  ];
}

/** Parts drawn at poses the truck computes, not simulated: the wheels and the mast's sliding stage. */
export function truckExtras(id: string): LayoutBody[] {
  const wheel = (name: string, r: number, w: number): LayoutBody => ({
    id: `${id}.${name}`,
    type: "forklift_wheel",
    fixed: false,
    p: [0, 0, 0],
    q: QID,
    parts: [
      { shape: { kind: "cylinder", halfHeight: w, radius: r }, at: [0, 0, 0], rot: QID, material: "truck_tyre" },
      {
        shape: { kind: "cylinder", halfHeight: w + 0.005, radius: r * 0.55 },
        at: [0, 0, 0],
        rot: QID,
        material: "truck_hub",
      },
    ],
  });
  return [
    wheel("wheel_fl", 0.33, 0.11),
    wheel("wheel_fr", 0.33, 0.11),
    wheel("wheel_rl", 0.27, 0.09),
    wheel("wheel_rr", 0.27, 0.09),
    {
      id: `${id}.stage`,
      type: "forklift_stage",
      fixed: false,
      p: [0, 0, 0],
      q: QID,
      parts: [
        { shape: { kind: "box", half: [0.035, 0.03, 1.1] }, at: [0.03, 0.29, 1], rot: QID, material: "truck_mast" },
        { shape: { kind: "box", half: [0.035, 0.03, 1.1] }, at: [0.03, -0.29, 1], rot: QID, material: "truck_mast" },
        { shape: { kind: "box", half: [0.03, 0.29, 0.04] }, at: [0.03, 0, 2.06], rot: QID, material: "truck_mast" },
      ],
    },
  ];
}

/** What the driver asks for. Speeds and rates are clamped to the truck's limits before they act. */
export interface Setpoint {
  v_mps: number;
  /** Positive turns left when driving forward. */
  steer_rad: number;
  lift_mps: number;
  tilt_radps: number;
}

export interface TruckState {
  /** The point on the ground under the chassis origin, heading along x. */
  base: Pose;
  yaw_rad: number;
  v_mps: number;
  yaw_rate_radps: number;
  steer_rad: number;
  fork_height_m: number;
  tilt_rad: number;
  lift_force_n: number;
  stalled: boolean;
  tipped: boolean;
  wheels_grounded: number;
}

const LIFT_K = 2e6;
const LIFT_D = 2e5;
const TILT_K = 4e6;
const TILT_D = 4e5;

/**
 * The truck's low-level control: a speed loop on the drive wheels, rate-limited steering, and ramped
 * lift and tilt. The ramps matter: a mast that jumps to its target throws the load off the forks.
 */
export class Truck {
  readonly id: string;
  readonly group: number;
  /** Where the hoist and tilt cylinders are being driven to. */
  liftGoal_m = 0;
  tiltGoal_rad = 0;
  /** A lift or tilt rate, moving the goal while it is non-zero. */
  setpoint: Setpoint = { v_mps: 0, steer_rad: 0, lift_mps: 0, tilt_radps: 0 };
  /** Set while the forks carry something: the truck then accelerates, brakes and steers more gently. */
  loaded = false;
  /** True once the truck has gone over; it takes a reset to right it. */
  tipped = false;

  private readonly pw: PhysicsWorld;
  private readonly vehicle: RaycastVehicle;
  private readonly chassis: number;
  private readonly mast: number;
  private readonly carriage: number;
  private liftJoint!: RAPIER.PrismaticImpulseJoint;
  private tiltJoint!: RAPIER.RevoluteImpulseJoint;
  private liftHandle = 0;
  private tiltHandle = 0;
  private vCmd = 0;
  private steer = 0;
  private liftTarget = 0;
  private tiltTarget = 0;
  private stallFor = 0;

  constructor(pw: PhysicsWorld, id: string, group: number) {
    this.pw = pw;
    this.id = id;
    this.group = group;
    this.chassis = pw.indexOf(id);
    this.mast = pw.indexOf(`${id}.mast`);
    this.carriage = pw.indexOf(`${id}.carriage`);
    this.vehicle = new RaycastVehicle(pw, this.chassis, vehicle(group));

    const R = pw.R;
    const v = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] });
    const tilt = pw.world.createImpulseJoint(
      R.JointData.revolute(v(MAST_AT), v([0, 0, 0]), v([0, 1, 0])),
      pw.body(this.chassis),
      pw.body(this.mast),
      true,
    ) as RAPIER.RevoluteImpulseJoint;
    tilt.setContactsEnabled(false);
    // The joint turns about +y, which tips the mast forward; the truck's tilt is positive backwards.
    tilt.setLimits(-TRUCK.tiltBack_rad, TRUCK.tiltForward_rad);
    tilt.configureMotorModel(R.MotorModel.ForceBased);
    tilt.configureMotorPosition(0, TILT_K, TILT_D);
    const lift = pw.world.createImpulseJoint(
      R.JointData.prismatic(v(CARRIAGE_AT), v([0, 0, 0]), v([0, 0, 1])),
      pw.body(this.mast),
      pw.body(this.carriage),
      true,
    ) as RAPIER.PrismaticImpulseJoint;
    lift.setContactsEnabled(false);
    lift.setLimits(0, TRUCK.liftMax_m);
    lift.configureMotorModel(R.MotorModel.ForceBased);
    lift.configureMotorPosition(0, LIFT_K, LIFT_D);
    this.liftHandle = lift.handle;
    this.tiltHandle = tilt.handle;
    this.liftJoint = lift;
    this.tiltJoint = tilt;
    pw.onRestore(() => {
      this.liftJoint = pw.world.getImpulseJoint(this.liftHandle) as RAPIER.PrismaticImpulseJoint;
      this.tiltJoint = pw.world.getImpulseJoint(this.tiltHandle) as RAPIER.RevoluteImpulseJoint;
    });
  }

  /** Bring a setpoint inside what the machine can do at this speed. `clamped` says whether anything was cut back. */
  static limit(s: Setpoint, v_mps: number): { setpoint: Setpoint; clamped: boolean } {
    const steerMax = Truck.steerLimit(v_mps);
    const out: Setpoint = {
      v_mps: clamp(s.v_mps, -TRUCK.maxSpeed_mps, TRUCK.maxSpeed_mps),
      steer_rad: clamp(s.steer_rad, -steerMax, steerMax),
      lift_mps: clamp(s.lift_mps, -TRUCK.liftRate_mps, TRUCK.liftRate_mps),
      tilt_radps: clamp(s.tilt_radps, -TRUCK.tiltRate_radps, TRUCK.tiltRate_radps),
    };
    const clamped =
      out.v_mps !== s.v_mps ||
      out.steer_rad !== s.steer_rad ||
      out.lift_mps !== s.lift_mps ||
      out.tilt_radps !== s.tilt_radps;
    return { setpoint: out, clamped };
  }

  /** The widest steering angle that keeps cornering under the lateral limit at this speed. */
  static steerLimit(v_mps: number): number {
    const v2 = v_mps * v_mps;
    if (v2 < 0.25) return TRUCK.maxSteer_rad;
    return Math.min(TRUCK.maxSteer_rad, Math.atan((TRUCK.maxLateral_mps2 * TRUCK.wheelbase_m) / v2));
  }

  /** Stop asking for anything: the speed ramps to zero and the mast holds where it is. */
  halt(): void {
    this.setpoint = { v_mps: 0, steer_rad: 0, lift_mps: 0, tilt_radps: 0 };
    this.liftGoal_m = this.liftTarget;
    this.tiltGoal_rad = this.tiltTarget;
  }

  /** Call once before every physics step. */
  update(dt_s: number): void {
    const state = this.pw.pose(this.chassis);
    if (!this.tipped && upZ(state.q) < Math.cos(TRUCK.tipped_rad)) this.tipped = true;
    if (this.tipped) {
      this.vehicle.engineForce_n = 0;
      this.vehicle.brake_n = TRUCK.parkForce_n / 4;
      return;
    }
    const v = this.vehicle.speed_mps();
    const { setpoint: s } = Truck.limit(this.setpoint, v);

    // Speed: ramp the command, then a proportional force; hold with the brake once stopped.
    const slowing = Math.abs(s.v_mps) < Math.abs(this.vCmd) || Math.sign(s.v_mps) !== Math.sign(this.vCmd);
    const ease = this.loaded ? 0.6 : 1;
    this.vCmd = approach(this.vCmd, s.v_mps, (slowing ? TRUCK.decel_mps2 : TRUCK.accel_mps2) * ease * dt_s);
    const parked = this.vCmd === 0 && Math.abs(v) < 0.15;
    this.vehicle.engineForce_n = parked ? 0 : clamp((this.vCmd - v) * 12_000, -TRUCK.driveForce_n, TRUCK.driveForce_n);
    this.vehicle.brake_n = parked ? TRUCK.parkForce_n / 4 : 0;

    this.steer = approach(this.steer, s.steer_rad, TRUCK.steerRate_radps * ease * dt_s);
    this.vehicle.steer_rad = this.steer;

    if (s.lift_mps !== 0) this.liftGoal_m = this.liftTarget + s.lift_mps * 0.2;
    if (s.tilt_radps !== 0) this.tiltGoal_rad = this.tiltTarget + s.tilt_radps * 0.2;
    this.liftGoal_m = clamp(this.liftGoal_m, 0, TRUCK.liftMax_m);
    this.tiltGoal_rad = clamp(this.tiltGoal_rad, -TRUCK.tiltForward_rad, TRUCK.tiltBack_rad);

    // The hoist is a spring towards its target, so the target's lead over the carriage is the force it
    // pushes with. Capping that lead caps the force: under more than it can lift, it stalls.
    const height = this.forkHeight();
    const reach = height + TRUCK.liftForce_n / LIFT_K;
    const wanted = approach(this.liftTarget, this.liftGoal_m, TRUCK.liftRate_mps * dt_s);
    const before = this.liftTarget;
    this.liftTarget = Math.min(wanted, Math.max(reach, 0));
    this.stallFor = wanted > this.liftTarget + 1e-9 ? this.stallFor + dt_s : 0;
    this.tiltTarget = approach(this.tiltTarget, this.tiltGoal_rad, TRUCK.tiltRate_radps * dt_s);
    // The damper works on the error in speed, not on the ramp itself, or it would eat the force budget.
    this.liftJoint.configureMotor(this.liftTarget, (this.liftTarget - before) / dt_s, LIFT_K, LIFT_D);
    this.tiltJoint.configureMotorPosition(-this.tiltTarget, TILT_K, TILT_D);
  }

  /** Height of the fork underside's rest position above its lowest, measured along the mast. */
  forkHeight(): number {
    return toLocal(this.pw.pose(this.mast), this.pw.pose(this.carriage).p)[2] - CARRIAGE_AT[2];
  }

  /** True while the hoist has been unable to follow for half a second. */
  get stalled(): boolean {
    return this.stallFor > 0.5;
  }

  get liftSettled(): boolean {
    return Math.abs(this.liftTarget - this.liftGoal_m) < 1e-6 && Math.abs(this.forkHeight() - this.liftGoal_m) < 0.04;
  }

  get tiltSettled(): boolean {
    return Math.abs(this.tiltTarget - this.tiltGoal_rad) < 1e-6;
  }

  chassisPose(): Pose {
    return this.pw.pose(this.chassis);
  }

  carriagePose(): Pose {
    return this.pw.pose(this.carriage);
  }

  /** A point in the chassis frame, in the world. */
  point(local: Vec3): Vec3 {
    return transform(this.pw.pose(this.chassis), local);
  }

  /** The fork tips' midpoint on the ground plane of the forks, and the heel's, in the world. */
  forkSpan(): { heel: Vec3; tip: Vec3 } {
    const c = this.pw.pose(this.carriage);
    return { heel: transform(c, [0.075, 0, -0.345]), tip: transform(c, [0.075 + TRUCK.forkLength_m, 0, -0.345]) };
  }

  state(): TruckState {
    const chassis = this.pw.pose(this.chassis);
    const mast = this.pw.pose(this.mast);
    const w = this.pw.angvel(this.chassis);
    const height = this.forkHeight();
    let grounded = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle.grounded(i)) grounded++;
    // Mast pitch relative to the chassis, about y; back is positive.
    const fwd = toLocal({ p: [0, 0, 0], q: chassis.q }, transform({ p: [0, 0, 0], q: mast.q }, [0, 0, 1]));
    return {
      base: { p: transform(chassis, [0, 0, -TRUCK.ride_m]), q: chassis.q },
      yaw_rad: yawOf(chassis.q),
      v_mps: this.vehicle.speed_mps(),
      yaw_rate_radps: w[2],
      steer_rad: this.steer,
      fork_height_m: height,
      tilt_rad: -Math.atan2(fwd[0], fwd[2]),
      lift_force_n: clamp((this.liftTarget - height) * LIFT_K, 0, TRUCK.liftForce_n),
      stalled: this.stalled,
      tipped: this.tipped,
      wheels_grounded: grounded,
    };
  }

  /** World poses of the drawn-only parts, in the order of `truckExtras`. */
  extraPoses(): Pose[] {
    const mast = this.pw.pose(this.mast);
    const stage = compose(mast, { p: [0, 0, clamp(this.forkHeight() - 0.9, 0, 1.7)], q: QID });
    return [...WHEEL_NAMES.map((_, i) => this.vehicle.wheelPose(i)), stage];
  }

  /** Fork underside above the ground when lowered. */
  static readonly forkFloor_m = FORK_FLOOR_M;
  static readonly top_m = TOP_M;
}

/** Sensor mounts on the overhead guard: in the chassis frame for casting, and in `base` for the frame tree. */
export const SENSORS = {
  camera: {
    chassis: [0.55, 0, 1.62] as Vec3,
    base: [0.55, 0, 1.62 + TRUCK.ride_m] as Vec3,
    // Pitched 0.3 rad down to see the ground ahead of the forks.
    q: qAxisAngle([0, 1, 0], 0.3),
  },
  lidar: { chassis: [-0.1, 0, 1.67] as Vec3, base: [-0.1, 0, 1.67 + TRUCK.ride_m] as Vec3, q: QID },
} as const;
