import { describe, expect, it } from "vitest";
import {
  type BodyDesc,
  boxInertia,
  castCamera,
  castLidar,
  initRapier,
  PhysicsWorld,
  qAxisAngle,
  RaycastVehicle,
  type Shading,
  upZ,
  yawOf,
} from "../src/index.ts";

const ground: BodyDesc = {
  id: "ground",
  kind: "fixed",
  type: "ground",
  p: [0, 0, 0],
  parts: [{ shape: { kind: "box", half: [50, 50, 0.5] }, at: [0, 0, -0.5], material: "asphalt", friction: 0.9 }],
};

const box = (id: string, p: [number, number, number], half: [number, number, number], mass_kg: number): BodyDesc => ({
  id,
  kind: "dynamic",
  type: "box",
  p,
  extraSolverIterations: 4,
  parts: [{ shape: { kind: "box", half }, material: "wood", mass_kg }],
});

const car = (id: string): BodyDesc => ({
  id,
  kind: "dynamic",
  type: "car",
  p: [0, 0, 0.6],
  group: 1,
  canSleep: false,
  mass: { mass_kg: 1200, com: [0, 0, -0.1], inertia: boxInertia(1200, [1, 0.5, 0.3]) },
  parts: [{ shape: { kind: "box", half: [1, 0.5, 0.3] }, material: "paint" }],
});

function drive(pw: PhysicsWorld, id: string): RaycastVehicle {
  return new RaycastVehicle(pw, pw.indexOf(id), {
    wheels: [
      { at: [0.7, 0.45, -0.2], radius_m: 0.3, rest_m: 0.15, steer: true },
      { at: [0.7, -0.45, -0.2], radius_m: 0.3, rest_m: 0.15, steer: true },
      { at: [-0.7, 0.45, -0.2], radius_m: 0.3, rest_m: 0.15, drive: true },
      { at: [-0.7, -0.45, -0.2], radius_m: 0.3, rest_m: 0.15, drive: true },
    ],
    group: 1,
    frequency_hz: 3,
    damping: 0.8,
    travel_m: 0.1,
    grip: 1,
    rolling: 30,
  });
}

const run = (pw: PhysicsWorld, seconds: number, each?: (i: number) => void) => {
  for (let i = 0; i < seconds / pw.dt_s; i++) {
    each?.(i);
    pw.step();
  }
};

