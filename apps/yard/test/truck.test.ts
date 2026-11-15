import { PhysicsWorld, upZ } from "@awp-demo/physics";
import { describe, expect, it } from "vitest";
import { TRUCK, Truck, truckBodies } from "../src/world/forklift.ts";
import { load, pallet, yardStatics } from "../src/world/scenarios.ts";

async function rig(kind?: "crate" | "block" | "cartons") {
  const pw = await PhysicsWorld.create({ bodies: [yardStatics()[0]!, ...truckBodies("truck", 1, [0, 0, 0], 0)] });
  if (kind) {
    pw.add(pallet("pallet", [4, 0, 0.002], 0));
    for (const b of load(kind, "load", [4, 0, 0.002], 0)) pw.add(b);
  }
  const truck = new Truck(pw, "truck", 1);
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < seconds * 120; i++) {
      each?.();
      truck.update(pw.dt_s);
      pw.step();
    }
  };
  return { pw, truck, run };
}

describe("truck", () => {
  it("settles level with the forks just off the ground", async () => {
    const { pw, truck, run } = await rig();
    run(2);
    const s = truck.state();
    expect(s.wheels_grounded).toBe(4);
    expect(upZ(s.base.q)).toBeGreaterThan(0.9995);
    expect(Math.abs(s.base.p[2])).toBeLessThan(0.03);
    const forkBottom = truck.forkSpan().tip[2] - 0.02;
    expect(forkBottom).toBeGreaterThan(0.03);
    expect(forkBottom).toBeLessThan(0.08);
    const before = pw.pose("truck").p[0];
    run(5);
    expect(Math.abs(pw.pose("truck").p[0] - before)).toBeLessThan(0.005);
  });

  it("holds a commanded speed, turns left on positive steer, and stops", async () => {
    const { truck, run } = await rig();
    run(1);
    truck.setpoint = { v_mps: 2, steer_rad: 0, lift_mps: 0, tilt_radps: 0 };
    run(4);
    expect(truck.state().v_mps).toBeCloseTo(2, 1);
    expect(truck.state().base.p[0]).toBeGreaterThan(5);
    truck.setpoint = { v_mps: 2, steer_rad: 0.4, lift_mps: 0, tilt_radps: 0 };
    run(2);
    expect(truck.state().yaw_rad).toBeGreaterThan(0.5);
    expect(truck.state().yaw_rate_radps).toBeGreaterThan(0.2);
    truck.setpoint = { v_mps: -1.5, steer_rad: 0, lift_mps: 0, tilt_radps: 0 };
    run(4);
    expect(truck.state().v_mps).toBeCloseTo(-1.5, 1);
    truck.halt();
    run(3);
    expect(Math.abs(truck.state().v_mps)).toBeLessThan(0.02);
    expect(truck.tipped).toBe(false);
  });

  it("narrows the steering with speed", () => {
    expect(Truck.steerLimit(0.3)).toBe(TRUCK.maxSteer_rad);
    expect(Truck.steerLimit(3)).toBeLessThan(0.4);
    expect(Truck.limit({ v_mps: 9, steer_rad: 0, lift_mps: 0, tilt_radps: 0 }, 0)).toEqual({
      setpoint: { v_mps: 3, steer_rad: 0, lift_mps: 0, tilt_radps: 0 },
      clamped: true,
    });
  });

  it("forks a pallet, lifts the crate, carries it and sets it down", async () => {
    const { pw, truck, run } = await rig("crate");
    run(1);
    // Creep in until the carriage is against the pallet.
    run(8, () => {
      const gap = pw.pose("pallet").p[0] - 0.6 - truck.forkSpan().heel[0];
      truck.setpoint.v_mps = gap > 0.04 ? Math.min(0.8, 0.2 + gap) : 0;
    });
    expect(Math.abs(pw.pose("pallet").p[0] - 4)).toBeLessThan(0.05);
    expect(pw.pose("pallet").p[0] - 0.6 - truck.forkSpan().heel[0]).toBeLessThan(0.08);
    truck.liftGoal_m = 1.2;
    truck.tiltGoal_rad = 0.07;
    run(5);
    expect(truck.liftSettled).toBe(true);
    expect(truck.state().fork_height_m).toBeCloseTo(1.2, 1);
    expect(truck.state().tilt_rad).toBeCloseTo(0.07, 1);
    expect(pw.pose("load_1").p[2]).toBeGreaterThan(1.6);
    truck.setpoint.v_mps = -1.5;
    run(4);
    truck.halt();
    run(3);
    const crate = pw.pose("load_1").p;
    const deck = pw.pose("pallet").p;
    expect(Math.hypot(crate[0] - deck[0], crate[1] - deck[1])).toBeLessThan(0.06);
    truck.liftGoal_m = 0;
    truck.tiltGoal_rad = 0;
    run(5);
    expect(pw.pose("pallet").p[2]).toBeLessThan(0.02);
    truck.setpoint.v_mps = -1;
    run(3);
    truck.halt();
    run(2);
    expect(pw.pose("pallet").p[2]).toBeLessThan(0.02);
    expect(pw.pose("load_1").p[2]).toBeCloseTo(0.144 + 0.4, 1);
    expect(truck.tipped).toBe(false);
  });

  it("stalls on a load beyond the hoist", async () => {
    const { pw, truck, run } = await rig("block");
    run(1);
    run(8, () => {
      const gap = pw.pose("pallet").p[0] - 0.6 - truck.forkSpan().heel[0];
      truck.setpoint.v_mps = gap > 0.04 ? Math.min(0.8, 0.2 + gap) : 0;
    });
    truck.liftGoal_m = 1;
    run(4);
    expect(truck.stalled).toBe(true);
    expect(pw.pose("load_1").p[2]).toBeLessThan(0.6);
    expect(truck.state().fork_height_m).toBeLessThan(0.15);
    expect(truck.tipped).toBe(false);
    // Giving up lets the hoist settle again.
    truck.liftGoal_m = 0;
    run(2);
    expect(truck.stalled).toBe(false);
  });
});
