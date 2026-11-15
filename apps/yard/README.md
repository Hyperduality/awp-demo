# Yard

A freight yard simulated as rigid bodies, with a forklift in it as an AWP embodiment. The truck has suspension, rear-wheel steering, a mast that lifts 3 m and tilts, and forks that go into a pallet's pockets. Loads are loose bodies on their pallets: crates, cartons and drums stay on only if they are carried well. The agent is not told where things are. It gets a site map of what is built there, and beyond that only what the truck's camera and lidar pick out, so it has to go and look for the pallets it is asked to move. The world is streaming, and the view is drawn in 3D from the poses it publishes.

[SPIKE.md](SPIKE.md) records what was measured before this was built, and what had to change.

```bash
pnpm yard    # world :8717, agent, UI http://localhost:5176
```

## The world

| | |
|---|---|
| Embodiment | `forklift_0`, a 2.5 tonne counterbalance truck |
| Actions | `pick_pallet` and `place_pallet` (the whole manoeuvre), `drive_to`, `set_forks`, `stop`, and `teleop`. Routes are planned over position and heading, forward and in reverse, against the site map and what the truck has seen |
| Command channel | `drive` (`servo/json`, 30 Hz): speed, steering, hoist rate and tilt rate, while a `teleop` action runs. Without setpoints for 500 ms the action fails with `watchdog` and the truck stops |
| Observations | `proprio`, `task`, `awp.tf` (the dynamic frames), three sensors cast as rays through the physics: `depth` (`image/raw`, depth32f, 96×64), `rgb` (`image/raw`, rgb8) and `lidar` (`pointcloud/xyz32`, four rings, 20 m), and `scene`: the site map plus the movable things those rays land on at that moment |
| Envelope | The yard's bounds, 3 m/s, and 25 kN on the hoist, which stalls rather than lift more. Out-of-envelope targets and setpoints are refused |
| Initial states | `default` (three orders: two ground bays and a trailer slot), `trailer` (all three onto the trailer's deck, 1.25 m up), `empty` (no loads) |
| Task | Orders to move pallets into bays. A delivery scores 100 scaled by how much of the load arrived; each item that falls off costs 5; tipping the truck ends the run |

An action that cannot go on fails with a vendor reason: `x-yard.blocked` (no clear route, or something in the way), `x-yard.overload` (more than the hoist can lift), `x-yard.unseen` (the truck's sensors have not seen that pallet, or it is no longer where they saw it), `x-yard.missed`, `x-yard.empty`, `x-yard.busy`, `x-yard.tipped`.

## What the agent knows

The `scene` channel is the truck's object detector, not the world's truth. Entities marked `site_map` are fixed and always listed: the buildings, the containers, the trailer, the bays, the receiving pad. Entities marked `sensors` are listed only while at least two camera or lidar rays land on them. The detector is generous about what it sees (it reads a pallet's tag and gets its pose exactly) and strict about where: nothing through a container, round a corner, or beyond range.

The truck starts parked by the bays, facing the trailer, with the receiving pad behind it and out of the lidar's reach. So the ordered pallets are not in the scene at first. The truck's own skills obey the same rule: `pick_pallet` goes to where the truck last saw the pallet and needs it in view before the forks go in, and routes avoid only what is on the site map or has been seen. The `task` channel gives the orders and which are delivered; a load coming off the forks shows on the load cell, but a carton falling off some other pallet is not reported.

Remembering what was seen earlier is the agent's job: `src/agent/controllers/observe.ts` keeps each sighting with its age, and the model's view is written from that.

The controllers, highest priority first:

| Controller | |
|---|---|
| Manual | You. Click the view, then W and S for speed, A and D to steer, R and F for the forks, T and G to tilt; or a gamepad. The first input starts a `teleop` action, and the sticks go out as setpoints on its command channel. |
| LLM | A language model on duty (`createLlmSupervisor`). Its view is text: the orders, what the sensors show now, what it saw earlier and how long ago, and the site map. It drives to look for what it has not seen, then works with the pallet actions. It is woken when its own action ends, and by impacts, a stalled hoist, or a load leaving the forks. You can also tell it where things are. |

There is no scripted controller: finding the pallets is the point, and a script that knew where they were would not be doing the task.

## How it is built

- **`packages/physics`** wraps [Rapier](https://rapier.rs) for the world process: a world built from a declarative scene, a force-based raycast vehicle, snapshots, a pose hash, and the raycast camera and lidar. It has no renderer in it, and the same scene description drives the physics and the drawing.
- **`packages/scene3d`** draws a world of rigid bodies with three.js: a sky model that lights the scene, one shadow-casting sun, ambient occlusion, bloom, and pose interpolation between the frames the world sends. Surfaces use generated patterns until photographed textures are placed in `public/assets/textures/<set>/`.
- **`src/world`** is the yard: the truck (`forklift.ts`), the scene (`scenarios.ts`), a route planner (`plan.ts`: hybrid A* over position and heading, with reversing), a path follower (`drive-to.ts`), the task (`task.ts`), and the simulation that ties them to AWP and holds the detector (`sim.ts`).

The physics steps at 120 Hz inside the host's 60 Hz step. The UI gets every body's pose 60 times a second as 3.5 KB of JSON, and the sensor frames five times a second on their own inspector topic.

## Demo script

1. Click the view and drive up to a pallet. Lower the forks, go in, lift, and back out. The Wire panel shows the setpoints; the Sensors panel shows what the truck's camera sees.
2. Turn Sensors on in the view and watch the lidar's returns as you drive: the Sensors panel counts the movable things in view, and Agent View shows the scene channel gaining and losing them.
3. Reset, give the LLM a key, and tell it to deliver the orders. It starts with none of the ordered pallets seen, drives to where it can see the receiving pad, then picks and places each one.
4. Take the controls in the middle of one of its actions: your first input replaces it with `teleop`, and the model hears that its action was preempted.
5. Ask the LLM for the concrete block in the middle of the yard: `pick_pallet` fails with `x-yard.overload`.

## Conformance

**Core World (streaming), self-assessed against 0.1-draft.12; awp-conformance 0.1.0a10 passes every assertion it ran.** The report is [`conformance/report.json`](conformance/report.json), and it lists what the suite leaves untested. The fixture runs the command-channel tests against `teleop`.

```bash
AWP_AUDIT_DIR=conformance/audit pnpm world &      # in apps/yard
export WORLD_PID=$(lsof -ti tcp:8717 -sTCP:LISTEN | head -1)
uvx --prerelease allow awp-conformance==0.1.0a10 world ws://127.0.0.1:8717 \
  --token awp-demo-local-token --fixture conformance/fixture.json --out conformance/report
cp conformance/report/report.json conformance/report.json
```
