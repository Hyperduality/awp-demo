import type { WorldManifest } from "@hyperduality/awp";
import type { ActionRun, Sim, WorldDefinition } from "../src/types.ts";

/** The spec's example gridworld (examples/v0.1/traces/core-lockstep.jsonl), in either time model. */
export function gridworld(mode: "lockstep" | "streaming"): WorldDefinition<{ avatar: number[] }> {
  const manifest: WorldManifest = {
    protocol_version: "0.1",
    world: { name: "gridworld", version: "0.1.0", vendor: "awp-demo" },
    time_models: [mode],
    ...(mode === "lockstep" ? { tick_policy: "on_tick" as const, tick_authority: "any_session" as const } : {}),
    capabilities: { seed: true, task: true },
    initial_states: ["default"],
    embodiments: [{ id: "avatar_0", kind: "avatar", action_types: ["move", "walk_to"], channels: ["grid_view"] }],
    observation_channels: [
      {
        id: "grid_view",
        modality: "text/event+json",
        rate_hz: mode === "lockstep" ? null : 20,
        loss_class: "reliable",
        schema: {
          type: "object",
          properties: { avatar: { type: "array", items: { type: "integer" } }, goal: { type: "array", items: { type: "integer" } } },
          required: ["avatar", "goal"],
        },
      },
    ],
    action_schemas: [
      {
        type: "move",
        params_schema: {
          type: "object",
          properties: { direction: { type: "string", enum: ["north", "south", "east", "west"] } },
          required: ["direction"],
          additionalProperties: false,
        },
        duration: "instant",
        preemption: "replace",
        concurrency_group: "locomotion",
      },
      {
        type: "walk_to",
        params_schema: {
          type: "object",
          properties: { cell: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 } },
          required: ["cell"],
          additionalProperties: false,
        },
        duration: "extended",
        preemption: ["replace", "queue"],
        concurrency_group: "locomotion",
        max_queue: 2,
      },
    ],
    safety_policy: {
      envelopes: [],
      ...(mode === "streaming" ? { safe_state: { behavior: "safe_stop", watchdog_ms: 1000 } } : {}),
    },
  };
  return {
    manifest,
    tickMs: 1,
    createSim(): Sim<{ avatar: number[] }> {
      const avatar = [0, 0];
      const goal = [2, 0];
      const DIRS: Record<string, [number, number]> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };
      return {
        step() {},
        observe: () => ({ avatar: [...avatar], goal }),
        start(_e, type, params): ActionRun {
          if (type === "move") {
            const [dx, dy] = DIRS[params.direction as string]!;
            return {
              update() {
                avatar[0]! += dx;
                avatar[1]! += dy;
                return { done: true };
              },
            };
          }
          const target = params.cell as number[];
          const start = [...avatar];
          const total = Math.max(1, Math.abs(target[0]! - start[0]!) + Math.abs(target[1]! - start[1]!));
          let acc = 0;
          return {
            update(dt) {
              acc += mode === "lockstep" ? 1 : dt / 50;
              while (acc >= 1) {
                acc -= 1;
                if (avatar[0] !== target[0]) avatar[0]! += Math.sign(target[0]! - avatar[0]!);
                else if (avatar[1] !== target[1]) avatar[1]! += Math.sign(target[1]! - avatar[1]!);
              }
              const left = Math.abs(target[0]! - avatar[0]!) + Math.abs(target[1]! - avatar[1]!);
              return left === 0 ? { done: true } : { progress: 1 - left / total };
            },
            // Braking takes time while streaming, so aborts can be overtaken (AWP-LIF-008).
            abort: () => (mode === "streaming" ? 400 : 0),
          };
        },
        safeStop() {},
        view: () => ({ avatar: [...avatar] }),
      };
    },
  };
}
