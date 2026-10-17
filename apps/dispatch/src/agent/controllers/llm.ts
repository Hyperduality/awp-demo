import { createLlmSupervisor, LlmConfig, type SupervisorOptions } from "@awp-demo/agent/llm";
import { z } from "zod";
import { basisOf, boardNews, boardNotes, readBoard, renderBoard } from "./board.ts";

export const DispatchLlmConfig = LlmConfig.extend({
  thinkingS: z.number().int().min(0).max(30).default(0).meta({
    title: "Extra Thinking (s)",
    description:
      "Holds each model call this long while it shows life, like a model reasoning at length. Past 10 s its decisions arrive stale.",
  }),
  stallS: z.number().int().min(0).max(30).default(0).meta({
    title: "Stall (s)",
    description:
      "Holds each model call this long with no sign of life, like a hung request. Past 8 s the world stops the units.",
  }),
});
export type DispatchLlmConfig = z.infer<typeof DispatchLlmConfig>;

const INSTRUCTIONS = [
  "You are the dispatcher for a small city's emergency services. Calls arrive as what the caller said; read each one to judge what it needs:",
  "- fire engines (engine_1, engine_2) for fire, smoke from a building, gas, sparks, and people trapped or locked in;",
  "- ambulances (medic_1, medic_2) for anyone hurt, ill, unconscious or struggling to breathe;",
  "- police (police_1, police_2) for crime, violence, threats, danger on the road, and people at risk.",
  "Many calls need more than one kind. A call is resolved once every kind it needs has worked the scene, and lost if that takes too long; the gravest calls give you the least time, and a call that waits escalates. Score: resolving fast earns most, losing a call costs more.",
  "A unit sent where it is not needed says so on arrival and is free again. Units on scene report what else a call needs.",
  "The city is a grid: avenues A to I run north to south, A in the west; streets 1 to 7 run west to east, 1 in the north. A river between streets 4 and 5 is crossed only on avenues B, E and H. The ETAs in the view allow for it.",
  "dispatch sends a unit to a call. Dispatching a busy unit replaces its job, so check what it is doing first. stage sends a free unit to wait somewhere, such as the other side of the river. cancel stops a unit by the action_id it shows.",
  "Send one unit of each kind a call needs, the nearest free one unless a graver call needs it more; send a second of a kind only when the call plainly needs more, such as a big fire, or a unit on scene asks for another. Decide quickly: several calls can arrive while you think.",
].join("\n");

export const dispatchLlm = (overrides: Partial<SupervisorOptions<DispatchLlmConfig>> = {}) =>
  createLlmSupervisor<DispatchLlmConfig>({
    description:
      "A language model on duty at the desk. It reads each call, picks the units, and keeps working while the city moves on.",
    config: DispatchLlmConfig,
    kickoff: () => "You are on duty at the dispatch desk. Handle the calls as they come in.",
    instructions: () => INSTRUCTIONS,
    observe: (ctx) => {
      const board = readBoard(ctx);
      return { text: board ? renderBoard(board) : "No observation yet.", basis: basisOf(ctx) };
    },
    actions: { types: ["dispatch", "stage"] },
    news: boardNews,
    notes: boardNotes,
    delay: (config) => ({ thinkingMs: config.thinkingS * 1000, stallMs: config.stallS * 1000 }),
    keepTurns: 6,
    ...overrides,
  });

export const llm = dispatchLlm();
