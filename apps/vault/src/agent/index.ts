import { runAgent } from "@awp-demo/agent";
import { PORTS } from "../shared/vault.ts";
import { llm } from "./controllers/llm.ts";
import { manual } from "./controllers/manual.ts";
import { program } from "./controllers/program.ts";

await runAgent({
  name: "vault-agent",
  worldUrl: process.env.AWP_URL ?? `ws://127.0.0.1:${PORTS.world}`,
  token: process.env.AWP_TOKEN ?? "awp-demo-local-token",
  inspectorPort: Number(process.env.INSPECTOR_PORT ?? PORTS.agentInspector),
  consumes: ["text/event+json"],
  controllers: [llm, manual, program],
  clock: { rateHz: 8 },
  open: (m) => ({
    embodiment: "explorer_0",
    subscribe: m.observation_channels.map((c) => c.id),
    admin: ["tick", "reset"],
    task: { content: [{ type: "text", text: "Retrieve the gem from the vault and leave through the exit." }] },
  }),
});
