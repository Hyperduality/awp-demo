import type { Controller } from "@awp-demo/agent";
import { AwpError } from "@hyperduality/awp";
import { z } from "zod";
import { attempt, chunk, hold, pose } from "./input.ts";

const Config = z.object({
  seed: z.number().int().default(7).meta({ title: "Seed" }),
});
type Config = z.infer<typeof Config>;

/**
 * The scripted baseline: walk a second at a time, glance around now and then, and when a walk gets
 * nowhere (a wall, a tree), jump and turn.
 */
export const program: Controller<Config> = {
  id: "program",
  kind: "program",
  label: "Wanderer",
  description: "A script: walks forward a second at a time, looks around, and jumps and turns when blocked.",
  config: Config,
  enabled: false,
  create(ctx) {
    let state = ctx.config.seed >>> 0 || 1;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const loop = async () => {
      await ctx.acquire();
      while (!ctx.signal.aborted) {
        const before = pose(ctx);
        const glance = random() < 0.25;
        const slots = glance
          ? hold([], 600, (random() - 0.5) * 120, (random() - 0.5) * 20)
          : hold(["KeyW", ...(random() < 0.3 ? ["ControlLeft"] : [])], 1000, (random() - 0.5) * 30);
        const rec = await attempt(ctx.submit("input_chunk", chunk(slots), { preempt: "replace" }));
        if (!rec || rec instanceof AwpError) {
          await ctx.wait({ ticks: 4 });
          continue;
        }
        await ctx.settle(rec);
        const after = pose(ctx);
        const moved = before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 1;
        if (!glance && moved < 1) {
          ctx.status("Blocked: jumping and turning");
          const turn = (random() < 0.5 ? -1 : 1) * (60 + random() * 90);
          const out = await attempt(
            ctx.submit("input_chunk", chunk(hold(["KeyW", "Space"], 500, turn)), { preempt: "replace" }),
          );
          if (out && !(out instanceof AwpError)) await ctx.settle(out);
        } else ctx.status(glance ? "Looking around" : `Walked ${moved.toFixed(1)} blocks`);
      }
    };
    void loop();
    return {};
  },
};
