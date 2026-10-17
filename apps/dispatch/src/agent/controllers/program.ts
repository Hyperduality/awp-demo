import { type Controller, NotInControlError } from "@awp-demo/agent";
import { AwpError } from "@hyperduality/awp";
import { z } from "zod";
import { KINDS } from "../../shared/city.ts";
import { basisOf, readBoard, triage } from "./board.ts";

const Config = z.object({});
type Config = z.infer<typeof Config>;

/**
 * The baseline: keyword triage and the nearest free unit. Twice a second it reads each open call,
 * oldest first, guesses from its words which kinds it needs, and sends the closest available unit
 * of each kind still missing. It reacts at once, and is fooled by words: "fired", "barbecue smoke".
 */
export const program: Controller<Config> = {
  id: "program",
  kind: "program",
  label: "Rules",
  description: "Keyword triage: sends the nearest free unit of each kind a call's words suggest, oldest call first.",
  config: Config,
  enabled: false,
  create(ctx) {
    const pass = async () => {
      const board = readBoard(ctx);
      if (board?.shift?.phase !== "on") {
        ctx.status(board?.shift?.phase === "over" ? "The shift is over" : "Waiting for the shift");
        return;
      }
      const used = new Set<string>();
      const free = board.units.filter((u) => u.status === "available" || u.status === "staging");
      ctx.status(`${board.calls.open.length} open · ${free.length} free`);
      for (const call of board.calls.open) {
        const want = triage(call);
        for (const kind of KINDS) {
          const sent = call.units.filter((s) => board.units.find((u) => u.id === s.unit)?.kind === kind).length;
          for (let n = sent; n < want[kind]; n++) {
            const unit = free
              .filter((u) => u.kind === kind && !used.has(u.id))
              .sort((a, b) => (call.eta_s[a.id] ?? Infinity) - (call.eta_s[b.id] ?? Infinity))[0];
            if (!unit) break;
            used.add(unit.id);
            ctx.log({ kind: "decision", title: `#${call.id} needs a ${kind} unit: ${unit.id}` });
            try {
              await ctx.submit("dispatch", { call: call.id }, { embodiment: unit.id, basis: basisOf(ctx) });
            } catch (e) {
              if (!(e instanceof AwpError)) throw e;
            }
          }
        }
      }
    };

    void (async () => {
      ctx.engage();
      while (!ctx.signal.aborted) {
        try {
          if (!ctx.hasAuthority) await ctx.acquire();
          await pass();
        } catch (e) {
          if (ctx.signal.aborted) break;
          if (!(e instanceof NotInControlError))
            ctx.log({ kind: "error", title: "Rules pass failed", detail: e instanceof Error ? e.message : String(e) });
        }
        await ctx.wait({ ms: 500 });
      }
    })();
    return { authority: (has) => ctx.status(has ? undefined : "Waiting while another controller dispatches") };
  },
};
