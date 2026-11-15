import type { LayoutBody } from "@awp-demo/physics";

export const PORTS = { world: 8717, worldInspector: 8817, agentInspector: 8917, ui: 5176 } as const;

export const EMBODIMENT = "forklift_0";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** The yard floor, metres. x runs east, y north, z up. */
export const BOUNDS = { min: [-24, -16] as [number, number], max: [24, 16] as [number, number] };

/** Where a pallet is to be put down. */
export interface Bay {
  id: string;
  label: string;
  /** Centre of the slot, on the surface the pallet rests on. */
  p_m: Vec3;
  /** Heading of a truck placing a pallet squarely. */
  yaw_rad: number;
  size_m: [number, number];
}

export interface Order {
  pallet: string;
  bay: string;
  status: "waiting" | "carried" | "delivered";
  /** Share of the load still on the pallet, 0..1. */
  intact: number;
}

// ---------------------------------------------------------------------------------------------
// Observation payloads

export interface Pose {
  frame: string;
  p_m: Vec3;
  q: Quat;
}

export interface Proprio {
  pose: Pose;
  yaw_rad: number;
  v_mps: number;
  yaw_rate_radps: number;
  steer_rad: number;
  fork_height_m: number;
  tilt_rad: number;
  /** What the hoist is pushing with, as far as the truck can tell. */
  lift_force_n: number;
  load_kg: number;
  /** The pallet on the forks, if one is. */
  carrying: string | null;
  stalled: boolean;
  tipped: boolean;
  wheels_grounded: number;
}

export interface SceneEntity {
  id: string;
  class: string;
  pose: Pose;
  /** Full extents of the entity's bounding box in its own frame. */
  size_m?: Vec3;
  affordances?: string[];
  state?: Record<string, unknown>;
}

/**
 * What the truck knows of the yard. Entities from the site map (the buildings, the bays, the trailer)
 * are always there; everything that can move is there only while the truck's sensors pick it out.
 */
export interface Scene {
  entities: SceneEntity[];
  relations: { type: string; subject: string; object: string }[];
}

/** The task as the agent hears it. What it says of loads is what the truck's own load cell can tell. */
export interface TaskObs {
  phase: "working" | "done" | "failed";
  score: number;
  elapsed_s: number;
  orders: (Order & { pallet_label: string; bay_label: string })[];
  /** The latest things that happened, oldest first. */
  log: string[];
}

/** A `drive` command-channel setpoint, and the manual controller's input. */
export interface DriveSetpoint {
  v_mps: number;
  steer_rad: number;
  lift_mps: number;
  tilt_radps: number;
}

export const CAMERA = { width: 96, height: 64, fovY_rad: 1.0, maxRange_m: 40 } as const;
export const LIDAR = { rings_deg: [-25, -15, -8, -3], azimuths: 360, maxRange_m: 20 } as const;

// ---------------------------------------------------------------------------------------------
// UI view

/** Sent once per sim: everything a renderer needs but the poses. */
export interface YardLayout {
  /** Changes whenever the bodies do, so a stale pose array is never drawn against it. */
  key: string;
  bodies: LayoutBody[];
  bays: Bay[];
  bounds: typeof BOUNDS;
  /** Sensor mounts in the truck's chassis frame. */
  sensors: { camera: { p_m: Vec3; q: Quat }; lidar: { p_m: Vec3; q: Quat } };
  truck: string;
}

export interface YardView {
  key: string;
  step: number;
  t_ms: number;
  /** base64 float32, seven per layout body, in layout order. */
  poses: string;
  truck: {
    v_mps: number;
    steer_rad: number;
    fork_height_m: number;
    tilt_rad: number;
    load_kg: number;
    carrying: string | null;
    stalled: boolean;
    tipped: boolean;
  };
  task: TaskObs;
  /** The path of the action driving the truck, for the overlay. */
  target: { x_m: number; y_m: number; yaw_rad?: number } | null;
  /** The corners of the route it planned there, ending at the target. */
  path: [number, number][] | null;
}

/** The sensor frames the UI overlays, republished a few times a second. */
export interface SensorsView {
  step: number;
  /** Truck chassis pose when the frames were taken. */
  chassis: { p_m: Vec3; q: Quat };
  /** base64 float32, width x height. */
  depth: string;
  /** base64 rgb8. */
  rgb: string;
  /** base64 float32 xyz triples in the lidar frame. */
  lidar: string;
  /** The movable things the sensors pick out right now. */
  seen: string[];
}
