import type { WorldDefinition } from "@awp-demo/world";
import type { YardView } from "../shared/yard.ts";
import { frameTree, manifest } from "./manifest.ts";
import { YardSim } from "./sim.ts";

export const yard: WorldDefinition<YardView> = {
  manifest,
  frameTree,
  defaultSeed: 3,
  createSim: ({ seed, initialState }) => YardSim.create(seed, initialState),
};
