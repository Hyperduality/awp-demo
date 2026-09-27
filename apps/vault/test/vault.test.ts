import { ControlMux } from "@awp-demo/agent";
import type { ActivityEntry } from "@awp-demo/inspector";
import { type RunningWorld, serveWorld } from "@awp-demo/world";
import { AwpClient } from "@hyperduality/awp";
import { afterEach, describe, expect, it } from "vitest";
import { program } from "../src/agent/controllers/program.ts";
import { LAYOUTS } from "../src/shared/vault.ts";
import { vault } from "../src/world/definition.ts";

let world: RunningWorld | undefined;
let client: AwpClient | undefined;
let mux: ControlMux | undefined;
afterEach(async () => {
  mux?.detach();
  await client?.close().catch(() => undefined);
  await world?.close();
});

describe("vault layouts", () => {
  it.each(Object.keys(LAYOUTS))("%s can be solved: keys before doors, the gem, then the exit", (name) => {
    const rows = LAYOUTS[name]!;
    // Search over (position, keys held); doors need their key; the gem needs reaching; the exit needs the gem.
    type S = { x: number; y: number; keys: string; gem: boolean };
    const start = rows.flatMap((r, y) => [...r].map((c, x) => (c === "S" ? { x, y } : null))).find(Boolean)!;
    const seen = new Set<string>();
    const queue: S[] = [{ ...start, keys: "", gem: false }];
    let solved = false;
    while (queue.length && !solved) {
      const s = queue.shift()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const x = s.x + dx;
        const y = s.y + dy;
        const c = rows[y]?.[x] ?? "#";
        if (c === "#") continue;
        if (c === "E") {
          if (s.gem) solved = true;
          continue;
        }
        if ("RBY".includes(c) && !s.keys.includes(c.toLowerCase())) continue;
        const n = {
          x,
          y,
          keys: "rby".includes(c) && !s.keys.includes(c) ? [...s.keys, c].sort().join("") : s.keys,
          gem: s.gem || c === "G",
        };
        const k = `${x},${y},${n.keys},${n.gem}`;
        if (!seen.has(k)) {
          seen.add(k);
          queue.push(n);
        }
      }
    }
    expect(solved).toBe(true);
  });
});

describe("vault planner", () => {
  it.each(["small", "default"])(
    "escapes the %s vault from its own observations",
    async (initial) => {
      world = await serveWorld(
        {
          ...vault,
          manifest: {
            ...vault.manifest,
            initial_states: [initial, ...vault.manifest.initial_states!.filter((s) => s !== initial)],
          },
        },
        { port: 0, token: "vault-test-token-0000", log: () => {} },
      );
      client = new AwpClient({
        url: world.url,
        token: "vault-test-token-0000",
        agent: { name: "t", version: "0", vendor: "t" },
        consumesModalities: ["text/event+json"],
      });
      await client.initialize();
      await client.openSession("lockstep", { embodiment: "explorer_0", subscribe: ["map", "status"] });
      const activity: ActivityEntry[] = [];
      mux = new ControlMux(
        [{ ...program, enabled: true } as never],
        { activity: (e) => activity.push(e), controllers: () => {}, changed: () => {} },
        { rateHz: 0 },
      );
      mux.attach(client);
      const t0 = Date.now();
      while (!(world.host.sim.view() as { escaped: boolean }).escaped) {
        if (Date.now() - t0 > 20000)
          throw new Error(
            `not escaped: ${activity
              .filter((e) => e.kind === "decision")
              .map((e) => e.title)
              .join("; ")}`,
          );
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(activity.some((e) => e.title.startsWith("Open the"))).toBe(true);
    },
    30000,
  );
});

import type { LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { vaultLlm } from "../src/agent/controllers/llm.ts";

describe("vault llm", () => {
  it("acts through world actions and keeps only the newest map in context", async () => {
    world = await serveWorld(vault, { port: 0, token: "vault-test-token-0000", log: () => {} });
    client = new AwpClient({
      url: world.url,
      token: "vault-test-token-0000",
      agent: { name: "t", version: "0", vendor: "t" },
      consumesModalities: ["text/event+json"],
    });
    await client.initialize();
    await client.openSession("lockstep", { embodiment: "explorer_0", subscribe: ["map", "status"] });
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const call = (id: string, name: string, input: unknown): LanguageModelV4StreamResult => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ]),
    });
    const model = new MockLanguageModelV4({
      doStream: [
        call("1", "move", { direction: "east" }),
        call("2", "move", { direction: "west" }),
        call("3", "finish", { summary: "Done." }),
      ],
    });
    const activity: ActivityEntry[] = [];
    mux = new ControlMux(
      [vaultLlm({ model: () => model })] as never,
      { activity: (e) => activity.push(e), controllers: () => {}, changed: () => {} },
      { rateHz: 0 },
    );
    mux.attach(client);
    mux.message("llm", "Walk east, then back.");
    const t0 = Date.now();
    while (!activity.some((e) => e.title === "Done.")) {
      if (Date.now() - t0 > 10000) throw new Error("no finish");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(activity.filter((e) => e.kind === "action" && e.state === "completed").map((e) => e.title)).toEqual([
      "move",
      "move",
    ]);
    const prompt = JSON.stringify(model.doStreamCalls[2]!.prompt);
    expect(prompt.match(/older map omitted/g)).toHaveLength(1);
    expect(prompt.match(/Map \(x across/g)).toHaveLength(1);
  });
});
