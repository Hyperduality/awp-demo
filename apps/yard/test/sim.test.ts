import type { RunStatus } from "@awp-demo/world";
import { describe, expect, it } from "vitest";
import type { Proprio, Scene, TaskObs } from "../src/shared/yard.ts";
import { YardSim } from "../src/world/sim.ts";

const DT = 1000 / 60;

/** Run one action to its end, stepping the sim as the host does: the run, then the world. */
function act(sim: YardSim, type: string, params: Record<string, unknown>, limitS = 120): RunStatus & { t: number } {
  const verdict = sim.admit("forklift_0", type, params);
  if (!("ok" in verdict)) return { failed: verdict.error, detail: verdict.detail, t: 0 };
  const run = sim.start("forklift_0", type, params);
  for (let t = 0; t < limitS; t += DT / 1000) {
    const s = run.update(DT);
    sim.step(DT);
    if ("done" in s || "failed" in s) return { ...s, t };
  }
  return { failed: "timeout", t: limitS };
}

const idle = (sim: YardSim, seconds: number) => {
  for (let t = 0; t < seconds; t += DT / 1000) sim.step(DT);
};
const proprio = (sim: YardSim) => sim.observe("proprio") as Proprio;
const task = (sim: YardSim) => sim.observe("task") as TaskObs;
const seen = (sim: YardSim) =>
  (sim.observe("scene") as Scene).entities.filter((e) => e.state?.source === "sensors").map((e) => e.id);
/** Drive to where the receiving pad is in view, as an agent that wants its pallets has to. */
const look = (sim: YardSim) => act(sim, "drive_to", { x_m: -2, y_m: 0, yaw_rad: Math.PI });

