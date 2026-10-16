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

  /** A vault session driven by the LLM controller alone, with one scripted model reply per call. */
  async function scripted(replies: ((signal: AbortSignal | undefined) => LanguageModelV4StreamResult)[]) {
    world = await serveWorld(vault, { port: 0, token: "vault-test-token-0000", log: () => {} });
    client = new AwpClient({
      url: world.url,
      token: "vault-test-token-0000",
      agent: { name: "t", version: "0", vendor: "t" },
      consumesModalities: ["text/event+json"],
    });
    await client.initialize();
    await client.openSession("lockstep", { embodiment: "explorer_0", subscribe: ["map", "status"], admin: ["reset"] });
    let n = 0;
    const model = new MockLanguageModelV4({ doStream: async (o) => replies[n++]!(o.abortSignal) });
    const activity: ActivityEntry[] = [];
    const m = new ControlMux(
      [vaultLlm({ model: () => model })] as never,
      {
        activity: (e) => {
          const i = activity.findIndex((a) => a.id === e.id);
          if (i >= 0) activity[i] = e;
          else activity.push(e);
        },
        controllers: () => {},
        changed: () => {},
      },
      { rateHz: 0 },
    );
    mux = m;
    m.attach(client);
    const until = async (cond: () => boolean, what: string) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > 10000) throw new Error(`timed out: ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const prompt = (i: number) => JSON.stringify(model.doStreamCalls[i]!.prompt);
    return { mux: m, client, model, activity, until, prompt };
  }
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const call = (name: string, input: unknown) => (): LanguageModelV4StreamResult => ({
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: `${name}-${Math.random()}`, toolName: name, input: JSON.stringify(input) },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
    ]),
  });
  /** A model call that thinks until it is aborted. */
  const hang = (signal: AbortSignal | undefined): LanguageModelV4StreamResult => ({
    stream: new ReadableStream({
      start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    }),
  });

  it("remembers a stopped turn and hears about a reset", async () => {
    const t = await scripted([call("move", { direction: "east" }), hang, call("finish", { summary: "Done." })]);
    t.mux.message("llm", "Walk east.");
    await t.until(() => t.model.doStreamCalls.length === 2, "second model call");
    t.mux.interrupt("llm");
    await t.until(() => t.activity.some((e) => e.title === "Stopped"), "stopped");
    await t.client.reset();
    await t.until(() => t.activity.some((e) => e.title === "World reset"), "reset event");
    t.mux.message("llm", "Try again.");
    await t.until(() => t.activity.some((e) => e.title === "Done."), "finish");

    const prompt = t.prompt(2);
    expect(prompt).toContain("Walk east.");
    // The finished step of the stopped turn stays in memory, followed by how that turn ended.
    expect(prompt).toContain("move: completed");
    expect(prompt).toContain("The operator stopped your last turn.");
    expect(prompt).toContain("Since your last turn:");
    expect(prompt).toContain("world: World reset");
  }, 20000);

  it("stops during an action even while the clock is paused", async () => {
    const t = await scripted([call("walk_to", { cell: [1, 4] }), call("finish", { summary: "Done." })]);
    t.mux.setPaused(true);
    t.mux.message("llm", "Walk to (1, 4).");
    await t.until(() => t.activity.some((e) => e.kind === "action" && e.state === "accepted"), "walk accepted");
    t.mux.interrupt("llm");
    await t.until(() => t.activity.some((e) => e.title === "Stopped"), "stopped while paused");
    t.mux.setPaused(false);
    await t.until(() => t.activity.some((e) => e.kind === "action" && e.state === "cancelled"), "walk cancelled");
    t.mux.message("llm", "Where are you?");
    await t.until(() => t.activity.some((e) => e.title === "Done."), "finish");

    expect(t.prompt(1)).toContain("The operator stopped your last turn. Your actions in it:");
    expect(t.prompt(1)).toContain("walk_to cell [1, 4] → cancelled");
  }, 20000);

  it("tells the model when its last turn hit the step limit", async () => {
    const t = await scripted([
      call("move", { direction: "east" }),
      call("move", { direction: "east" }),
      call("finish", { summary: "Done." }),
    ]);
    t.mux.configure("llm", { maxSteps: 2 });
    t.mux.message("llm", "Keep walking east.");
    await t.until(() => t.activity.some((e) => e.title === "Step limit reached"), "step limit");
    t.mux.message("llm", "Continue.");
    await t.until(() => t.activity.some((e) => e.title === "Done."), "finish");

    expect(t.prompt(2)).toContain("Your last turn reached the step limit of 2 model calls before you called finish.");
  }, 20000);
});
