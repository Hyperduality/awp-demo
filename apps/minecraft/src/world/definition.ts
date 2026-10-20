import type { WorldDefinition } from "@awp-demo/world";
import { type MinecraftView, TICK_MS } from "../shared/minecraft.ts";
import { engine } from "./engine.ts";
import { manifest } from "./manifest.ts";
import { MinecraftSim } from "./sim.ts";

export function minecraft(
  log: (line: string) => void = (l) => console.log(`[world] ${l}`),
): WorldDefinition<MinecraftView> {
  return {
    manifest,
    tickMs: TICK_MS,
    stepMs: TICK_MS,
    // The game ticks in another process; a slow tick delays the next rather than bursting to catch up.
    pacing: "fixed",
    // A reset reuses the running game (a sidecar that died is started again) and rebuilds the initial state.
    async createSim({ initialState }) {
      const game = await engine(log);
      return new MinecraftSim(game, initialState, await game.reset(initialState));
    },
  };
}
