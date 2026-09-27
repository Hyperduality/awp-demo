import type { WorldDefinition } from "@awp-demo/world";
import type { MazeView } from "../shared/maze.ts";
import { manifest } from "./manifest.ts";
import { MazeSim } from "./sim.ts";

export const maze: WorldDefinition<MazeView> = {
  manifest,
  stepMs: 1000 / 60,
  defaultSeed: 11,
  frameTree: { frames: [{ id: "world", parent: null }] },
  createSim: ({ seed, initialState }) => new MazeSim(seed, initialState),
};
