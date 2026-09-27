import type { WorldManifest } from "@hyperduality/awp";

const cell = { type: "array", items: { type: "integer", minimum: 0, maximum: 63 }, minItems: 2, maxItems: 2 };

export const manifest: WorldManifest = {
  protocol_version: "0.1",
  world: { name: "vault", version: "0.1.0", vendor: "awp-demo" },
  time_models: ["lockstep"],
  tick_policy: "on_tick",
  tick_authority: "any_session",
  capabilities: { task: true },
  initial_states: ["default", "small"],
  embodiments: [
    {
      id: "explorer_0",
      kind: "avatar",
      description: "An explorer in a tiled vault who sees three tiles in every direction, around corners not at all.",
      action_types: ["move", "walk_to", "interact", "drop", "wait"],
      channels: ["map", "status"],
    },
  ],
  observation_channels: [
    {
      id: "map",
      modality: "text/event+json",
      rate_hz: null,
      loss_class: "reliable",
      schema: {
        type: "object",
        description: "Every tile the explorer has seen, as rows of symbols; unseen tiles are ?.",
        properties: {
          rows: { type: "array", items: { type: "string" } },
          width: { type: "integer" },
          height: { type: "integer" },
          legend: { type: "object" },
        },
        required: ["rows", "width", "height", "legend"],
      },
    },
    {
      id: "status",
      modality: "text/event+json",
      rate_hz: null,
      loss_class: "reliable",
      schema: {
        type: "object",
        properties: {
          position: cell,
          facing: { enum: ["north", "south", "east", "west"] },
          inventory: { type: "array", items: { type: "string" } },
          message: { type: "string" },
          escaped: { type: "boolean" },
          steps: { type: "integer" },
        },
        required: ["position", "facing", "inventory", "message", "escaped", "steps"],
      },
    },
  ],
  action_schemas: [
    {
      type: "move",
      description: "Step one tile north (y−1), south (y+1), east (x+1) or west (x−1). One tick.",
      params_schema: {
        type: "object",
        properties: { direction: { enum: ["north", "south", "east", "west"] } },
        required: ["direction"],
        additionalProperties: false,
      },
      duration: "instant",
      preemption: ["replace", "queue"],
      concurrency_group: "locomotion",
      max_queue: 8,
    },
    {
      type: "walk_to",
      description:
        "Walk to a tile along a path over tiles already seen, one tile per tick. Fails if no known path exists.",
      params_schema: { type: "object", properties: { cell }, required: ["cell"], additionalProperties: false },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "locomotion",
      max_queue: 4,
    },
    {
      type: "interact",
      description:
        "Use the tile you stand on or one next to you: pick up an item, open a door with its key, or leave by the exit carrying the gem.",
      params_schema: { type: "object", properties: { cell }, required: ["cell"], additionalProperties: false },
      duration: "instant",
      preemption: "queue",
      concurrency_group: "locomotion",
      max_queue: 8,
    },
    {
      type: "wait",
      description: "Stay put for a number of ticks.",
      params_schema: {
        type: "object",
        properties: { ticks: { type: "integer", minimum: 1, maximum: 200 } },
        required: ["ticks"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "locomotion",
      max_queue: 4,
    },
    {
      type: "drop",
      description: "Put down an item you carry, on the tile you stand on.",
      params_schema: {
        type: "object",
        properties: { item: { type: "string" } },
        required: ["item"],
        additionalProperties: false,
      },
      duration: "instant",
      preemption: "queue",
      concurrency_group: "locomotion",
      max_queue: 8,
    },
  ],
  safety_policy: { envelopes: [] },
};
