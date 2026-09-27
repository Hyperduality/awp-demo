import type { Controller } from "@awp-demo/agent";
import { AwpError } from "@hyperduality/awp";
import { z } from "zod";
import { readCell } from "./observe.ts";

const Config = z.object({
  hold_ms: z.number().int().min(500).max(10000).default(2500).meta({ title: "Hand Back After (ms)" }),
  speed_mps: z.number().min(0.1).max(1).default(0.5).meta({ title: "Arm Speed" }),
});
type Config = z.infer<typeof Config>;

export type ManualInput =
  | { kind: "target"; x: number; z: number }
  | { kind: "jog"; dx: number; dz: number }
  | { kind: "grip" }
  | { kind: "release" }
  | { kind: "stop" };

/** The operator: click to move the arm there, arrows to jog, G and R to grip and release. */
export const manual: Controller<Config> = {
  id: "manual",
  kind: "manual",
  label: "Manual",
  description:
    "You drive: click the cell to move the arm there, arrows to jog, G to grip, R to release. Control returns after a pause.",
  config: Config,
  create(ctx) {
    let timer: NodeJS.Timeout | undefined;
    let aim: [number, number] | undefined;
    const hold = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        aim = undefined;
        ctx.release();
      }, ctx.config.hold_ms);
    };
    const submit = (type: string, params: Record<string, unknown>, embodiment: string) =>
      ctx.submit(type, params, { embodiment, preempt: "replace" }).catch((e) => {
        if (!(e instanceof AwpError)) throw e;
      });
    return {
      input(raw) {
        const i = raw as ManualInput;
        ctx.engage();
        hold();
        const v = ctx.config.speed_mps;
        switch (i.kind) {
          case "target":
            aim = [i.x, i.z];
            void submit("move_to", { x_m: round(i.x), z_m: round(i.z), max_velocity_mps: v }, "arm_0");
            break;
          case "jog": {
            const base = aim ?? readCell(ctx)?.ee;
            if (!base) return;
            aim = [base[0] + i.dx, base[1] + i.dz];
            void submit("move_to", { x_m: round(aim[0]), z_m: round(aim[1]), max_velocity_mps: v }, "arm_0");
            break;
          }
          case "grip":
          case "release":
            void submit(i.kind, {}, "gripper_0");
            break;
          case "stop":
            aim = undefined;
            void submit("stop", {}, "arm_0");
            break;
        }
      },
      stop: () => clearTimeout(timer),
    };
  },
};

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
