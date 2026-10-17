import type { WorldDefinition } from "@awp-demo/world";
import type { DispatchView } from "../shared/city.ts";
import { manifest } from "./manifest.ts";
import { DispatchSim } from "./sim.ts";

export const dispatch: WorldDefinition<DispatchView> = {
  manifest,
  defaultSeed: 11,
  createSim: ({ seed, initialState }) => new DispatchSim(seed, initialState),
};
