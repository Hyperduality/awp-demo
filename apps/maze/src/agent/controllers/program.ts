import { type Controller, NotInControlError } from "@awp-demo/agent";
import { z } from "zod";
import type { PosePayload } from "../../shared/maze.ts";
import { followPath, progressOf, TileMap, tileOf } from "./mapping.ts";

const Config = z.object({
  lookaround: z.boolean().default(true).meta({ title: "Scan At Junctions" }),
});
type Config = z.infer<typeof Config>;

/**
 * An autopilot that maps as it goes: it heads for cores it has seen, explores the nearest frontier
 * otherwise, and leaves by the exit once every core is collected. It knows only what its sensors show.
 */
export const program: Controller<Config> = {
  id: "program",
  kind: "program",
  label: "Autopilot",
  description: "Maps the maze from its range scan, collects every core it sees, explores otherwise, then leaves.",
  config: Config,
  enabled: false,
  create(ctx) {
    const map = new TileMap(ctx);
    let scanned = false;
    let escaped = false;

    const step = async () => {
      if (progressOf(ctx)?.escaped || escaped) {
        ctx.release();
        ctx.status("Escaped");
        return ctx.wait({ ms: 1000 });
      }
      if (!ctx.hasAuthority) await ctx.acquire();
      const pose = ctx.latest<PosePayload>("pose");
      const progress = progressOf(ctx);
      if (!pose || !progress) return ctx.wait({ ms: 100 });
      if (!scanned && ctx.config.lookaround) {
        scanned = true;
        ctx.log({ kind: "decision", title: "Look around" });
        await ctx.settle(await ctx.submit("turn", { angle_rad: 6.2 }, { preempt: "replace" }));
        return;
      }
      const here = tileOf(pose.x_m, pose.y_m);
      if (progress.exit_open && map.exit) {
        const [ex, ey] = map.exit;
        const path = map.path(here, (t) => Math.abs(t[0] - ex) + Math.abs(t[1] - ey) === 1);
        if (path) {
          ctx.status("Heading for the exit");
          if (path.length > 1 && !(await followPath(ctx, path))) return;
          const rec = await ctx.settle(await ctx.submit("interact", {}));
          if (rec.state === "completed") {
            escaped = true;
            ctx.log({ kind: "decision", title: `Escaped in ${progressOf(ctx)?.elapsed_s.toFixed(1)} s` });
          }
          return;
        }
      }
      const cores = [...map.cores.values()];
      const toCore =
        cores.length > 0 ? map.path(here, (t) => cores.some((c) => c[0] === t[0] && c[1] === t[1])) : undefined;
      if (toCore) {
        const t = toCore[toCore.length - 1]!;
        ctx.status(`Collecting core at ${t[0]}, ${t[1]}`);
        ctx.log({ kind: "decision", title: `Core seen at tile ${t[0]}, ${t[1]}; ${toCore.length - 1} tiles away` });
        await followPath(ctx, toCore);
        return;
      }
      const frontier = map.frontier(here) ?? (progress.exit_open ? undefined : map.unvisitedDeadEnd(here));
      if (!frontier) {
        ctx.status("Nothing left to explore");
        return ctx.wait({ ms: 500 });
      }
      ctx.status(
        progress.exit_open
          ? "Looking for the exit"
          : `Exploring · ${progress.cores_collected} of ${progress.cores_total}`,
      );
      // Explore one straight run at a time so new sightings are acted on promptly.
      await followPath(ctx, frontier, 1);
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
              title: "Autopilot step failed",
              detail: e instanceof Error ? e.message : String(e),
            });
          await ctx.wait({ ms: 250 });
        }
      }
    })();
    return {
      authority: (has) => ctx.status(has ? undefined : "Paused while another controller drives"),
    };
  },
};
