import { narrowInputChunk } from "@awp-demo/world";
import type { WorldManifest } from "@hyperduality/awp";
import { INITIAL_STATES, KEY_NAMES, MAX_SLOTS, TICK_MS } from "../shared/minecraft.ts";

const number = { type: "number" };
const integer = { type: "integer" };
const counts = { type: "object", additionalProperties: integer };

// A keyboard and mouse: one slot per game tick, no wheel, sticks, or triggers (AWP-GAM-001).
const input = narrowInputChunk({
  slotMs: TICK_MS,
  maxSlots: MAX_SLOTS,
  keys: KEY_NAMES,
  without: ["scroll_steps", "sticks", "triggers"],
});

export const manifest = {
  protocol_version: "0.1",
  world: { name: "minecraft", version: "0.1.0", vendor: "awp-demo" },
  time_models: ["lockstep", "streaming"],
  tick_policy: "on_tick",
  tick_authority: "any_session",
  capabilities: { task: true },
  initial_states: [...INITIAL_STATES],
  embodiments: [
    {
      id: "player",
      kind: "avatar",
      description:
        "A Minecraft player (Java Edition 1.16), driven by keyboard and mouse. A mouse count turns the view 0.15°: mouse_dx turns right, mouse_dy looks down.",
      action_types: ["input_chunk"],
      channels: ["pov", "status", "scene"],
    },
  ],
  observation_channels: [
    {
      id: "pov",
      modality: "image/jpeg",
      rate_hz: 20,
      loss_class: "latest-wins",
      schema: { width: 640, height: 360, color_space: "srgb" },
    },
    {
      id: "status",
      modality: "text/event+json",
      rate_hz: 5,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        description: "The player's condition and inventory, as the game's HUD shows them.",
        properties: {
          health: { type: "number", minimum: 0, maximum: 20 },
          food: { type: "integer", minimum: 0, maximum: 20 },
          selected_slot: { type: "integer", minimum: 1, maximum: 9 },
          inventory: {
            type: "array",
            items: {
              type: "object",
              properties: { slot: integer, type: { type: "string" }, quantity: integer },
              required: ["slot", "type", "quantity"],
            },
          },
          mainhand: { type: "string" },
          light: integer,
          sky: { type: "boolean" },
          gui_open: { type: "boolean" },
          mined: counts,
          picked_up: counts,
          crafted: counts,
          killed: counts,
        },
        required: ["health", "food", "selected_slot", "inventory", "mainhand"],
      },
    },
    {
      id: "scene",
      modality: "text/event+json",
      rate_hz: 5,
      loss_class: "latest-wins",
      schema: {
        type: "object",
        description:
          "The player as a scene-graph entity. Minecraft's axes: x east, y up, z south, in blocks (1 m); q turns +z to the view direction.",
        properties: {
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                class: { type: "string" },
                pose: {
                  type: "object",
                  properties: {
                    frame: { const: "world" },
                    p_m: { type: "array", items: number, minItems: 3, maxItems: 3 },
                    q: { type: "array", items: number, minItems: 4, maxItems: 4 },
                  },
                },
                state: { type: "object" },
                controlled_by: { type: ["string", "null"] },
              },
              required: ["id", "class", "pose"],
            },
          },
          relations: { type: "array" },
        },
        required: ["entities"],
      },
    },
  ],
  action_schemas: [
    {
      type: "input_chunk",
      description:
        "Keyboard and mouse state, one slot per 50 ms game tick. A replacement takes over at the next tick and keeps keys it also holds down; a chunk that ends otherwise releases everything.",
      params_schema: input.params_schema,
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "input",
      max_queue: 1,
      max_duration_ms: 2000,
    },
  ],
  safety_policy: {
    envelopes: [],
    // Every input is released once the agent has been silent for half a second, shorter than a chunk.
    safe_state: { behavior: "safe_stop", watchdog_ms: 500 },
    // An intent on a frame more than three ticks old is refused (AWP-SAF-013).
    max_basis_age_ms: 150,
  },
  $defs: input.$defs,
} as WorldManifest;
