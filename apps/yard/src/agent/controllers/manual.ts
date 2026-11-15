import type { Controller } from "@awp-demo/agent";
import { type ActionRecord, AwpError } from "@hyperduality/awp";
import { z } from "zod";
import type { DriveSetpoint } from "../../shared/yard.ts";
import { attempt } from "./observe.ts";

const Config = z.object({
  speed_mps: z.number().min(0.5).max(3).default(2).meta({ title: "Top Speed (m/s)" }),
  steer_rad: z.number().min(0.3).max(1.2).default(0.9).meta({ title: "Full Lock (rad)" }),
  release_ms: z.number().int().min(500).max(10000).default(2500).meta({ title: "Hand Back After (ms)" }),
});
type Config = z.infer<typeof Config>;

/** A sample from the browser: each axis from -1 to 1, as the keys or a gamepad have it now. */
export interface ManualInput {
  throttle: number;
  steer: number;
  lift: number;
  tilt: number;
}

const RATE_HZ = 30;
const axis = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

/**
 * You at the controls. The first input starts a `teleop` action; from then on the sticks go out as
 * setpoints on its command channel thirty times a second. With everything let go for a while it ends
 * the action and hands control back.
 */
export const manual: Controller<Config> = {
  id: "manual",
  kind: "manual",
  label: "Manual",
  description:
    "You drive: click the view, then W and S for speed, A and D to steer, R and F for the forks, T and G to tilt. A gamepad works too.",
  config: Config,
  create(ctx) {
    let input: ManualInput = { throttle: 0, steer: 0, lift: 0, tilt: 0 };
    let action: ActionRecord | undefined;
    let starting = false;
    let idleSince = Date.now();
    const quiet = () => input.throttle === 0 && input.steer === 0 && input.lift === 0 && input.tilt === 0;
    const live = () => action !== undefined && ["submitted", "accepted", "queued", "executing"].includes(action.state);

    const timer = setInterval(() => {
      if (ctx.signal.aborted) return;
      if (!quiet()) idleSince = Date.now();
      if (!live()) {
        action = undefined;
        if (quiet() || starting) return;
        starting = true;
        ctx.engage();
        void attempt(ctx.submit("teleop", {}, { preempt: "replace" })).then((rec) => {
          starting = false;
          if (rec && !(rec instanceof AwpError)) action = rec;
        });
        return;
      }
      if (!ctx.hasAuthority) return;
      if (Date.now() - idleSince > ctx.config.release_ms) {
        const done = action;
        action = undefined;
        if (done) void ctx.cancel(done.action_id).catch(() => undefined);
        ctx.status(undefined);
        ctx.release();
        return;
      }
      const setpoint: DriveSetpoint = {
        v_mps: input.throttle * ctx.config.speed_mps,
        steer_rad: input.steer * ctx.config.steer_rad,
        lift_mps: input.lift * 0.45,
        tilt_radps: input.tilt * 0.12,
      };
      void ctx.command("drive", setpoint).catch(() => undefined);
    }, 1000 / RATE_HZ);

    return {
      input(raw) {
        const i = raw as Partial<ManualInput>;
        input = { throttle: axis(i.throttle), steer: axis(i.steer), lift: axis(i.lift), tilt: axis(i.tilt) };
        if (!quiet()) {
          idleSince = Date.now();
          ctx.engage();
          ctx.status("Driving");
        }
      },
      interrupt() {
        input = { throttle: 0, steer: 0, lift: 0, tilt: 0 };
        idleSince = 0;
      },
      stop: () => clearInterval(timer),
    };
  },
};
