import type { Controller } from "@awp-demo/agent";
import type { ActionRecord } from "@hyperduality/awp";
import { z } from "zod";

const Config = z.object({
  speed_mps: z.number().min(0.5).max(2.5).default(1.6).meta({ title: "Speed" }),
  turn_radps: z.number().min(0.5).max(3.5).default(2.2).meta({ title: "Turn Rate" }),
  hold_ms: z.number().int().min(300).max(10000).default(1500).meta({ title: "Hand Back After (ms)" }),
});
type Config = z.infer<typeof Config>;

export type DriveInput =
  | { kind: "drive"; forward: number; strafe: number; turn: number; fast?: boolean }
  | { kind: "interact" }
  | { kind: "stop" };

/** Input older than this is treated as released: the deadman between the UI and the world. */
const DEADMAN_MS = 250;
/** Just inside the world's turn envelope. */
const TURN_LIMIT = 3.9;

/**
 * Keyboard teleop. While keys are held it runs a `teleop` streaming action and sends velocity
 * setpoints on the `drive` command channel at 30 Hz; when they are released it stops, and after a
 * pause it cancels the stream and hands control back.
 */
export const manual: Controller<Config> = {
  id: "manual",
  kind: "manual",
  label: "Manual",
  description: "You drive with the keyboard. Velocity setpoints stream on the drive command channel at 30 Hz.",
  config: Config,
  create(ctx) {
    let input: Extract<DriveInput, { kind: "drive" }> = { kind: "drive", forward: 0, strafe: 0, turn: 0 };
    let inputAt = 0;
    let activeAt = 0;
    let loop: Promise<void> | undefined;
    let teleop: ActionRecord | undefined;

    const zero = (i: typeof input) => i.forward === 0 && i.strafe === 0 && i.turn === 0;

    const run = async () => {
      ctx.log({ kind: "system", title: "Teleop engaged" });
      try {
        while (!ctx.signal.aborted) {
          if (!ctx.hasAuthority) await ctx.acquire();
          if (!teleop || teleop.terminal) {
            teleop = await ctx.submit("teleop", {}, { preempt: "replace" });
            await teleop.until((r) => r.state === "executing" || r.terminal);
            if (teleop.terminal) continue;
          }
          const now = Date.now();
          const live = now - inputAt < DEADMAN_MS ? input : { ...input, forward: 0, strafe: 0, turn: 0 };
          if (!zero(live)) activeAt = now;
          const k = live.fast ? 1.5 : 1;
          await ctx.command("drive", {
            forward_mps: round(live.forward * ctx.config.speed_mps * k),
            strafe_mps: round(live.strafe * ctx.config.speed_mps * 0.8),
            // The world rejects turn setpoints beyond 4 rad/s (AWP-CMD-006); stay just inside it.
            turn_radps: round(Math.max(-TURN_LIMIT, Math.min(TURN_LIMIT, live.turn * ctx.config.turn_radps))),
          });
          if (now - activeAt > ctx.config.hold_ms) break;
          await new Promise((r) => setTimeout(r, 33));
        }
      } finally {
        if (teleop && !teleop.terminal) await ctx.cancel(teleop.action_id).catch(() => undefined);
        teleop = undefined;
        loop = undefined;
        ctx.log({ kind: "system", title: "Teleop released" });
        ctx.release();
      }
    };

    return {
      input(raw) {
        const i = raw as DriveInput;
        if (i.kind === "drive") {
          input = i;
          inputAt = Date.now();
          if (!zero(i)) {
            activeAt = inputAt;
            ctx.engage();
            loop ??= run();
          }
        } else if (i.kind === "interact") {
          ctx.engage();
          activeAt = Date.now();
          loop ??= run();
          void ctx.submit("interact", {}).catch(() => undefined);
        } else {
          input = { kind: "drive", forward: 0, strafe: 0, turn: 0 };
        }
      },
    };
  },
};

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
