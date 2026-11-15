import { runAgent } from "@awp-demo/agent";
import { EMBODIMENT, PORTS } from "../shared/yard.ts";
import { llm } from "./controllers/llm.ts";
import { manual } from "./controllers/manual.ts";

await runAgent({
  name: "yard-agent",
  worldUrl: process.env.AWP_URL ?? `ws://127.0.0.1:${PORTS.world}`,
  token: process.env.AWP_TOKEN ?? "awp-demo-local-token",
  inspectorPort: Number(process.env.INSPECTOR_PORT ?? PORTS.agentInspector),
  consumes: ["text/event+json", "proprio/json", "image/raw", "pointcloud/xyz32"],
  controllers: [llm, manual],
  // The model's liveness holds off the world's watchdog; whoever takes over inherits the action under way.
  heartbeat: "intent",
  handoff: "inherit",
  open: (m) => ({
    embodiment: EMBODIMENT,
    subscribe: m.observation_channels.map((c) => c.id),
    admin: ["reset"],
    task: {
      content: [{ type: "text", text: "Move every pallet on the order list into its bay, with its load still on it." }],
    },
  }),
});
