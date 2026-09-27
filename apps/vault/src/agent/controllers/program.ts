import { type Controller, NotInControlError } from "@awp-demo/agent";
import { z } from "zod";
import { type Cell, DIRS } from "../../shared/vault.ts";
import { Knowledge, same } from "./knowledge.ts";

const Config = z.object({});
type Config = z.infer<typeof Config>;

/**
 * A planner with a fixed priority of subgoals: leave if carrying the gem, take the gem if it can be
 * reached, open a door it has the key for, fetch a key it has seen, otherwise explore the nearest
 * edge of the unknown. It reads only the map it has been shown.
 */
export const program: Controller<Config> = {
  id: "program",
  kind: "program",
  label: "Planner",
  description: "Explores the nearest unknown edge, fetches keys, opens doors, takes the gem, and leaves.",
  config: Config,
  enabled: false,
  create(ctx) {
    const go = async (cell: Cell) => {
      const k = Knowledge.read(ctx)!;
      if (same(k.status.position, cell)) return true;
      const rec = await ctx.settle(await ctx.submit("walk_to", { cell }, { preempt: "replace" }));
      return rec.state === "completed";
    };
    const use = async (cell: Cell) =>
      (await ctx.settle(await ctx.submit("interact", { cell }, { preempt: "queue" }))).state === "completed";
    const nextTo = (a: Cell, b: Cell) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

    const step = async () => {
      if (!ctx.hasAuthority) await ctx.acquire();
      const k = Knowledge.read(ctx);
      if (!k) return ctx.wait({ ticks: 1 });
      if (k.status.escaped) {
        ctx.status("Escaped");
        ctx.release();
        return ctx.wait({ ms: 1000 });
      }
      const exit = k.find("E")[0];
      if (k.carries("gem") && exit) {
        const spot = k.nearest((c) => same(c, exit), true);
        if (spot) {
          ctx.status("Leaving with the gem");
          if ((await go(spot)) && nextTo(Knowledge.read(ctx)!.status.position, exit)) await use(exit);
          return;
        }
      }
      const gem = k.find("*")[0];
      if (gem && k.nearest((c) => same(c, gem))) {
        ctx.status("Taking the gem");
        ctx.log({ kind: "decision", title: `Gem in reach at (${gem[0]}, ${gem[1]})` });
        if (await go(gem)) await use(gem);
        return;
      }
      for (const door of k.find("RBY")) {
        const color = { R: "red", B: "blue", Y: "yellow" }[k.at(door)]!;
        if (!k.carries(`${color} key`)) continue;
        const spot = k.nearest((c) => same(c, door), true);
        if (!spot) continue;
        ctx.status(`Opening the ${color} door`);
        ctx.log({ kind: "decision", title: `Open the ${color} door at (${door[0]}, ${door[1]})` });
        if ((await go(spot)) && nextTo(Knowledge.read(ctx)!.status.position, door)) await use(door);
        return;
      }
      for (const keyCell of k.find("rby")) {
        if (!k.nearest((c) => same(c, keyCell))) continue;
        const color = { r: "red", b: "blue", y: "yellow" }[k.at(keyCell)]!;
        ctx.status(`Fetching the ${color} key`);
        ctx.log({ kind: "decision", title: `Fetch the ${color} key at (${keyCell[0]}, ${keyCell[1]})` });
        if (await go(keyCell)) await use(keyCell);
        return;
      }
      const frontier = k.nearest(
        (c) =>
          Object.values(DIRS).some(([dx, dy]) => k.at([c[0] + dx, c[1] + dy]) === "?") && !same(c, k.status.position),
      );
      if (frontier) {
        ctx.status("Exploring");
        await go(frontier);
        return;
      }
      ctx.status("Stuck: nothing reachable left to explore");
      ctx.release();
      await ctx.wait({ ms: 1000 });
    };

    void (async () => {
      ctx.engage();
      while (!ctx.signal.aborted) {
        try {
          await step();
        } catch (e) {
          if (ctx.signal.aborted) break;
          if (!(e instanceof NotInControlError))
            ctx.log({
              kind: "error",
              title: "Planner step failed",
              detail: e instanceof Error ? e.message : String(e),
            });
          await ctx.wait({ ms: 300 });
        }
      }
    })();
    return { authority: (has) => ctx.status(has ? undefined : "Paused while another controller drives") };
  },
};