describe("physics world", () => {
  it("brings a stack to rest and puts it to sleep", async () => {
    const pw = await PhysicsWorld.create({
      bodies: [
        ground,
        ...[0, 1, 2, 3].map((i) => box(`box_${i}`, [0, 0, 0.3 + i * 0.6 + 0.001], [0.5, 0.4, 0.3], 200)),
      ],
    });
    run(pw, 5);
    const top = pw.pose("box_3").p;
    expect(Math.hypot(top[0], top[1])).toBeLessThan(0.005);
    expect(Math.abs(top[2] - 2.1)).toBeLessThan(0.015);
    expect(pw.sleeping("box_3")).toBe(true);
  });

  it("stands a cylinder on its end without it walking", async () => {
    const drum: BodyDesc = {
      id: "drum",
      kind: "dynamic",
      type: "drum",
      p: [0, 0, 0.441],
      parts: [
        {
          shape: { kind: "cylinder", halfHeight: 0.44, radius: 0.24 },
          rot: qAxisAngle([1, 0, 0], Math.PI / 2),
          material: "steel",
          mass_kg: 180,
        },
      ],
    };
    const pw = await PhysicsWorld.create({ bodies: [ground, drum] });
    run(pw, 6);
    const p = pw.pose("drum");
    expect(Math.hypot(p.p[0], p.p[1])).toBeLessThan(0.002);
    expect(upZ(p.q)).toBeGreaterThan(0.9999);
    expect(pw.sleeping("drum")).toBe(true);
  });

  // Rapier 0.20 and 0.21 fail this: the box spirals outward by a tenth of the arc it is carried through.
  it("carries a box round on a turntable without it drifting off", async () => {
    const R = await initRapier();
    const pw = await PhysicsWorld.create({
      bodies: [ground, box("box", [0.39, 0, 0.55 + 0.44 + 0.001], [0.2, 0.2, 0.44], 100)],
    });
    const table = pw.world.createRigidBody(R.RigidBodyDesc.kinematicVelocityBased().setTranslation(0, 0, 0.5));
    pw.world.createCollider(R.ColliderDesc.cuboid(2, 2, 0.05).setFriction(0.7), table);
    run(pw, 1);
    table.setAngvel({ x: 0, y: 0, z: 0.3 }, true);
    run(pw, 2 / 0.3);
    const p = pw.pose("box").p;
    expect(Math.abs(Math.hypot(p[0], p[1]) - 0.39)).toBeLessThan(0.005);
    expect(Math.abs(Math.atan2(p[1], p[0]) - 2)).toBeLessThan(0.02);
  });

  it("gives the same state from the same inputs, and again through a snapshot", async () => {
    const scene = () => ({
      bodies: [
        ground,
        car("car"),
        ...[0, 1, 2, 3, 4, 5].map((i) =>
          box(`box_${i}`, [4 + (i % 2), (i - 2.5) * 0.9, 0.3 + Math.floor(i / 2) * 0.61], [0.3, 0.3, 0.3], 20),
        ),
      ],
    });
    const play = async (snapAt?: number) => {
      const pw = await PhysicsWorld.create(scene());
      const v = drive(pw, "car");
      for (let i = 0; i < 600; i++) {
        if (i === snapAt) pw.restore(pw.snapshot());
        v.engineForce_n = 3000;
        v.steer_rad = Math.sin(i / 80) * 0.3;
        pw.step();
      }
      return pw.hash();
    };
    const a = await play();
    expect(await play()).toBe(a);
    expect(await play(250)).toBe(a);
  });

  it("reports contact forces above a part's threshold", async () => {
    const heavy = box("anvil", [0, 0, 3], [0.2, 0.2, 0.2], 500);
    (heavy.parts[0] as { contactForce_n?: number }).contactForce_n = 20_000;
    const pw = await PhysicsWorld.create({ bodies: [ground, heavy] });
    run(pw, 0.5);
    expect(pw.impacts()).toEqual([]);
    run(pw, 1);
    const hits = pw.impacts();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      a: expect.stringMatching(/ground|anvil/),
      b: expect.stringMatching(/ground|anvil/),
    });
    expect(Math.max(...hits.map((h) => h.force_n))).toBeGreaterThan(20_000);
  });
});

describe("raycast vehicle", () => {
  it("rests level, drives, turns left on positive steer, and brakes to a stop", async () => {
    const pw = await PhysicsWorld.create({ bodies: [ground, car("car")] });
    const v = drive(pw, "car");
    run(pw, 2);
    expect(upZ(pw.pose("car").q)).toBeGreaterThan(0.9999);
    expect([0, 1, 2, 3].every((i) => v.grounded(i))).toBe(true);
    expect(Math.abs(v.speed_mps())).toBeLessThan(0.005);
    const loads = [0, 1, 2, 3].reduce((sum, i) => sum + v.load_n(i), 0);
    expect(loads).toBeCloseTo(1200 * 9.81, -2);

    v.engineForce_n = 3000;
    run(pw, 3);
    expect(v.speed_mps()).toBeGreaterThan(4);
    expect(pw.pose("car").p[0]).toBeGreaterThan(6);
    expect(Math.abs(pw.pose("car").p[1])).toBeLessThan(0.01);

    v.steer_rad = 0.2;
    run(pw, 2);
    expect(yawOf(pw.pose("car").q)).toBeGreaterThan(0.4);

    v.engineForce_n = 0;
    v.steer_rad = 0;
    v.brake_n = 4000;
    run(pw, 5);
    expect(Math.abs(v.speed_mps())).toBeLessThan(0.01);
    const at = pw.pose("car").p[0];
    run(pw, 3);
    expect(Math.abs(pw.pose("car").p[0] - at)).toBeLessThan(0.002);
  });
});

