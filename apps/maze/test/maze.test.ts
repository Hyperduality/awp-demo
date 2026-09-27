import { describe, expect, it } from "vitest";
import { CORES, castRay } from "../src/shared/maze.ts";
import { generate, MazeSim } from "../src/world/sim.ts";

describe("maze", () => {
  it("generates the same maze for a seed, with every core reachable", () => {
    const a = generate(5, 8);
    expect(generate(5, 8)).toEqual(a);
    expect(a.cores).toHaveLength(CORES);
    const seen = new Set(["1,1"]);
    const queue = [[1, 1]];
    while (queue.length) {
      const [x, y] = queue.shift()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const k = `${x! + dx!},${y! + dy!}`;
        if (!seen.has(k) && a.grid[y! + dy!]?.[x! + dx!] === ".") {
          seen.add(k);
          queue.push([x! + dx!, y! + dy!]);
        }
      }
    }
    for (const [x, y] of a.cores) expect(seen.has(`${x},${y}`)).toBe(true);
  });

  it("casts rays to the nearest wall", () => {
    const grid = ["#####", "#...#", "#####"];
    expect(castRay(grid, 1.5, 1.5, 0, 8).dist).toBeCloseTo(2.5, 5);
    expect(castRay(grid, 1.5, 1.5, Math.PI / 2, 8).dist).toBeCloseTo(0.5, 5);
  });

  it("walks with move and stops at walls", () => {
    const sim = new MazeSim(11, "default");
    const run = sim.start("runner_0", "move", { distance_m: 40 });
    let status: ReturnType<typeof run.update> = {};
    for (let i = 0; i < 600 && !("failed" in status) && !("done" in status); i++) {
      status = run.update(1000 / 60);
      sim.step(1000 / 60);
    }
    expect(status).toMatchObject({ failed: "world_error" });
  });
});
