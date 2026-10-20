# Minecraft

Minecraft (Java Edition 1.16, through [MineStudio](https://github.com/CraftAI-Lab/MineStudio)) as an AWP world in both time models. One player takes device input as `input_chunk`: keys, mouse buttons and mouse movement, one slot per 50 ms game tick. It is observed as a 640×360 JPEG stream (`pov`), a status channel and a scene channel.

The world is TypeScript (`src/world`). The game runs in a Python sidecar (`sim/`) that the world starts and speaks to as NDJSON over stdio, one game tick per step. `policy/` serves MineStudio's VPT policy over a WebSocket for the agent. [SPIKE.md](SPIKE.md) records what was measured before this was built, and why the frames are deterministic.

## Requirements

The sidecar needs Linux with an OpenGL display, an NVIDIA GPU for VPT, Java 8, and [uv](https://docs.astral.sh/uv/). On Windows, run everything in WSL2: WSLg's GPU-backed display works as is.

```bash
# Java 8 without root, if the system has none
curl -fsSL "https://api.adoptium.net/v3/binary/latest/8/ga/linux/x64/jdk/hotspot/normal/eclipse" -o jdk8.tar.gz
mkdir -p ~/opt/jdk8 && tar -xzf jdk8.tar.gz -C ~/opt/jdk8 --strip-components=1
export JAVA_HOME=~/opt/jdk8 PATH=~/opt/jdk8/bin:$PATH

cd apps/minecraft && uv sync --all-packages   # MineStudio, torch with CUDA 12.4, VPT
```

The first start downloads the game engine (about 400 MB) into `$MINESTUDIO_DIR` (default `~/.minestudio`), and the first VPT start downloads its weights from Hugging Face.

## Running

```bash
# in apps/minecraft, in its own shell: VPT on :8716 (only for the VPT controller)
uv run --package awp-minecraft-policy awp-minecraft-policy

pnpm minecraft    # world :8715, agent, UI http://localhost:5175; the game takes 30–40 s to start
```

The agent opens in streaming. Set `AWP_TIME_MODEL=lockstep` to start in lockstep, or switch in the Session panel at any time. Switching closes the session and opens the next in the other model, on the same world and manifest.

The controllers, highest priority first:

| Controller | |
|---|---|
| Manual | You. Click the view to capture the mouse. Each tick it sends what is held as two slots, the second carrying the keys over the slot boundary, so a late sample never drops a held key. |
| LLM | A vision model with `see` and `act` tools. In lockstep it takes turns with a world that waits. In streaming each decision rests on the view it last saw, and the world refuses it by the time it arrives. |
| VPT | OpenAI's Video PreTraining (`rl_from_early_game_2x`) through `policy/`, one decision per frame. In lockstep the world waits for each. In streaming each decision must arrive within 100 ms of its frame. Its Inference Delay setting slows it down on purpose. |
| Wanderer | A script: walks, looks around, and jumps and turns when blocked. |

| Variable | Default | |
|---|---|---|
| `AWP_MINECRAFT_SIM` | `uv run --package awp-minecraft-sim awp-minecraft-sim` | The command that starts the sidecar, run in `apps/minecraft`. `fake` runs a stand-in that walks a pose and shows a fixed picture, with no Python or game; the tests and CI use it. |
| `AWP_MINECRAFT_RENDER` | `wslg` on WSL, `xvfb` elsewhere | `wslg` draws on the WSLg display through Mesa's d3d12 driver (GPU). `xvfb` is MineStudio's default and needs `xvfb-run` (CPU, slow). `vgl` uses VirtualGL on a headless NVIDIA machine. |
| `MINESTUDIO_DIR` | `~/.minestudio` | The game engine and per-instance options. |
| `AWP_MINECRAFT_VERBOSE` | unset | Set to show the sidecar's and the game's log. |
| `UV_PROJECT_ENVIRONMENT` | `apps/minecraft/.venv` | Put the environment on a Linux filesystem when the checkout is on a Windows drive. |

If the sidecar dies, every session ends with `world_shutdown` and the game starts again for the next session or reset.

## Conformance

**Core World + game (lockstep, streaming), self-assessed against 0.1-draft.12; awp-conformance 0.1.0a10 passes every assertion it ran**, against the real game. The report is [`conformance/report.json`](conformance/report.json), and it lists what the suite leaves untested. The suite takes AWP-GAM-002..004 as manual evidence, which is in [`conformance/evidence/`](conformance/evidence/README.md).

Run it in WSL or on Linux, because the fixture engages the e-stop with `kill`:

```bash
AWP_AUDIT_DIR=conformance/audit pnpm world &      # in apps/minecraft; wait for the game to start
export WORLD_PID=$(ss -ltnp "sport = :8715" | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2)
uvx --prerelease allow awp-conformance==0.1.0a10 world ws://127.0.0.1:8715 --token awp-demo-local-token   --fixture conformance/fixture.json --profile game --out conformance/report
```

## Initial states

| State | |
|---|---|
| `plains_day` | A plains biome in the morning, with mobs. Time and weather stand still. |
| `forest_wood` | A forest, where VPT's early-game policy gathers wood. |
| `conformance_room` | A closed room in the sky, lit by sky light only, with no mobs and no random ticks. Runs from it are deterministic, so the conformance suite uses it. |

The first reset launches the game. Later resets rebuild the state by command in a few seconds.

## Demo script

About ten minutes. Start the policy server and `pnpm minecraft`, open http://localhost:5175, and reset the world to `plains_day`.

1. **Manual play, streaming, then lockstep.** Click the view and walk around. The overlay in the corner shows the device state the protocol delivered for the last tick: held keys and mouse counts, not what the browser sent. Switch the session to lockstep in Session and play again. The world advances 20 ticks a second while you hold control. It is the same world, manifest and input, under the other time model.
2. **VPT in lockstep.** Turn VPT on and let go of the mouse. In lockstep the world waits for every decision. Pause the clock in Control and step one tick at a time: each step is one frame in, one VPT decision, one tick out.
3. **VPT in streaming.** Switch to streaming. VPT plays in real time, about 15 ms a decision. Timing shows how old each decision's frame was when it arrived. Now set VPT's Inference Delay to 300 ms. Every decision arrives more than 150 ms after its frame, and the world refuses it as a stale intent (`AWP_STALE_INTENT` in Activity). The last chunk runs out, every key is released, and the player stands still. Set the delay back to 0 and it walks again. This is the protocol's freshness guarantee, on screen.
4. **The LLM.** Add a key in Control and send "Gather some wood". In lockstep it plays slowly but sensibly: look, act, look. In streaming its decisions come back refused, because by the time a model answers, the view it answered is seconds old. Agents that think and agents that react show up apart in the protocol's own timing data.

A last option is OpenHA, a goal-conditioned policy for a larger GPU. Nothing here serves it yet. A server for it that speaks the protocol in `policy/` would plug into `createPolicyController` unchanged, with its goal taken from the session's `task` and changed mid-run with `task.update`.
