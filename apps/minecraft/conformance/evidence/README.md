# Device-input evidence (AWP-GAM-002..004)

The conformance suite cannot see a world's input layer, so it reports AWP-GAM-002, -003 and -004 as manual. These files are that evidence: the device states the Minecraft world applied while `../evidence.ts` ran its scenarios against the real game (MineStudio, 2026-10-20).

- `scenarios.json` names each scenario's action, and how the action ended.
- `input.jsonl` is the world's input log for that run, one record per applied device state.

Each record carries `ts_mono_ns` (world monotonic time) and `tick` (lockstep only), the embodiment, and `kind`. `step` is the state applied for one game tick, and names the chunk's `slot`. `release` means everything was let go as a chunk ended. `state` lists the keys `held`, `pressed` and `released` at the record, and the mouse deltas.

What to look for:

| Rule | Scenario | In the log |
|---|---|---|
| AWP-GAM-002 | `slots` | KeyW goes down at slot 0 and stays down in slot 1 with no new press. ShiftLeft goes down at slot 1, KeyW is released at slot 2, and slot 3 holds nothing. One slot per tick: about 50 ms apart in streaming, one advance apart in lockstep. |
| AWP-GAM-003 | `replace` | At the boundary where the replacement takes over, ShiftLeft is in neither `pressed` nor `released`: it stays down. KeyW is released and KeyD pressed. The replaced action ends `preempted` with the slots it completed. |
| AWP-GAM-004 | `cancel`, `safe state` | A `release` record lets go of everything before the terminal status: on cancel, on safe-state entry when the agent fell silent, and after the replacement chunk completes. |

To capture it again, start the world with `AWP_AUDIT_DIR` set, then run `tsx conformance/evidence.ts > conformance/evidence/scenarios.json`. The world writes the log to that directory as `*-input.jsonl`.
