import type { Controller } from "@awp-demo/agent";
import { AwpError } from "@hyperduality/awp";
import { z } from "zod";
import type { UnitsPayload } from "../../shared/city.ts";
import { basisOf } from "./board.ts";

const Config = z.object({
  hold_ms: z.number().int().min(1000).max(20000).default(4000).meta({ title: "Hand Back After (ms)" }),
});
type Config = z.infer<typeof Config>;

export type DispatchInput =
  | { kind: "dispatch"; unit: string; call: number }
  | { kind: "stage"; unit: string; at: string }
  | { kind: "cancel"; unit: string };

/** You at the desk: pick a unit on the map, then a call to send it to or an intersection to stage at. */
export const manual: Controller<Config> = {
  id: "manual",
  kind: "manual",
  label: "Manual",
  description:
    "You dispatch: click a unit, then a call to send it there or an intersection to stage it. The model or the rules carry on with the units you leave alone.",
  config: Config,
  create(ctx) {
    let timer: NodeJS.Timeout | undefined;
    const act = (p: Promise<unknown>) =>
      p.catch((e) => {
        if (!(e instanceof AwpError)) throw e;
      });
    return {
      input(raw) {
        const i = raw as DispatchInput;
        ctx.engage();
        clearTimeout(timer);
        timer = setTimeout(() => ctx.release(), ctx.config.hold_ms);
        if (i.kind === "dispatch")
          void act(ctx.submit("dispatch", { call: i.call }, { embodiment: i.unit, basis: basisOf(ctx) }));
        else if (i.kind === "stage")
          void act(ctx.submit("stage", { at: i.at }, { embodiment: i.unit, basis: basisOf(ctx) }));
        else {
          const id = ctx.latest<UnitsPayload>("units")?.units.find((u) => u.id === i.unit)?.action_id;
          if (id) void act(ctx.cancel(id));
        }
      },
      stop: () => clearTimeout(timer),
    };
  },
};