describe("raycast sensors", () => {
  const shading: Shading = {
    albedo: { asphalt: [60, 60, 60], wood: [200, 150, 100] },
    sun: [0, 0, 1],
    ambient: 0.4,
    zenith: [90, 140, 200],
    horizon: [200, 210, 220],
    shadows: true,
  };

  it("renders depth and colour of what is in front of the camera, and not its own machine", async () => {
    const wall: BodyDesc = { ...box("wall", [5, 0, 1], [0.1, 1, 1], 50), kind: "fixed" };
    const hood: BodyDesc = { ...box("hood", [1, 0, 1], [0.2, 0.2, 0.2], 5), group: 3, kind: "fixed" };
    const pw = await PhysicsWorld.create({ bodies: [ground, wall, hood] });
    pw.step();
    const cam = { width: 32, height: 24, fovY_rad: 0.9, maxRange_m: 20 };
    const frame = castCamera(pw, { p: [0, 0, 1], q: [0, 0, 0, 1] }, cam, shading, 3);
    const mid = 12 * 32 + 16;
    expect(frame.depth[mid]).toBeCloseTo(4.9, 1);
    expect(pw.ids[frame.bodies[mid] as number]).toBe("wall");
    expect(frame.bodies[0]).toBe(-1);
    // The wall faces the camera and the sun is overhead, so it is lit by ambient light alone, with a little fog.
    const fog = 0.6 * (4.9 / 20) ** 2;
    const lit = [200, 150, 100].map((c, i) => Math.floor(c * 0.4 * (1 - fog) + ([200, 210, 220][i] as number) * fog));
    expect([...frame.rgb.subarray(mid * 3, mid * 3 + 3)]).toEqual(lit);
    // Top-left looks over the wall at the sky; bottom-centre at the ground in sunlight.
    expect(frame.depth[0]).toBe(0);
    expect(frame.rgb[0]).toBeGreaterThan(90);
    expect(frame.depth[23 * 32 + 16]).toBeGreaterThan(1.5);
    expect(frame.depth[23 * 32 + 16]).toBeLessThan(3);
    // Without the group filter, the camera's own hood fills the middle.
    expect(castCamera(pw, { p: [0, 0, 1], q: [0, 0, 0, 1] }, cam, shading).depth[mid]).toBeCloseTo(0.8, 1);
  });

  it("returns lidar hits in the sensor's frame", async () => {
    const pw = await PhysicsWorld.create({
      bodies: [ground, { ...box("post", [3, 0, 1], [0.1, 0.1, 1], 50), kind: "fixed" }],
    });
    pw.step();
    const yaw = Math.PI / 2;
    const { points, bodies } = castLidar(
      pw,
      { p: [0, -3, 1], q: qAxisAngle([0, 0, 1], yaw) },
      { rings_rad: [0, -0.3], azimuths: 90, maxRange_m: 20 },
    );
    expect(points.length % 3).toBe(0);
    const level = [];
    for (let i = 0; i < points.length; i += 3)
      if (Math.abs(points[i + 2] as number) < 1e-6) level.push([points[i], points[i + 1]]);
    // One level return, off the post: 3 m ahead and 3 m to the right of a sensor facing north from (0, -3).
    expect(level).toHaveLength(1);
    expect(level[0]?.[0]).toBeCloseTo(3, 0);
    expect(level[0]?.[1]).toBeCloseTo(-2.9, 0);
    expect(bodies).toHaveLength(points.length / 3);
    expect([...new Set(bodies)].map((b) => pw.ids[b]).sort()).toEqual(["ground", "post"]);
    // The lower ring finds the ground all the way round.
    expect(points.length / 3).toBeGreaterThanOrEqual(90);
  });
});
