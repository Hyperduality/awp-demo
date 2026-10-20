import type { ControlContext, Controller } from "@awp-demo/agent";
import { createLlmController, createLlmSupervisor, finishTool, type LlmConfig } from "@awp-demo/agent/llm";
import type { ReceivedFrame } from "@hyperduality/awp";
import { AwpError } from "@hyperduality/awp";
import { type LanguageModel, tool } from "ai";
import { z } from "zod";
import { KEY_NAMES, type Status } from "../../shared/minecraft.ts";
import { attempt, chunk, hold, pose } from "./input.ts";

const INSTRUCTIONS = [
  "You play Minecraft (Java Edition 1.16) as the player, through keyboard and mouse.",
  "`see` shows you the first-person view and your status. `act` holds keys for a while and turns the view: keys are KeyW (forward), KeyS (back), KeyA/KeyD (strafe), Space (jump), ShiftLeft (sneak), ControlLeft (sprint), KeyE (inventory), MouseLeft (attack or mine; hold it to break a block), MouseRight (use or place), Digit1 to Digit9 (hotbar).",
  "look_dx turns right by that many degrees (negative turns left); look_dy looks down (negative looks up). Turns spread over the hold.",
  "Look before you act, and keep each act short (a second or less) so you can see what happened.",
].join("\n");

const KickOff = "Gather some wood: find a tree, walk up to it, and hold MouseLeft on its trunk until a log breaks.";

/** Your view: status and pose in words. */
function describe(ctx: ControlContext<unknown>): string {
  const s = ctx.latest<Status>("status");
  const p = pose(ctx);
  if (!s || !p) return "No view yet.";
  const items = s.inventory.map((i) => `${i.type} ×${i.quantity}`).join(", ") || "nothing";
  const mined = Object.entries(s.mined)
    .map(([k, v]) => `${k} ×${v}`)
    .join(", ");
  return [
    `Health ${s.health}/20, food ${s.food}/20. Holding slot ${s.selected_slot} (${s.mainhand}).`,
    `At x ${p.x.toFixed(1)}, y ${p.y.toFixed(1)}, z ${p.z.toFixed(1)}, facing yaw ${p.yaw.toFixed(0)}°, pitch ${p.pitch.toFixed(0)}°.`,
    `Inventory: ${items}.`,
    ...(mined ? [`Mined so far: ${mined}.`] : []),
  ].join("\n");
}

interface Seen {
  text: string;
  image?: string | undefined;
}

/** A tool result the model reads as text with the view attached. */
function withView(seen: Seen) {
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: seen.text },
      ...(seen.image
        ? [{ type: "file" as const, mediaType: "image/jpeg", data: { type: "data" as const, data: seen.image } }]
        : []),
    ],
  };
}

function look(ctx: ControlContext<unknown>): Seen {
  const pov = ctx.frame("pov");
  return { text: describe(ctx), image: pov ? Buffer.from(pov.frame.payload).toString("base64") : undefined };
}

const ActInput = z.object({
  keys: z.array(z.enum(KEY_NAMES)).default([]).describe("Keys and buttons to hold down"),
  hold_ms: z.number().int().min(50).max(1000).default(500).describe("How long to hold them, in ms"),
  look_dx: z.number().min(-180).max(180).default(0).describe("Turn right by this many degrees (negative: left)"),
  look_dy: z.number().min(-90).max(90).default(0).describe("Look down by this many degrees (negative: up)"),
});

/**
 * The tools. In lockstep `act` waits for the keys to be let go and shows what came of it; the world
 * waits meanwhile. In streaming it returns once the world admits or refuses the input, which rests on
 * the view the model last saw: by then that view is old, and the world refuses what it builds on.
 */
function tools(ctx: ControlContext<unknown>) {
  const basis = basisOf(ctx);
  return {
    see: tool({
      description: "See the first-person view and your status.",
      inputSchema: z.object({}),
      execute: async () => {
        ctx.alive();
        basis.frame = ctx.frame("pov");
        return look(ctx);
      },
      toModelOutput: ({ output }) => withView(output),
    }),
    act: tool({
      description: "Hold keys for a while, turning the view as they are held.",
      inputSchema: ActInput,
      execute: async (input) => {
        ctx.alive();
        const rec = await attempt(
          ctx.submit("input_chunk", chunk(hold(input.keys, input.hold_ms, input.look_dx, input.look_dy)), {
            preempt: "replace",
            ...(ctx.mode === "streaming" ? { basis: basis.frame, validForMs: 1000 } : {}),
          }),
        );
        if (rec instanceof AwpError) return { text: `Refused: ${rec.errorName}. ${rec.detail ?? ""}`.trim() };
        if (!rec) return { text: "You do not have control right now." };
        if (ctx.mode === "lockstep") await ctx.settle(rec);
        basis.frame = ctx.frame("pov");
        return { ...look(ctx), text: `${ctx.mode === "lockstep" ? "Done" : "Started"}.\n${describe(ctx)}` };
      },
      toModelOutput: ({ output }) => withView(output as Seen),
    }),
  };
}

/** The frame the model last looked at, per session: what its next intent rests on. */
const bases = new WeakMap<object, { frame?: ReceivedFrame | undefined }>();
function basisOf(ctx: ControlContext<unknown>) {
  let b = bases.get(ctx);
  if (!b) {
    b = {};
    bases.set(ctx, b);
  }
  return b;
}

/** The model: in lockstep it takes turns with a world that waits; in streaming it supervises a live one. */
export function minecraftLlm(overrides: { model?: (config: LlmConfig) => LanguageModel } = {}): Controller<LlmConfig> {
  const lockstep = createLlmController({
    description: "A vision model plays, one short action at a time; the world waits while it thinks.",
    instructions: () => INSTRUCTIONS,
    kickoff: () => KickOff,
    tools: (ctx) => ({ ...tools(ctx as ControlContext<unknown>), finish: finishTool }),
    ...overrides,
  });
  const streaming = createLlmSupervisor({
    description: "A vision model plays in real time: the world moves on while it thinks.",
    instructions: () => INSTRUCTIONS,
    kickoff: () => KickOff,
    observe: (ctx) => {
      const frame = ctx.frame("pov");
      basisOf(ctx as ControlContext<unknown>).frame = frame;
      return { text: describe(ctx as ControlContext<unknown>), basis: frame };
    },
    actions: { types: [] },
    tools: (ctx) => tools(ctx as ControlContext<unknown>),
    ...overrides,
  });
  return {
    ...lockstep,
    description:
      "A vision model plays from the view. In lockstep the world waits for each action; in streaming its decisions arrive late and the world refuses them.",
    create: (ctx) => (ctx.mode === "lockstep" ? lockstep : streaming).create(ctx),
  };
}

export const llm = minecraftLlm();
