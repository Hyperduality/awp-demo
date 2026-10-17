import { runAgent } from "@awp-demo/agent";
import { PORTS, UNITS } from "../shared/city.ts";
import { llm } from "./controllers/llm.ts";
import { manual } from "./controllers/manual.ts";
import { program } from "./controllers/program.ts";

await runAgent({
  name: "dispatch-agent",
  worldUrl: process.env.AWP_URL ?? `ws://127.0.0.1:${PORTS.world}`,
  token: process.env.AWP_TOKEN ?? "awp-demo-local-token",
  inspectorPort: Number(process.env.INSPECTOR_PORT ?? PORTS.agentInspector),
  consumes: ["text/event+json"],
  controllers: [llm, manual, program],
  // The model's liveness holds off the world's watchdog, and whoever takes the desk inherits the
  // units already on their way.
  heartbeat: "intent",
  handoff: "inherit",
  open: (m) => ({
    embodiments: UNITS.map((u) => u.id),
    subscribe: m.observation_channels.map((c) => c.id),
    admin: ["reset"],
    task: {
      content: [{ type: "text", text: "Run the dispatch desk for the shift: get every call the help it needs." }],
    },
  }),
});
