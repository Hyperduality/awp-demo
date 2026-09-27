import type { WorldDefinition } from "@awp-demo/world";
import type { VaultView } from "../shared/vault.ts";
import { manifest } from "./manifest.ts";
import { VaultSim } from "./sim.ts";

export const vault: WorldDefinition<VaultView> = {
  manifest,
  tickMs: 250,
  frameTree: { frames: [{ id: "world", parent: null }] },
  createSim: ({ initialState }) => new VaultSim(initialState),
};
