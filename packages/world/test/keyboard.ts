import { readVendored, type WorldManifest } from "@hyperduality/awp";
import type { DeviceState } from "../src/input.ts";
import type { Sim, WorldDefinition } from "../src/types.ts";

export const KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "Space", "MouseLeft"];

/** Every device state the sim was given, in order. */
export interface Applied {
  embodiment: string;
  state: DeviceState;
}

interface InputSchema {
  properties: {
    slot_ms: Record<string, unknown>;
    slots: { maxItems: number; items: { properties: Record<string, Record<string, unknown>> } };
  } & Record<string, unknown>;
  $defs?: unknown;
}

/**
 * The normative input_chunk params schema narrowed the ways AWP-GAM-001 allows. Its key-name enum
 * moves to the manifest's `$defs`, which a params schema's `$ref` resolves against.
 */
export function narrowedInputSchema(
  slotMs: number,
  keys: string[] = KEYS,
): { params: InputSchema; defs: Record<string, unknown> } {
  const params = structuredClone(readVendored("v0.1/profiles/input-chunk.schema.json")) as InputSchema;
  delete params.$defs;
  params.properties.slot_ms.const = slotMs;
  params.properties.slots.maxItems = 20;
  const slot = params.properties.slots.items.properties;
  for (const f of ["scroll_steps", "sticks", "triggers"]) delete slot[f];
  slot.keys!.items = { $ref: "#/$defs/input_key_name" };
  return { params, defs: { input_key_name: { enum: keys } } };
}

/** A world whose only action is device input; its sim records what it was given and shows the held keys. */
export function keyboard(
  mode: "lockstep" | "streaming" | "both",
  opts: {
    applied?: Applied[];
    schema?: ReturnType<typeof narrowedInputSchema>;
    duration?: "extended" | "instant";
    watchdogMs?: number;
  } = {},
): WorldDefinition<{ held: string[] }> {
  const lockstep = mode !== "streaming";
  const streaming = mode !== "lockstep";
  const schema = opts.schema ?? narrowedInputSchema(50);
  const manifest = {
    protocol_version: "0.1",
    world: { name: "keyboard", version: "0.1.0", vendor: "awp-demo" },
    time_models: mode === "both" ? ["lockstep", "streaming"] : [mode],
    ...(lockstep ? { tick_policy: "on_tick" as const, tick_authority: "any_session" as const } : {}),
    capabilities: {},
    initial_states: ["default"],
    embodiments: [{ id: "player", kind: "avatar", action_types: ["input_chunk"], channels: ["keys"] }],
    observation_channels: [
      {
        id: "keys",
        modality: "text/event+json",
        rate_hz: streaming ? 20 : null,
        loss_class: "latest-wins",
        schema: { type: "object", properties: { held: { type: "array", items: { type: "string" } } } },
      },
    ],
    action_schemas: [
      {
        type: "input_chunk",
        params_schema: schema.params,
        duration: opts.duration ?? "extended",
        preemption: ["replace", "queue"],
        concurrency_group: "input",
        max_queue: 1,
      },
    ],
    safety_policy: {
      envelopes: [],
      ...(streaming ? { safe_state: { behavior: "safe_stop", watchdog_ms: opts.watchdogMs ?? 2000 } } : {}),
    },
    $defs: schema.defs,
  } as unknown as WorldManifest;
  return {
    manifest,
    tickMs: 50,
    stepMs: 50,
    pacing: "fixed",
    createSim(): Sim<{ held: string[] }> {
      let held: string[] = [];
      return {
        step() {},
        observe: () => ({ held }),
        start() {
          throw new Error("input_chunk is run by the host");
        },
        safeStop() {},
        applyInput(embodiment, state) {
          held = state.held;
          opts.applied?.push({ embodiment, state });
        },
        view: () => ({ held }),
      };
    },
  };
}
