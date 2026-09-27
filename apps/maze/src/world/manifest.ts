import type { WorldManifest } from "@hyperduality/awp";

const number = { type: "number" };

export const manifest: WorldManifest = {
  protocol_version: "0.1",
  world: { name: "maze", version: "0.1.0", vendor: "awp-demo" },
  time_models: ["streaming"],
  capabilities: { seed: true, task: true, command_channels: true },
  initial_states: ["default", "large"],
  embodiments: [
    {
      id: "runner_0",
      kind: "avatar",
      description:
        "A runner in a walled maze, 0.44 m across. Tiles are 1 m; x runs east, y south, z down; yaw is measured from east toward south, so positive angles turn right.",
      action_types: ["teleop", "move", "turn", "stop", "interact"],
      channels: ["pose", "ranges", "vision", "progress"],
    },
  ],
  observation_channels: [
    {
      id: "pose",
      modality: "proprio/json",
      rate_hz: 30,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        properties: { x_m: number, y_m: number, yaw_rad: number, v_mps: number },
        required: ["x_m", "y_m", "yaw_rad", "v_mps"],
      },
    },
    {
      id: "ranges",
      modality: "text/event+json",
      rate_hz: 10,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        description: "A 360° range scan: 32 rays; bearings are relative to the heading, positive to the right.",
        properties: {
          origin: { type: "object", description: "The pose the scan was taken from." },
          bearings_rad: { type: "array", items: number },
          ranges_m: { type: "array", items: number },
          max_m: number,
        },
        required: ["origin", "bearings_rad", "ranges_m", "max_m"],
      },
    },
    {
      id: "vision",
      modality: "text/event+json",
      rate_hz: 10,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        description: "Cores and the exit door in the forward field of view (110°).",
        properties: { origin: { type: "object" }, cores: { type: "array" }, exit: { type: ["object", "null"] } },
        required: ["origin", "cores", "exit"],
      },
    },
    {
      id: "progress",
      modality: "text/event+json",
      rate_hz: 2,
      loss_class: "reliable",
      schema: {
        type: "object",
        properties: {
          cores_collected: { type: "integer" },
          cores_total: { type: "integer" },
          exit_open: { type: "boolean" },
          escaped: { type: "boolean" },
          elapsed_s: number,
        },
        required: ["cores_collected", "cores_total", "exit_open", "escaped", "elapsed_s"],
      },
    },
  ],
  command_channels: [
    {
      id: "drive",
      modality: "x-awpdemo.twist",
      rate_hz: 30,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        properties: { forward_mps: number, strafe_mps: number, turn_radps: number },
      },
    },
  ],
  action_schemas: [
    {
      type: "teleop",
      description: "Drive with velocity setpoints on the drive command channel until cancelled.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "streaming",
      command_channel: "drive",
      watchdog_ms: 300,
      preemption: ["replace", "reject"],
      concurrency_group: "locomotion",
    },
    {
      type: "move",
      description: "Walk straight forward (or back, if negative) by distance_m. Fails if a wall blocks the way.",
      params_schema: {
        type: "object",
        properties: { distance_m: { type: "number", minimum: -12, maximum: 12 } },
        required: ["distance_m"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "locomotion",
      max_queue: 4,
    },
    {
      type: "turn",
      description: "Turn in place by angle_rad; positive turns right (clockwise on the map).",
      params_schema: {
        type: "object",
        properties: { angle_rad: { type: "number", minimum: -6.3, maximum: 6.3 } },
        required: ["angle_rad"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "locomotion",
      max_queue: 4,
    },
    {
      type: "stop",
      description: "Stop moving.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "instant",
      preemption: "replace",
      concurrency_group: "locomotion",
    },
    {
      type: "interact",
      description: "Open the exit door when standing next to it with every core collected, and leave the maze.",
      params_schema: { type: "object", additionalProperties: false },
      duration: "instant",
      preemption: "queue",
      concurrency_group: "hands",
      max_queue: 1,
    },
  ],
  safety_policy: {
    envelopes: [{ embodiment: "runner_0", max_velocity_mps: 3, enforcement: "command_check", on_violation: "reject" }],
    safe_state: { behavior: "safe_stop", watchdog_ms: 1000 },
  },
};
