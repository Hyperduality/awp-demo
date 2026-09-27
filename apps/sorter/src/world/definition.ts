import type { WorldDefinition } from "@awp-demo/world";
import type { SorterView } from "../shared/cell.ts";
import { frameTree, manifest } from "./manifest.ts";
import { SorterSim } from "./sim.ts";

export const sorter: WorldDefinition<SorterView> = {
  manifest,
  frameTree,
  tickMs: 50,
  defaultSeed: 7,
  createSim: ({ seed, initialState }) => new SorterSim(seed, initialState),
};
