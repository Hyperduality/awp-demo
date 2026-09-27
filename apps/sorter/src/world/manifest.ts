import type { WorldManifest } from "@hyperduality/awp";

const vec2 = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };

export const manifest: WorldManifest = {
  protocol_version: "0.1",
  world: { name: "sorter", version: "0.1.0", vendor: "awp-demo" },
  time_models: ["lockstep"],
  tick_policy: "on_tick",
  tick_authority: "any_session",
  capabilities: { seed: true, task: true },
  initial_states: ["default", "rush"],
  embodiments: [
    {
      id: "arm_0",
      kind: "manipulator",
      description: "A planar two-link arm; the end effector moves in straight lines.",
      multi_bind_group: "cell",
      action_types: ["move_to", "stop"],
      channels: ["proprio", "scene"],
    },
    {
      id: "gripper_0",
      kind: "gripper",
      description: "A parallel gripper at the end of arm_0.",
      multi_bind_group: "cell",
      action_types: ["grip", "release"],
      channels: ["gripper_state", "scene"],
    },
  ],
  observation_channels: [
    {
      id: "proprio",
      modality: "proprio/json",
      rate_hz: null,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        properties: { q_rad: vec2, ee_m: vec2, moving: { type: "boolean" } },
        required: ["q_rad", "ee_m", "moving"],
      },
    },
    {
      id: "gripper_state",
      modality: "text/event+json",
      rate_hz: null,
      loss_class: "reliable",
      schema: {
        type: "object",
        properties: { width_m: { type: "number" }, holding: { type: ["string", "null"] } },
        required: ["width_m", "holding"],
      },
    },
    {
      id: "scene",
      modality: "text/event+json",
      rate_hz: null,
      loss_class: "reliable",
      schema: {
        type: "object",
        description: "A scene graph (spec/semantics/scene-graphs): parcels, bins, and the belt, with running stats.",
        properties: { entities: { type: "array" }, relations: { type: "array" }, stats: { type: "object" } },
        required: ["entities", "relations"],
      },
    },
  ],
  action_schemas: [
    {
      type: "move_to",
      description: "Move the end effector in a straight line to (x_m, z_m) in the base frame.",
      params_schema: {
        type: "object",
        properties: {
          x_m: { type: "number", minimum: -1, maximum: 1 },
          z_m: { type: "number", minimum: 0, maximum: 1.2 },
          max_velocity_mps: { type: "number", exclusiveMinimum: 0, maximum: 1 },
        },
        required: ["x_m", "z_m"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["queue", "replace"],
      concurrency_group: "arm_motion",
      max_queue: 4,
    },
    {
      type: "stop",
      description: "Stop the arm where it is.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "instant",
      preemption: "replace",
      concurrency_group: "arm_motion",
    },
    {
      type: "grip",
      description: "Close the gripper; it holds a parcel if one is between the fingers.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "gripper",
      max_queue: 1,
    },
    {
      type: "release",
      description: "Open the gripper, dropping whatever it holds.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "gripper",
      max_queue: 1,
    },
  ],
  safety_policy: {
    envelopes: [
      {
        embodiment: "arm_0",
        spatial: {
          frame: "base",
          aabb_m: [
            [-1, -0.1, 0.05],
            [1, 0.1, 1.2],
          ],
        },
        max_velocity_mps: 1,
        enforcement: "command_check",
        on_violation: "reject",
      },
    ],
  },
};

export const frameTree = {
  frames: [
    { id: "world", parent: null },
    { id: "base", parent: "world", transform: { p_m: [0, 0, 0], q: [0, 0, 0, 1] } },
  ],
};
