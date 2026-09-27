# awp-demo

Runnable demos of the [Agent World Protocol](https://www.agentworldprotocol.com) (AWP). Each demo is three processes:

- **World** (Node): a real AWP world, a WebSocket server on the `awp` subprotocol. Any AWP agent can connect to it.
- **Agent** (Node): one AWP session, opened with [`@hyperduality/awp`](https://www.npmjs.com/package/@hyperduality/awp). Inside it, several controllers take turns driving: you at the keyboard, a program, and a language model.
- **UI** (Vite + React): shows the world, the agent's activity, and every message on the wire, and configures the controllers. It never speaks AWP itself.

| Demo | Time model | Leads with | Shows |
|---|---|---|---|
| **Maze** | streaming | manual | Keyboard teleop on a command channel at 30 Hz, the per-action and session watchdogs, an autopilot that maps the maze from its range scan |
| **Sorter** | lockstep | program | A two-link arm and a gripper bound together (multi-bind), queue and replace preemption, a program that intercepts parcels on a conveyor |
| **Vault** | lockstep | LLM | A language model exploring a dark vault through world actions, with the world held still while it thinks |

Every demo has all three kinds of controller. Only one holds control at a time: the highest-priority controller that wants it. Manual outranks LLM, which outranks program. When control changes hands, the agent cancels what the previous holder was doing. The world therefore sees one coherent session, and the UI shows one continuous stream of events.

## Running

Node 24 and pnpm 10.

```bash
pnpm install
pnpm maze      # world :8711, UI http://localhost:5171
pnpm sorter    # world :8712, UI http://localhost:5172
pnpm vault     # world :8713, UI http://localhost:5173
```

`pnpm dev` runs all three demos at once. Copy `.env.example` to `.env` to change the bearer token or to give the LLM controllers keys from the environment. A key entered in the UI is held in the agent process's memory only.

The UI depends on [HeroUI Pro](https://heroui.pro), which is licensed. `pnpm install` needs a Pro login (`npx heroui-pro login`), or `HEROUI_AUTH_TOKEN` in CI.

## Layout

```
apps/<demo>/src/world    the world: manifest, simulation, server entry
apps/<demo>/src/agent    the agent: controllers and entry
apps/<demo>/src/ui       the UI: world view and panel layout
packages/world           WorldHost, a sans-IO AWP world written from the spec, and serveWorld
packages/agent           the control mux, the Controller API, and LLM plumbing (AI SDK)
packages/inspector       the contract between the processes and the UI, over WebSocket
packages/ui              the shell: floating panels, and the Wire, Activity, Control, Session, Agent View, About panels
```

A world is a `WorldDefinition`: a manifest, plus a simulation that steps, observes, and runs actions. `WorldHost` handles the protocol:
- sessions and grants
- the action lifecycle and preemption
- both time models
- heartbeats, watchdogs and safe state
- resume and replay
- the audit log

A controller implements `Controller`. It receives a `ControlContext`, a view of the session mediated by the mux:
- the latest observations
- `submit`, `settle` and `wait`, which work unchanged in both time models
- engagement
- a shared history of what every controller did

## Conformance

Each world passes every assertion of awp-conformance 0.1.0a7 (0.1-draft.10) for Core World in its time model. The claim is "self-assessed against 0.1-draft.10": the suite leaves a few requirements untested, as listed in each report. Reports and fixtures are in `apps/<demo>/conformance/`.

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
