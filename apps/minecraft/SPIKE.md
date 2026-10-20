# Spike: MineStudio as an AWP world

Measured on 2026-10-19 on the demo machine: Windows 11, WSL2 Ubuntu 24.04, an RTX 3080 (10 GB), 24 cores, 15 GB for WSL. MineStudio 1.1.3 (Minecraft 1.16.5 through MCP-Reborn), JDK 8 (Temurin 1.8.0_504), Python 3.10, torch 2.6.0+cu124. The scripts lived outside the repository; `sim/` carries what they taught.

## Results

| Check | Result | Verdict |
|---|---|---|
| Rendering | WSLg, Mesa's d3d12 driver on the GPU, `DISPLAY=:0`. Neither VirtualGL nor Xvfb is needed. | Pass |
| Step rate at 640×360 | 39.7 steps/s through `MinecraftSim` (p50 24 ms, p95 34 ms); 11 ms p50 through the sidecar | Pass (≥ 25) |
| VPT latency (`rl_from_early_game_2x`, 248 M parameters) | p50 8.6 ms, p95 17.3 ms, max 22 ms; 1.0 GB of GPU memory | Pass (p95 < 40 ms) |
| Lockstep | Game state never moves between steps: positions match exactly whatever the wall-clock pacing | Pass |
| Determinism | Same start, same inputs, fast and with pauses of up to 3 s: identical frames for 60 steps | Pass, in the conformance stage only (below) |
| Reset | First launch and reset 30–40 s; later resets by command 1–4 s | |
| `info` | Health, food, the 36 inventory slots, equipped items, position and yaw/pitch, light and sky, and mining, pickup, crafting and kill counts. `mobs` and `voxels` are empty unless a callback asks, so the scene shows only the player. | |

## Action format

MineStudio's env actions are binary buttons (`forward`, `back`, `left`, `right`, `jump`, `sneak`, `sprint`, `attack`, `use`, `inventory`, `hotbar.1`–`hotbar.9`, `pickItem`) and `camera`, a `[pitch, yaw]` turn in degrees for the tick, each within ±180. There is no `drop`, so the world takes no `KeyQ`. VPT's camera head picks from mu-law bins within ±10° a tick.

`shared/keymap.json` maps keys to buttons. A mouse count turns the camera 0.15°, so VPT's widest turn is 67 counts. `mouse_dy` drives pitch (positive looks down), `mouse_dx` drives yaw (positive turns right).

## What it took to make frames depend only on state

The first runs differed on every frame. Each cause, and the fix in `sim/`:

- MCP-Reborn ignores MineRL's `FlatWorldGenerator`, so there is no superflat world. The conformance stage, `conformance_room`, is instead a closed room built by commands at y = 200, which nothing outside it reaches. The plan's `conformance_flat` became this room.
- Block light flickers by `Math.random()` every tick (the light map's torch flicker). The room has no ceiling and is lit by sky light only.
- The fog colour blends for about 5 s of wall-clock time after the player enters a new biome, which the teleport into the room does. The first reset into the room idles until 20 frames in a row are identical.
- View bobbing, clouds, particles, and the tutorial toast all animate. Each instance's `options.txt` turns them off. Chat stays enabled, because hiding it disables commands, but it is scaled to nothing.
- Mobs act on randomness no seed reaches, so two runs with a cow in the room diverge. The room has no mobs and random ticks are off.

With those fixed, three runs from the same reset (fast, paced with pauses of up to 3 s, fast again) matched frame for frame, and positions matched in every run.

## Decisions

- **Lockstep is claimed.** The game is paused between steps and the conformance stage is deterministic. `plains_day` and `forest_wood` are not: their mobs act on randomness no seed reaches, and their render depends on wall-clock effects such as chunk loading and fog blending. Their game state is still paused between steps.
- **No `capabilities.seed`.** AWP-REP-001 binds every initial state, and the live ones do not reproduce.
- **No snapshot or replay.** MineStudio cannot restore an exact state (spec 0.1-draft.12 makes snapshot optional for the game profile).
- **640×360 at 20 Hz.** Rendering keeps up, so there is no need to lower the render size.
