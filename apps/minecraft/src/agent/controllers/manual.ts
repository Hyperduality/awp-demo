import type { Controller } from "@awp-demo/agent";
import { z } from "zod";
import { attempt, chunk, worldKeys } from "./input.ts";

const Config = z.object({
  sensitivity: z.number().min(0.1).max(4).default(1).meta({ title: "Mouse Sensitivity" }),
  release_ms: z.number().int().min(500).max(10000).default(2000).meta({ title: "Hand Back After (ms)" }),
});
type Config = z.infer<typeof Config>;

/** A sample from the browser: the keys down now, and the mouse motion since the last sample. */
export interface ManualInput {
  keys: string[];
  dx: number;
  dy: number;
}

/**
 * You at the keyboard and mouse. On every observation it sends what is down now as two slots, the
 * second holding the same keys over the slot boundary, replacing the chunk before. If a sample is late,
 * the hold-over keeps the keys down; the next chunk takes over at the boundary without a release.
 */
export const manual: Controller<Config> = {
  id: "manual",
  kind: "manual",
  label: "Manual",
  description:
    "You play: click the view to capture the mouse, then WASD, Space, Shift, Ctrl, the mouse buttons and 1–9. Esc lets go.",
  config: Config,
  create(ctx) {
    let keys: string[] = [];
    let dx = 0;
    let dy = 0;
    let idle: NodeJS.Timeout | undefined;
    const loop = async () => {
      while (!ctx.signal.aborted) {
        await ctx.nextObservation();
        if (!ctx.hasAuthority) continue;
        const slot = { keys, ...(dx ? { mouse_dx: dx } : {}), ...(dy ? { mouse_dy: dy } : {}) };
        dx = 0;
        dy = 0;
        await attempt(ctx.submit("input_chunk", chunk([slot, { keys }]), { preempt: "replace" }));
      }
    };
    void loop();
    return {
      input(raw) {
        const i = raw as ManualInput;
        keys = worldKeys(i.keys);
        dx += Math.round(i.dx * ctx.config.sensitivity);
        dy += Math.round(i.dy * ctx.config.sensitivity);
        ctx.engage();
        ctx.status(keys.length ? keys.join(" ") : "Playing");
        clearTimeout(idle);
        // With nothing held, control goes back to the other controllers after a pause.
        if (keys.length === 0) idle = setTimeout(() => ctx.release(), ctx.config.release_ms);
      },
      stop: () => clearTimeout(idle),
    };
  },
};
