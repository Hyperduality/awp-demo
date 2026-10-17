import type { WorldManifest } from "@hyperduality/awp";
import { KIND_NOUN, NODE_PATTERN, UNITS } from "../shared/city.ts";

const number = { type: "number" };
const integer = { type: "integer" };

export const manifest: WorldManifest = {
  protocol_version: "0.1",
  world: { name: "dispatch", version: "0.1.0", vendor: "awp-demo" },
  time_models: ["streaming"],
  capabilities: { seed: true, task: true },
  initial_states: ["default", "rush"],
  embodiments: UNITS.map((u) => ({
    id: u.id,
    kind: "vehicle",
    description: `${u.label}, a ${KIND_NOUN[u.kind]} based at ${u.home}. It drives ${u.speed} blocks a second of shift time.`,
    multi_bind_group: "fleet",
    action_types: ["dispatch", "stage"],
    channels: ["units", "calls", "shift"],
  })),
  observation_channels: [
    {
      id: "units",
      modality: "text/event+json",
      rate_hz: 5,
      loss_class: "latest-wins",
      stale_after_ms: 1000,
      schema: {
        type: "object",
        description:
          "Every unit: where it is (blocks east of avenue A and south of street 1), what it is doing, and the action moving it.",
        properties: {
          units: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                kind: { enum: ["fire", "medical", "police"] },
                label: { type: "string" },
                x: number,
                y: number,
                near: { type: "string" },
                status: { enum: ["available", "en_route", "on_scene", "staging"] },
                call: integer,
                to: { type: "string" },
                eta_s: number,
                work: number,
                action_id: { type: "string" },
              },
              required: ["id", "kind", "label", "x", "y", "near", "status"],
            },
          },
        },
        required: ["units"],
      },
    },
    {
      id: "calls",
      modality: "text/event+json",
      rate_hz: 2,
      loss_class: "reliable",
      schema: {
        type: "object",
        description:
          "Open calls as the callers put them, with later updates, the units sent, and every unit's ETA; then the latest closed calls.",
        properties: {
          open: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: integer,
                at: { type: "string" },
                received_s: number,
                age_s: number,
                text: { type: "string" },
                updates: { type: "array", items: { type: "string" } },
                units: { type: "array", items: { type: "object" } },
                eta_s: { type: "object", additionalProperties: number },
              },
              required: ["id", "at", "received_s", "age_s", "text", "updates", "units", "eta_s"],
            },
          },
          closed: { type: "array", items: { type: "object" } },
        },
        required: ["open", "closed"],
      },
    },
    {
      id: "shift",
      modality: "text/event+json",
      rate_hz: 2,
      loss_class: "reliable",
      schema: {
        type: "object",
        properties: {
          phase: { enum: ["waiting", "on", "over"] },
          clock_s: number,
          left_s: number,
          speed: number,
          score: integer,
          resolved: integer,
          lost: integer,
          open: integer,
          calls: integer,
          avg_response_s: { type: ["number", "null"] },
        },
        required: ["phase", "clock_s", "left_s", "speed", "score", "resolved", "lost", "open", "calls"],
      },
    },
  ],
  action_schemas: [
    {
      type: "dispatch",
      description:
        "Send the unit to a call. It drives there by the fastest route and works the scene if the call needs its kind; it completes when its part is done, or on arrival if it is not needed. It fails if the call closes first.",
      params_schema: {
        type: "object",
        properties: { call: { type: "integer", minimum: 1 } },
        required: ["call"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "unit",
      max_queue: 2,
      max_duration_ms: 240000,
    },
    {
      type: "stage",
      description: "Drive the unit to an intersection, A1 to I7, and wait there.",
      params_schema: {
        type: "object",
        properties: { at: { type: "string", pattern: NODE_PATTERN } },
        required: ["at"],
        additionalProperties: false,
      },
      duration: "extended",
      preemption: ["replace", "queue"],
      concurrency_group: "unit",
      max_queue: 2,
    },
  ],
  safety_policy: {
    envelopes: [],
    // Units hold where they are once the dispatcher has been silent for 8 s.
    safe_state: { behavior: "hold", watchdog_ms: 8000 },
    max_basis_age_ms: 10000,
  },
};
