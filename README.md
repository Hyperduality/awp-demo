# awp-demo

Runnable demos of the [Agent World Protocol](https://www.agentworldprotocol.com) (AWP). Each demo is three processes:

- **World** (Node): a real AWP world, a WebSocket server on the `awp` subprotocol. Any AWP agent can connect to it.
- **Agent** (Node): one AWP session, opened with [`@hyperduality/awp`](https://www.npmjs.com/package/@hyperduality/awp). Inside it, several controllers take turns driving: you at the keyboard, a program, and a language model.
- **UI** (Vite + React, [HeroUI](https://heroui.com)): shows the world, the agent's activity, and every message on the wire, and configures the controllers. It never speaks AWP itself.

| Demo | Time model | Leads with | Shows |
|---|---|---|---|
| **Sorter** | lockstep | program | A two-link arm and a gripper bound together (multi-bind), queue and replace preemption, a program that intercepts parcels on a conveyor |
| **Vault** | lockstep | LLM | A language model exploring a dark vault through world actions, with the world held still while it thinks |
| **Dispatch** | streaming | LLM | A language model running a city's emergency dispatch while the city keeps moving: actions that return on admission, decisions refused once the view behind them is too old (stale intent), and a watchdog held off only while the model is producing |

| **Yard** | streaming | manual | A freight yard as rigid bodies in 3D, and a forklift driven two ways: pallet skills as actions, and speed and steering as setpoints on a command channel (`servo/json`). The agent knows only a site map and what the truck's camera and lidar have picked out, so a language model has to go and look for the pallets it is asked to move. Depth, camera and lidar frames are rays cast through the physics. See [its README](apps/yard/README.md) |

Sorter, Vault and Dispatch have all three kinds of controller; Yard has no program, since finding things is its task. Only one holds control at a time: the highest-priority controller that wants it. Manual outranks LLM, which outranks program. When control changes hands, the agent cancels what the previous holder was doing; in Dispatch the new holder inherits the units already on their way instead. The world therefore sees one coherent session, and the UI shows one continuous stream of events.

## Running

Node 24 and pnpm 10.

```bash
pnpm install
pnpm sorter    # world :8712, UI http://localhost:5172
pnpm vault     # world :8713, UI http://localhost:5173
pnpm dispatch  # world :8714, UI http://localhost:5174
pnpm yard      # world :8717, UI http://localhost:5176
```

`pnpm dev` runs every demo at once. Copy `.env.example` to `.env` to change the bearer token or to give the LLM controllers keys from the environment. A key entered in the UI is held in the agent process's memory only.

## Layout

```
apps/<demo>/src/world    the world: manifest, simulation, server entry
apps/<demo>/src/agent    the agent: controllers and entry
apps/<demo>/src/ui       the UI: world view and panel layout
packages/world           WorldHost, a sans-IO AWP world written from the spec, and serveWorld
packages/agent           the control mux, the Controller API, and LLM plumbing (AI SDK), including a supervisor for streaming worlds
packages/inspector       the contract between the processes and the UI, over WebSocket
packages/physics         rigid-body worlds for the world process: Rapier, a raycast vehicle, and raycast depth, camera and lidar
packages/scene3d         a three.js view of such a world, drawn from the poses the world publishes
packages/ui              the shell: a fixed grid of the Wire, Activity, Control, Session panels (and Timing, for streaming), with Agent View and About as dialogs
```

A world is a `WorldDefinition`: a manifest, plus a simulation that steps, observes, and runs actions. `WorldHost` handles the protocol:
- sessions and grants
- the action lifecycle and preemption
- both time models
- heartbeats, watchdogs and safe state
- stale intents, refused on the age of their basis or past their validity
- resume and replay
- the audit log

A controller implements `Controller`. It receives a `ControlContext`, a view of the session mediated by the mux:
- the latest observations
- `submit`, `settle` and `wait`, which work unchanged in both time models
- the frame a decision rests on, named as its basis when it is submitted
- `alive`, which a controller with `intent` liveness calls to keep the agent pinging while it decides
- engagement
- a shared history of what every controller did

An LLM controller for a world that waits takes one turn per message (`createLlmController`). For a streaming world, `createLlmSupervisor` keeps the model on duty: its action tools return once the world admits the action, news wakes it, each submission names the view it was decided on, and the agent pings the world only while the model streams, runs a tool, or waits for news, so a model that stalls lets the watchdog stop motion.

## Conformance

Each world passes every assertion that awp-conformance 0.1.0a10 (0.1-draft.12) runs against it. Sorter, Vault, Dispatch and Yard claim Core World in their time model. Each claim is "self-assessed against 0.1-draft.12": the suite leaves a few requirements untested, as listed in each report. Reports and fixtures are in `apps/<demo>/conformance/`.

```bash
pnpm --filter sorter world                       # in one shell
uvx --prerelease allow awp-conformance world ws://127.0.0.1:8712 \
  --token awp-demo-local-token --fixture apps/sorter/conformance/fixture.json
```

## Checks

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## License

Apache-2.0.
