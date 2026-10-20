import { runAgent } from "@awp-demo/agent";
import type { TimeModel } from "@hyperduality/awp";
import { PORTS } from "../shared/minecraft.ts";
import { llm } from "./controllers/llm.ts";
import { manual } from "./controllers/manual.ts";
import { vpt } from "./controllers/policy.ts";
import { program } from "./controllers/program.ts";

await runAgent({
  name: "minecraft-agent",
  worldUrl: process.env.AWP_URL ?? `ws://127.0.0.1:${PORTS.world}`,
  token: process.env.AWP_TOKEN ?? "awp-demo-local-token",
  inspectorPort: Number(process.env.INSPECTOR_PORT ?? PORTS.agentInspector),
  consumes: ["image/jpeg", "text/event+json"],
  controllers: [manual, llm, vpt, program],
  timeModel: (process.env.AWP_TIME_MODEL as TimeModel | undefined) ?? "streaming",
  // Lockstep advances at the game's own pace while a continuous controller holds control.
  clock: { rateHz: 20 },
  open: () => ({ embodiment: "player", subscribe: ["pov", "status", "scene"], admin: ["reset"] }),
});