// Whole deliveries in physics: a few seconds here, longer on a shared CI runner.
describe("yard", { timeout: 30000 }, () => {
  it("lays out the same yard and orders from the same seed", async () => {
    const a = await YardSim.create(5, "default");
    const b = await YardSim.create(5, "default");
    const c = await YardSim.create(6, "default");
    expect(task(a).orders).toEqual(task(b).orders);
    expect(task(a).orders).toHaveLength(3);
    idle(a, 2);
    idle(b, 2);
    expect(a.pw.hash()).toBe(b.pw.hash());
    expect(a.pw.hash()).not.toBe(c.pw.hash());
  });

  it("leaves every load standing on its pallet", async () => {
    const sim = await YardSim.create(3, "default");
    idle(sim, 4);
    const all = sim.view().task;
    expect(all.orders.every((o) => o.intact === 1)).toBe(true);
    expect(all.score).toBe(0);
    expect(all.log).toEqual([]);
  });

  it("knows of the pallets only what its sensors have picked out", async () => {
    const sim = await YardSim.create(3, "default");
    idle(sim, 1);
    // Parked by the bays facing the trailer: the receiving pad is behind it and out of the lidar's reach.
    const first = seen(sim);
    expect(first).toContain("pallet_7");
    expect(first.filter((id) => /^pallet_[1-6]$/.test(id))).toEqual([]);
    const map = (sim.observe("scene") as Scene).entities.filter((e) => e.state?.source === "site_map").map((e) => e.id);
    expect(map).toEqual(expect.arrayContaining(["trailer", "container_1", "bay_a", "trailer_2", "receiving_pad"]));
    expect(act(sim, "pick_pallet", { pallet: "pallet_1" })).toMatchObject({
      failed: "x-yard.unseen",
      detail: expect.stringMatching(/have not seen pallet_1/),
    });

    expect(look(sim)).toMatchObject({ done: true });
    expect(
      seen(sim)
        .filter((id) => /^pallet_[1-6]$/.test(id))
        .sort(),
    ).toEqual([1, 2, 3, 4, 5, 6].map((n) => `pallet_${n}`));
    const pallet = (sim.observe("scene") as Scene).entities.find((e) => e.id === "pallet_1")!;
    expect(pallet.state?.label).toMatch(/^Pallet 1 \(/);
    expect(pallet.pose.p_m[0]).toBeCloseTo(-12, 1);

    // Back by the bays, they are out of sight again: gone from the scene, though the truck could still fetch one.
    expect(act(sim, "drive_to", { x_m: 9, y_m: -11, yaw_rad: Math.PI / 2 })).toMatchObject({ done: true });
    expect(seen(sim).filter((id) => /^pallet_[1-6]$/.test(id))).toEqual([]);
  });

  it("drives to a pose and reports where it is", async () => {
    const sim = await YardSim.create(3, "empty");
    idle(sim, 1);
    const r = act(sim, "drive_to", { x_m: 8, y_m: 5, yaw_rad: Math.PI / 2 });
    expect(r).toMatchObject({ done: true });
    const p = proprio(sim);
    expect(p.pose.p_m[0]).toBeCloseTo(8, 0);
    expect(Math.abs(p.pose.p_m[0] - 8)).toBeLessThan(0.12);
    expect(Math.abs(p.pose.p_m[1] - 5)).toBeLessThan(0.08);
    expect(Math.abs(p.yaw_rad - Math.PI / 2)).toBeLessThan(0.06);
    expect(Math.abs(p.v_mps)).toBeLessThan(0.05);
  });

  it("refuses a target outside the yard and a pallet that is not there", async () => {
    const sim = await YardSim.create(3, "empty");
    expect(sim.admit("forklift_0", "drive_to", { x_m: 40, y_m: 0 })).toMatchObject({ error: "AWP_ENVELOPE_EXCEEDED" });
    expect(sim.admit("forklift_0", "pick_pallet", { pallet: "pallet_1" })).toMatchObject({
      error: "AWP_PARAMS_INVALID",
    });
    expect(act(sim, "place_pallet", { bay: "bay_a" })).toMatchObject({ failed: "x-yard.empty" });
  });

  it("stops for a container rather than drive into it", async () => {
    const sim = await YardSim.create(3, "default");
    idle(sim, 1);
    const r = act(sim, "drive_to", { x_m: -11, y_m: 13.4 });
    expect(r).toMatchObject({ failed: "x-yard.blocked", detail: expect.stringMatching(/no clear way/) });
    expect(task(sim).log.join()).not.toMatch(/impact/);
  });

  it("delivers a pallet to a ground bay", async () => {
    const sim = await YardSim.create(3, "default");
    idle(sim, 1);
    const order = task(sim).orders.find((o) => o.bay.startsWith("bay_"))!;
    expect(look(sim)).toMatchObject({ done: true });
    const pick = act(sim, "pick_pallet", { pallet: order.pallet });
    expect(pick).toMatchObject({ done: true });
    expect(proprio(sim).carrying).toBe(order.pallet);
    expect(proprio(sim).load_kg).toBeGreaterThan(200);
    expect(task(sim).orders.find((o) => o.pallet === order.pallet)?.status).toBe("carried");
    const place = act(sim, "place_pallet", { bay: order.bay });
    expect(place).toMatchObject({ done: true });
    idle(sim, 1);
    const done = task(sim).orders.find((o) => o.pallet === order.pallet)!;
    expect(done.status).toBe("delivered");
    expect(task(sim).score).toBe(100);
    expect(proprio(sim).carrying).toBeNull();
    expect(sim.view().task.orders.find((o) => o.pallet === order.pallet)?.intact).toBe(1);
    expect(sim.view().task.score).toBe(100);
  });

  it("loads a pallet onto the trailer", async () => {
    const sim = await YardSim.create(3, "default");
    idle(sim, 1);
    const order = task(sim).orders.find((o) => o.bay.startsWith("trailer_"))!;
    expect(look(sim)).toMatchObject({ done: true });
    expect(act(sim, "pick_pallet", { pallet: order.pallet })).toMatchObject({ done: true });
    expect(act(sim, "place_pallet", { bay: order.bay })).toMatchObject({ done: true });
    idle(sim, 1);
    expect(task(sim).orders.find((o) => o.pallet === order.pallet)?.status).toBe("delivered");
    expect(sim.pw.pose(order.pallet).p[2]).toBeCloseTo(1.25, 1);
    // Backed out and facing it, the truck sees the pallet where it put it.
    const scene = sim.observe("scene") as Scene;
    expect(scene.relations).toContainEqual({ type: "in", subject: order.pallet, object: order.bay });
    expect(proprio(sim).tipped).toBe(false);
  });

  it("fails to pick the concrete block, and says why", async () => {
    const sim = await YardSim.create(3, "default");
    idle(sim, 1);
    const r = act(sim, "pick_pallet", { pallet: "pallet_7" });
    expect(r).toMatchObject({ failed: "x-yard.overload" });
    expect(task(sim).log.join()).toMatch(/hoist stalled/);
    expect(proprio(sim).tipped).toBe(false);
  });

  it("serves the binary sensor channels at their declared sizes", async () => {
    const sim = await YardSim.create(3, "default");
    idle(sim, 1);
    const depth = sim.observe("depth") as { bytes: Uint8Array };
    const rgb = sim.observe("rgb") as { bytes: Uint8Array };
    const lidar = sim.observe("lidar") as { bytes: Uint8Array };
    expect(depth.bytes.byteLength).toBe(96 * 64 * 4);
    expect(rgb.bytes.byteLength).toBe(96 * 64 * 3);
    expect(lidar.bytes.byteLength % 12).toBe(0);
    expect(lidar.bytes.byteLength).toBeGreaterThan(12 * 300);
    const d = new Float32Array(depth.bytes.buffer, depth.bytes.byteOffset, 96 * 64);
    // The ground just ahead fills the bottom row; the trailer is twenty metres off in the middle.
    expect(d[63 * 96 + 48]).toBeGreaterThan(1);
    expect(d[63 * 96 + 48]).toBeLessThan(5);
    expect(Math.min(...Array.from(d.subarray(20 * 96, 44 * 96)).filter((x) => x > 0))).toBeLessThan(25);
  });
});
