import { createPolicyController } from "@awp-demo/agent";
import { TICK_MS } from "../../shared/minecraft.ts";

/**
 * OpenAI's VPT through MineStudio, served by `policy/`: one decision per frame. In lockstep the world
 * waits for each; in streaming each must reach the world within 100 ms of its frame.
 */
export const vpt = createPolicyController({
  id: "vpt",
  label: "VPT",
  description:
    "OpenAI's Video PreTraining policy plays from the view, one decision per tick. Run `uv run --package awp-minecraft-policy awp-minecraft-policy` first.",
  channel: "pov",
  slotMs: TICK_MS,
  validForMs: 100,
});
