import type { Controller } from "@awp-demo/agent";
import { AwpError } from "@hyperduality/awp";
import { z } from "zod";
import { type Cell, DIRS, type StatusPayload } from "../../shared/vault.ts";

const Config = z.object({
  hold_ms: z.number().int().min(500).max(10000).default(2500).meta({ title: "Hand Back After (ms)" }),
});
type Config = z.infer<typeof Config>;

export type VaultInput =
  | { kind: "move"; direction: keyof typeof DIRS }
  | { kind: "walk"; cell: Cell }
  | { kind: "use"; ahead: boolean };

/** Arrows step, a click walks there, E uses the tile ahead and Space the tile underfoot. */
export const manual: Controller<Config> = {
  id: "manual",
  kind: "manual",
  label: "Manual",
  description: "You explore: arrows step, click a seen tile to walk there, E uses the tile ahead, Space picks up.",
  config: Config,
  create(ctx) {
    let timer: NodeJS.Timeout | undefined;
    const submit = (type: string, params: Record<string, unknown>, preempt: "queue" | "replace") =>
      ctx.submit(type, params, { preempt }).catch((e) => {
        if (!(e instanceof AwpError)) throw e;
      });
    return {
      input(raw) {
        const i = raw as VaultInput;
        ctx.engage();
        clearTimeout(timer);
        timer = setTimeout(() => ctx.release(), ctx.config.hold_ms);
        if (i.kind === "move") void submit("move", { direction: i.direction }, "queue");
        else if (i.kind === "walk") void submit("walk_to", { cell: i.cell }, "replace");
        else {
          const s = ctx.latest<StatusPayload>("status");
          if (!s) return;
          const [dx, dy] = i.ahead ? DIRS[s.facing] : [0, 0];
          void submit("interact", { cell: [s.position[0] + dx, s.position[1] + dy] }, "queue");
        }
      },
      stop: () => clearTimeout(timer),
    };
  },
};
