import { runAgent } from "@awp-demo/agent";
import { PORTS } from "../shared/cell.ts";
import { llm } from "./controllers/llm.ts";
import { manual } from "./controllers/manual.ts";
import { program } from "./controllers/program.ts";

await runAgent({
  name: "sorter-agent",
  worldUrl: process.env.AWP_URL ?? `ws://127.0.0.1:${PORTS.world}`,
  token: process.env.AWP_TOKEN ?? "awp-demo-local-token",
  inspectorPort: Number(process.env.INSPECTOR_PORT ?? PORTS.agentInspector),
  consumes: ["proprio/json", "text/event+json"],
  controllers: [program, manual, llm],
  clock: { rateHz: 20 },
  open: (m) => ({
    embodiments: ["arm_0", "gripper_0"],
    subscribe: m.observation_channels.map((c) => c.id),
    admin: ["tick", "reset"],
  }),
});
