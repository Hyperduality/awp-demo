import { actionTools, createLlmController } from "@awp-demo/agent/llm";
import { tool } from "ai";
import { z } from "zod";
import { CELL } from "../../shared/cell.ts";
import { describeCell } from "./observe.ts";

/**
 * A language model with the arm and the gripper as tools. The world is lockstep, so time stands
 * still while the model thinks and moves only while its actions execute.
 */
export const sorterLlm = (overrides: Partial<Parameters<typeof createLlmController>[0]> = {}) =>
  createLlmController({
    description: "A language model with the arm and gripper as tools. The world holds still while it thinks.",
    kickoff: () => "Sort the next three parcels into the bins of their colours.",
    instructions: () =>
      [
        "You operate a sorting cell through the Agent World Protocol. You see it as a side view in metres: x runs along the belt, z is height.",
        "Tools move the arm (move_to, stop) and the gripper (grip, release). Each tool call runs the action to completion and returns the outcome and the cell as it is afterwards.",
        `To pick a parcel: move above it at z=${CELL.hoverZ}, descend to z=${CELL.graspZ} directly over it, grip, then check the gripper is holding it.`,
        `To sort: move to the bin of the parcel's colour at z=${CELL.dropZ} and release.`,
        "Time only passes while your actions run, so parcels move only then. Aim slightly ahead of a parcel (by belt speed × the move's duration).",
        "Be concise. Think briefly, act, and check outcomes. Call finish with a short summary when the instruction is done.",
      ].join("\n"),
    tools: (ctx) => ({
      ...actionTools(ctx, {
        observe: () => describeCell(ctx),
        embodimentFor: (t) => (t === "grip" || t === "release" ? "gripper_0" : "arm_0"),
        format: (o) =>
          [
            `${o.action}: ${o.state}${o.reason ? ` (${o.reason}${o.detail ? `: ${o.detail}` : ""})` : ""}`,
            o.meanwhile?.length ? `Meanwhile: ${o.meanwhile.join("; ")}` : "",
            String(o.observation),
          ]
            .filter(Boolean)
            .join("\n"),
      }),
      look: tool({
        description: "Describe the cell as it is now, without acting.",
        inputSchema: z.object({}),
        execute: async () => describeCell(ctx),
      }),
    }),
    ...overrides,
  });

export const llm = sorterLlm();
