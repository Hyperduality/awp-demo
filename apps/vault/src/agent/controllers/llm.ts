import type { ControlContext } from "@awp-demo/agent";
import { actionTools, createLlmController, type LlmConfig } from "@awp-demo/agent/llm";
import { tool } from "ai";
import { z } from "zod";
import { Knowledge } from "./knowledge.ts";

const MAP_MARK = "Map (";

function describe(ctx: ControlContext<unknown>): string {
  const k = Knowledge.read(ctx);
  if (!k) return "No observation yet.";
  const s = k.status;
  return [
    `You are at (${s.position[0]}, ${s.position[1]}) facing ${s.facing}. Carrying: ${s.inventory.length ? s.inventory.join(", ") : "nothing"}.${s.escaped ? " You have escaped." : ""}`,
    `Last: ${s.message}`,
    `${MAP_MARK}x across, y down; ? not seen yet):`,
    k.text(),
    "Legend: # wall, . floor, ? unseen, @ you, r/b/y keys, R/B/Y locked doors, + open door, * gem, E exit.",
  ].join("\n");
}

type ToolMessage = { role: "tool"; content: { type: string; output?: { type: string; value?: unknown } }[] };

/**
 * A language model exploring the vault. Tools are the world's own actions; each returns the outcome
 * with the map as it now stands. Older maps are collapsed out of the context before each step, so
 * the model always reasons over one current map.
 */
export const vaultLlm = (overrides: Partial<Parameters<typeof createLlmController<LlmConfig>>[0]> = {}) =>
  createLlmController({
    description: "A language model with the explorer's actions; the vault stays still while it thinks.",
    kickoff: () => "Retrieve the gem from the vault and leave through the exit.",
    instructions: () =>
      [
        "You are an explorer in a tiled vault, acting through the Agent World Protocol. x grows east, y grows south.",
        "You see three tiles around you and nothing behind walls or closed doors. The map shows everything you have seen.",
        "Keys open doors of their colour. The gem lies behind locked doors. The exit (E) only opens for whoever carries the gem.",
        "Use walk_to for travel over tiles you have seen; it fails if no known path exists, so explore toward ? tiles first.",
        "interact works on your own tile or one next to you: stand on an item to pick it up, stand beside a door or the exit to use it.",
        "The world is lockstep: nothing moves while you think. Keep thoughts brief. Call finish once you have escaped.",
      ].join("\n"),
    tools: (ctx) => ({
      ...actionTools(ctx, {
        types: ["move", "walk_to", "interact", "drop"],
        observe: () => describe(ctx),
        format: (o) =>
          [
            `${o.action}: ${o.state}${o.detail ? ` (${o.detail})` : ""}`,
            o.meanwhile?.length ? `Meanwhile: ${o.meanwhile.join("; ")}` : "",
            String(o.observation),
          ]
            .filter(Boolean)
            .join("\n"),
      }),
      look: tool({
        description: "Show your status and the map without acting.",
        inputSchema: z.object({}),
        execute: async () => describe(ctx),
      }),
    }),
    // Keep only the newest map in context; earlier tool results keep their outcome line.
    prepareStep: ({ messages }) => {
      const tools = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "tool");
      const keep = new Set(tools.slice(-1).map(({ i }) => i));
      return {
        messages: messages.map((m, i) => {
          if (m.role !== "tool" || keep.has(i)) return m;
          const t = m as unknown as ToolMessage;
          return {
            ...m,
            content: t.content.map((part) => {
              const v = part.output?.value;
              if (typeof v !== "string" || !v.includes(MAP_MARK)) return part;
              return {
                ...part,
                output: { type: "text", value: `${v.slice(0, v.indexOf(MAP_MARK)).trim()}\n(older map omitted)` },
              };
            }),
          } as typeof m;
        }),
      };
    },
    ...overrides,
  });

export const llm = vaultLlm();
