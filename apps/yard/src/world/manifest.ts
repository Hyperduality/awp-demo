import type { FrameTree, WorldManifest } from "@hyperduality/awp";
import { BOUNDS, CAMERA, EMBODIMENT, LIDAR } from "../shared/yard.ts";
import { SENSORS, TRUCK } from "./forklift.ts";

const number = { type: "number" };
const vec3 = { type: "array", items: number, minItems: 3, maxItems: 3 };
const quat = { type: "array", items: number, minItems: 4, maxItems: 4 };
const pose = {
  type: "object",
  properties: { frame: { type: "string" }, p_m: vec3, q: quat },
  required: ["frame", "p_m", "q"],
};
const x_m = { type: "number", description: "East, metres, in the world frame." };
const y_m = { type: "number", description: "North, metres, in the world frame." };
const yaw_rad = {
  type: "number",
  minimum: -6.3,
  maximum: 6.3,
  description: "Heading, radians from east towards north.",
};
const speed = { type: "number", exclusiveMinimum: 0, maximum: TRUCK.maxSpeed_mps };

export const manifest: WorldManifest = {
  protocol_version: "0.1",
  world: { name: "yard", version: "0.1.0", vendor: "awp-demo" },
  time_models: ["streaming"],
  capabilities: { seed: true, task: true, command_channels: true },
  initial_states: ["default", "trailer", "empty"],
  embodiments: [
    {
      id: EMBODIMENT,
      kind: "mobile_manipulator",
      description:
        "A 2.5 tonne counterbalance forklift in a freight yard: front-wheel drive, rear-wheel steering, a mast that lifts 3 m and tilts, two forks. Everything it touches is a rigid body: loads slide, topple and fall.",
      action_types: ["drive_to", "set_forks", "pick_pallet", "place_pallet", "stop", "teleop"],
      channels: ["proprio", "scene", "task", "awp.tf", "depth", "rgb", "lidar"],
    },
  ],
  observation_channels: [
    {
      id: "proprio",
      modality: "proprio/json",
      rate_hz: 20,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        properties: {
          pose,
          yaw_rad: number,
          v_mps: number,
          yaw_rate_radps: number,
          steer_rad: number,
          fork_height_m: number,
          tilt_rad: { type: "number", description: "Mast tilt; positive leans back towards the driver." },
          lift_force_n: number,
          load_kg: number,
          carrying: { type: ["string", "null"] },
          stalled: { type: "boolean", description: "The hoist cannot raise what is on the forks." },
          tipped: { type: "boolean" },
          wheels_grounded: { type: "integer" },
        },
        required: ["pose", "yaw_rad", "v_mps", "fork_height_m", "tilt_rad", "load_kg", "carrying", "stalled", "tipped"],
      },
    },
    {
      id: "scene",
      modality: "text/event+json",
      rate_hz: 4,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        description:
          "A scene graph (spec/semantics/scene-graphs) of what the truck knows. Entities with state.source site_map are the fixed things: buildings, containers, the trailer, the bays and the receiving pad. Entities with state.source sensors are the movable things its camera and lidar pick out at this moment; out of sight, they are not listed. Poses are in the world frame; size_m is the bounding box in the entity's own frame.",
        properties: { entities: { type: "array" }, relations: { type: "array" } },
        required: ["entities", "relations"],
      },
    },
    {
      id: "task",
      modality: "text/event+json",
      rate_hz: 2,
      loss_class: "reliable",
      schema: {
        type: "object",
        properties: {
          phase: { enum: ["working", "done", "failed"] },
          score: { type: "integer" },
          elapsed_s: number,
          orders: { type: "array", items: { type: "object" } },
          log: { type: "array", items: { type: "string" } },
        },
        required: ["phase", "score", "elapsed_s", "orders", "log"],
      },
    },
    {
      id: "awp.tf",
      modality: "proprio/json",
      rate_hz: 20,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        description: "The frame tree's dynamic transforms (AWP-UNI-004): base in world, forks in base.",
        properties: {
          transforms: {
            type: "array",
            items: {
              type: "object",
              properties: { frame: { type: "string" }, parent: { type: "string" }, p_m: vec3, q: quat },
              required: ["frame", "parent", "p_m", "q"],
            },
          },
        },
        required: ["transforms"],
      },
    },
    {
      id: "depth",
      modality: "image/raw",
      rate_hz: 10,
      loss_class: "latest-wins",
      schema: {
        format: "depth32f",
        width: CAMERA.width,
        height: CAMERA.height,
        stride: CAMERA.width * 4,
        frame: "camera",
        fov_y_rad: CAMERA.fovY_rad,
        max_range_m: CAMERA.maxRange_m,
        description:
          "Metres along the camera's x axis, little-endian float32, rows from the top; 0 where nothing is in range. The camera frame is x forward, y left, z up. The truck's own parts are not in it.",
      },
    },
    {
      id: "rgb",
      modality: "image/raw",
      rate_hz: 5,
      loss_class: "latest-wins",
      schema: {
        format: "rgb8",
        width: CAMERA.width,
        height: CAMERA.height,
        stride: CAMERA.width * 3,
        frame: "camera",
        fov_y_rad: CAMERA.fovY_rad,
        description: "The depth camera's view, flat-shaded with sun and shadow: the same rays, coloured by material.",
      },
    },
    {
      id: "lidar",
      modality: "pointcloud/xyz32",
      rate_hz: 10,
      loss_class: "latest-wins",
      schema: {
        frame: "lidar",
        max_points: LIDAR.rings_deg.length * LIDAR.azimuths,
        rings_deg: [...LIDAR.rings_deg],
        max_range_m: LIDAR.maxRange_m,
        description: "Returns only, as little-endian float32 xyz triples in metres, ring by ring. The ground is in it.",
      },
    },
  ],
  command_channels: [
    {
      id: "drive",
      modality: "servo/json",
      rate_hz: 30,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        description:
          "Setpoints held until the next frame: ground speed, steering (positive turns left going forward), hoist rate and tilt rate (positive leans back). A setpoint over the speed limit is dropped; the truck takes what it can of the others.",
        properties: { v_mps: number, steer_rad: number, lift_mps: number, tilt_radps: number },
        required: ["v_mps", "steer_rad"],
        additionalProperties: false,
      },
    },
  ],
  action_schemas: [
    {
      type: "drive_to",
      description:
        "Drive to a point, by a route planned around the site map and what the truck has seen. With yaw_rad the truck joins the straight line into the point a few metres before it and arrives heading that way, backing up to try again if it comes in crooked. It fails with reason x-yard.blocked if there is no clear way or something stops it, and x-yard.tipped if the truck goes over.",
      params_schema: {
        type: "object",
        properties: {
          x_m,
          y_m,
          yaw_rad,
          max_velocity_mps: speed,
          reverse: { type: "boolean", description: "Drive there backwards." },
        },
        required: ["x_m", "y_m"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "drive",
      max_queue: 4,
    },
    {
      type: "pick_pallet",
      description:
        "Pick up a pallet the truck has seen: line up with its fork pockets from the nearer end, lower the forks, drive in, lift and tilt back. It fails with x-yard.blocked if the way in is not clear, x-yard.overload if the load is more than the hoist can raise, x-yard.missed if the forks come up without it, and x-yard.unseen if the truck's sensors have not seen the pallet or it is no longer where they last saw it.",
      params_schema: {
        type: "object",
        properties: { pallet: { type: "string", description: "The pallet's entity id in the scene." } },
        required: ["pallet"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "drive",
      max_queue: 4,
    },
    {
      type: "place_pallet",
      description:
        "Put the carried pallet down in a bay, or at a pose on the ground: approach squarely, raise the forks to the surface, drive in, lower, and back out. It fails with x-yard.empty if nothing is on the forks.",
      params_schema: {
        type: "object",
        properties: {
          bay: { type: "string", description: "A bay's entity id in the scene." },
          x_m,
          y_m,
          yaw_rad,
        },
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "drive",
      max_queue: 4,
    },
    {
      type: "stop",
      description: "Stop the truck and hold the mast where it is.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "instant",
      preemption: "replace",
      concurrency_group: "drive",
    },
    {
      type: "teleop",
      description:
        "Take the controls: while this runs, the drive command channel sets speed, steering, hoist and tilt directly. The truck stops if the setpoints stop coming.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "streaming",
      command_channel: "drive",
      watchdog_ms: 500,
      preemption: ["replace", "reject"],
      concurrency_group: "drive",
    },
    {
      type: "set_forks",
      description: "Raise or lower the forks to a height above their lowest position, and optionally tilt the mast.",
      params_schema: {
        type: "object",
        properties: {
          height_m: { type: "number", minimum: 0, maximum: TRUCK.liftMax_m },
          tilt_rad: { type: "number", minimum: -TRUCK.tiltForward_rad, maximum: TRUCK.tiltBack_rad },
        },
        required: ["height_m"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "mast",
      max_queue: 2,
      max_duration_ms: 30000,
    },
  ],
  safety_policy: {
    envelopes: [
      {
        // Targets outside the yard and setpoints over the speed limit are refused. The hoist measures
        // what it lifts and stalls at its limit, whatever it was asked for.
        embodiment: EMBODIMENT,
        spatial: {
          frame: "world",
          aabb_m: [
            [BOUNDS.min[0], BOUNDS.min[1], 0],
            [BOUNDS.max[0], BOUNDS.max[1], 4],
          ],
        },
        max_velocity_mps: TRUCK.maxSpeed_mps,
        max_force_n: TRUCK.liftForce_n,
        enforcement: "both",
        on_violation: "reject",
      },
    ],
    // The truck brakes to a stop once its driver has been silent for two seconds.
    safe_state: { behavior: "safe_stop", watchdog_ms: 2000 },
    max_basis_age_ms: 5000,
  },
};

export const frameTree: FrameTree = {
  frames: [
    { id: "world", parent: null },
    { id: "base", parent: "world", dynamic: true },
    { id: "forks", parent: "base", dynamic: true },
    { id: "camera", parent: "base", transform: { p_m: SENSORS.camera.base, q: SENSORS.camera.q } },
    { id: "lidar", parent: "base", transform: { p_m: SENSORS.lidar.base, q: SENSORS.lidar.q } },
  ],
};
