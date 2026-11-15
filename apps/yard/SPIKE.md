# Spike: a rigid-body world in the world process

Measured on 2026-11-12 on an Apple M4 Pro, macOS 26.6, Node 24.13. The question was whether a physics engine running in the Node world process, with no GPU, could carry a forklift, its loads and its sensors at a 60 Hz step. The scripts were thrown away; `packages/physics` and `test/` carry what they taught.

## Results

| Check | Result | Verdict |
|---|---|---|
| Rapier under Node 24 | `@dimforge/rapier3d-deterministic-compat` loads from ESM in 39 ms, WASM inlined | Pass |
| Step cost | 0.12 ms per 60 Hz step for the default yard (66 bodies, two 120 Hz substeps, 16 solver iterations); 0.15 ms with the truck working | Pass (budget 16.7 ms) |
| Stacks | Four 200 kg crates on a pallet rest within 2 mm and go to sleep | Pass |
| Lift and carry | 500 to 720 kg loads forked, lifted 1.25 m onto a trailer and set down, 24 seeded runs of three orders, every load intact | Pass |
| Overload | A 3.2 t block stalls the hoist at its 25 kN limit; the truck stays upright | Pass |
| Ray cost | 0.7 µs a ray. A 96×64 camera frame with a shadow ray per hit takes 8.5 ms, a 1,440-ray lidar sweep 1.5 ms: about 10% of a core at the declared rates | Pass |
| Determinism | The same seed and inputs give the same pose hash, run after run | Pass |
| Snapshot | `takeSnapshot` and `restoreSnapshot` mid-run, then the same hash at the end (155 KB for the default yard) | Pass |
| `awp.tf` | The reserved channel id validates as an ordinary `proprio/json` channel | Pass |
| View size | 3.5 KB of JSON per frame for every pose, base64 float32: no binary inspector topic needed | Pass |

## What did not work as planned

**Rapier 0.20 and 0.21 let anything on a turning surface drift off it.** A box on a turntable moves outward by a tenth of the arc it is carried through, whatever the friction, mass, step rate or solver settings:

| Version | Radius after 2 rad, from 0.390 m |
|---|---|
| 0.18.2 | 0.391 |
| 0.19.3 | 0.390 |
| 0.20.0 | 0.475 |
| 0.21.0 | 0.475 |

On the truck this showed as every load sliding about 4 cm along the forks per radian turned, and drums walking off their pallet in two turns. The package is pinned to 0.19.3, and `packages/physics/test/physics.test.ts` has the turntable check to run before moving the pin. 0.19.3 has no `setMotorMaxForce`, so the hoist's force limit is done by capping how far the motor's target may lead the carriage: the motor is a spring, so the lead is the force.

**Rapier's vehicle controller shakes the chassis.** It applies suspension as impulses before the step, which leaves the chassis with a velocity that flips every step. A parked truck crept a centimetre a second, and a load on its forks slowly walked. `RaycastVehicle` in `packages/physics` applies springs, drive and tyre grip as forces at the contact points instead, so the solver integrates them with gravity. It also gives each steered wheel its own angle about the turning centre: with both rear wheels at one angle, a tight turn locked up against the tyres' own grip.

**A cylinder cannot stand on its end.** A cylinder meets a flat face at one contact point, and a drum on one point never rests. Moving cylinders get two weightless square prisms inside them, one turned 45 degrees, so each end has eight corners; the cylinder itself, 6 mm shorter, still does the rolling.

**Lift and tilt need ramps.** A hoist that jumps to its target throws the load off the forks. The truck ramps both at the rates of a real one (0.45 m/s, 0.12 rad/s), and feeds the ramp's speed to the motor so its damper does not eat the force budget.

**Third-party post-processing did not survive three r187.** `postprocessing` rendered, but its SSAO did not, and `n8ao` threw in `setRenderTarget`. `packages/scene3d` uses three's own passes (GTAO, bloom, output), which move with three.

## Decisions

- **Streaming only.** The host grants a command channel in lockstep but drops its frames (AWP-CMD-001 keeps command channels to streaming), and physics gains nothing from lockstep here.
- **`capabilities.seed`.** A seed fixes the yard, the loads and the orders, and the engine reproduces a run from the same inputs.
- **No snapshot in the manifest.** The physics can do it; the host has no `world.snapshot` yet.
- **Sensors are rays through the physics, not a rendered image.** They cost no GPU, see exactly the collision geometry, and are the same on every machine. The truck's own parts are filtered out by collision group, as a robot's self-filter does.
- **The scene channel is a detector over those rays, not the world's truth.** Each ray reports the body it hit, and a movable thing is listed only while two rays land on it. The first version published every pallet's pose to the agent, which made the sensors decoration. Reading the sensors four times a second for this costs about 0.7 ms a step on average.
- **Routes are planned over heading as well as position.** The first planner searched positions only and the follower turned on the spot to fix the heading, with a load at a crawl. Hybrid A* with reversing, and a line-tracking law that settles over a fixed distance, took an order from about 100 s to about 80 s in 12 seeded runs, and stopped the back-and-forth in front of the bays.
- **Setpoints over the speed limit are refused, not clamped.** The envelope declares `reject`; steering, hoist and tilt rates are the machine's own limits, and it takes what it can of those.
- **Failure reasons are vendor reasons** (`x-yard.blocked`, `x-yard.overload`, `x-yard.missed`, `x-yard.tipped`, `x-yard.empty`, `x-yard.busy`), since an agent that hears only `world_error` cannot tell a blocked route from a load too heavy to lift.
