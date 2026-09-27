import { type Controller, NotInControlError } from "@awp-demo/agent";
import { z } from "zod";
import { binFor, CELL, type Color } from "../../shared/cell.ts";
import { readCell } from "./observe.ts";

const Config = z.object({
  speed_mps: z.number().min(0.2).max(1).default(0.7).meta({ title: "Arm Speed" }),
  pick: z.enum(["furthest", "nearest"]).default("furthest").meta({ title: "Pick Order" }),
});
type Config = z.infer<typeof Config>;

/**
 * A scripted sorter. Each cycle picks a parcel, meets it on the belt, grips it while tracking the
 * belt with the arm (two embodiments acting at once), and drops it in the bin of its colour. Any
 * interruption ends the cycle; the next one starts from fresh observations.
 */
export const program: Controller<Config> = {
  id: "program",
  kind: "program",
  label: "Program",
  description: "A scripted sorter that intercepts each parcel on the belt and drops it in the bin of its colour.",
  config: Config,
  create(ctx) {
    const arm = (x: number, z: number, v = ctx.config.speed_mps) =>
      ctx.submit(
        "move_to",
        { x_m: round(x), z_m: round(z), max_velocity_mps: round(Math.min(1, v)) },
        { embodiment: "arm_0", preempt: "replace" },
      );
    const gripper = (type: "grip" | "release") => ctx.submit(type, {}, { embodiment: "gripper_0", preempt: "replace" });
    const done = async (p: ReturnType<typeof arm>) => (await ctx.settle(await p)).state === "completed";

    const deliver = async (id: string) => {
      const color = readCell(ctx)?.parcels.find((p) => p.id === id)?.color as Color | undefined;
      if (!color) return;
      const bin = binFor(color);
      ctx.status(`Delivering ${id}`);
      if (!(await done(arm(bin.x, CELL.dropZ)))) return;
      await done(gripper("release"));
    };

    const cycle = async () => {
      // Plan only while in control; another controller may have moved things meanwhile.
      if (!ctx.hasAuthority) await ctx.acquire();
      const cell = readCell(ctx);
      if (!cell) return ctx.nextObservation();
      if (cell.holding) return deliver(cell.holding);
      const speed = ctx.config.speed_mps;
      const candidates = cell.parcels.filter((p) => p.on === "belt" && p.x > -0.86 && p.x < CELL.belt.x1 - 0.12);
      if (candidates.length === 0) {
        ctx.status("Waiting for parcels");
        const [hx, hz] = CELL.home;
        if (!cell.moving && Math.hypot(cell.ee[0] - hx, cell.ee[1] - hz) > 0.02) await done(arm(hx, hz));
        else await ctx.nextObservation();
        return;
      }
      candidates.sort((a, b) =>
        ctx.config.pick === "furthest" ? b.x - a.x : Math.abs(a.x - cell.ee[0]) - Math.abs(b.x - cell.ee[0]),
      );
      const target = candidates[0]!;
      // Meet the parcel where it will be when the arm arrives above it.
      const descendS = (CELL.hoverZ - CELL.graspZ) / speed;
      let meet = target.x;
      for (let i = 0; i < 3; i++) {
        const travelS = Math.hypot(meet - cell.ee[0], CELL.hoverZ - cell.ee[1]) / speed;
        meet = target.x + cell.beltMps * (travelS + descendS + 0.3);
      }
      meet = Math.min(meet, CELL.belt.x1 - 0.06);
      ctx.status(`Tracking ${target.id}`);
      ctx.log({ kind: "decision", title: `Intercept ${target.id} (${target.color}) at x ${meet.toFixed(2)}` });
      if (!(await done(arm(meet, CELL.hoverZ)))) return;
      // Wait for it to come under the gripper, then descend onto it.
      for (;;) {
        const p = readCell(ctx)?.parcels.find((x) => x.id === target.id);
        if (!p || p.on !== "belt") return;
        if (p.x >= meet - cell.beltMps * descendS - 0.004) break;
        await ctx.nextObservation();
      }
      const now = readCell(ctx)!.parcels.find((x) => x.id === target.id)!;
      if (!(await done(arm(now.x + cell.beltMps * descendS, CELL.graspZ)))) return;
      const grip = gripper("grip");
      const track = arm(readCell(ctx)!.ee[0] + cell.beltMps * 0.4, CELL.graspZ, Math.max(0.01, cell.beltMps));
      await ctx.settle(await grip);
      void track.then((r) => ctx.cancel(r.action_id)).catch(() => undefined);
      const after = readCell(ctx);
      if (after?.holding !== target.id) {
        ctx.log({ kind: "decision", title: `Missed ${target.id}; retrying` });
        await done(gripper("release"));
        return;
      }
      await deliver(target.id);
    };

    void (async () => {
      ctx.engage();
      while (!ctx.signal.aborted) {
        try {
          await cycle();
        } catch (e) {
          if (ctx.signal.aborted) break;
          if (!(e instanceof NotInControlError))
            ctx.log({ kind: "error", title: "Cycle failed", detail: e instanceof Error ? e.message : String(e) });
          await ctx.wait({ ticks: 4 });
        }
      }
    })();

    return {
      authority: (has) => {
        if (has) ctx.status(undefined);
        else ctx.status("Paused while another controller drives");
      },
    };
  },
};

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
