import { ControlMux } from "@awp-demo/agent";
import type { ActivityEntry } from "@awp-demo/inspector";
import { type RunningWorld, serveWorld } from "@awp-demo/world";
import { AwpClient } from "@hyperduality/awp";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { sorterLlm } from "../src/agent/controllers/llm.ts";
import { program } from "../src/agent/controllers/program.ts";
import { sorter } from "../src/world/definition.ts";
import { SorterSim } from "../src/world/sim.ts";

const TOKEN = "sorter-test-token-000";
let world: RunningWorld | undefined;
let client: AwpClient | undefined;
let mux: ControlMux | undefined;

afterEach(async () => {
  mux?.detach();
  await client?.close().catch(() => undefined);
  await world?.close();
});

async function start(controllers: ConstructorParameters<typeof ControlMux>[0]) {
  world = await serveWorld(sorter, { port: 0, token: TOKEN, log: () => {} });
  client = new AwpClient({
    url: world.url,
    token: TOKEN,
    agent: { name: "t", version: "0", vendor: "t" },
    consumesModalities: ["proprio/json", "text/event+json"],
  });
  await client.initialize();
  await client.openSession("lockstep", {
    embodiments: ["arm_0", "gripper_0"],
    subscribe: ["proprio", "gripper_state", "scene"],
  });
  const activity: ActivityEntry[] = [];
  mux = new ControlMux(
    controllers,
    { activity: (e) => activity.push(e), controllers: () => {}, changed: () => {} },
    { rateHz: 0 },
  );
  mux.attach(client);
  return activity;
}

const until = async (pred: () => boolean, ms = 20000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("sorter sim", () => {
  it("is deterministic for a seed", () => {
    const run = () => {
      const s = new SorterSim(3, "default");
      for (let i = 0; i < 400; i++) s.step(50);
      return JSON.stringify(s.view().parcels);
    };
    expect(run()).toBe(run());
  });

  it("refuses targets out of reach", () => {
    const s = new SorterSim(1, "default");
    expect(s.admit("arm_0", "move_to", { x_m: 0.99, z_m: 0.05 })).toMatchObject({ error: "AWP_ENVELOPE_EXCEEDED" });
    expect(s.admit("arm_0", "move_to", { x_m: 0.2, z_m: 0.3 })).toEqual({ ok: true });
  });
});

describe("sorter controllers", () => {
  it("the program sorts parcels into the right bins", async () => {
    await start([program as never] as ConstructorParameters<typeof ControlMux>[0]);
    await until(() => (world!.host.sim.view() as { stats: { sorted: number } }).stats.sorted >= 3, 30000);
    expect((world!.host.sim.view() as { stats: { wrong: number } }).stats.wrong).toBe(0);
  }, 40000);

  it("an LLM turn runs its tools against the world and streams into the activity log", async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "r" },
            { type: "reasoning-delta", id: "r", delta: "Raise the arm first." },
            { type: "reasoning-end", id: "r" },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "move_to",
              input: JSON.stringify({ x_m: 0.1, z_m: 0.45 }),
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ]),
        },
        {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "c2",
              toolName: "finish",
              input: JSON.stringify({ summary: "Arm raised." }),
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ]),
        },
      ],
    });
    const activity = await start([sorterLlm({ model: () => model })] as ConstructorParameters<typeof ControlMux>[0]);
    mux!.message("llm", "Raise the arm.");
    await until(() => activity.some((e) => e.kind === "message" && e.title === "Arm raised."));
    const move = activity.filter((e) => e.kind === "action" && e.title === "move_to").at(-1);
    expect(move?.state).toBe("completed");
    expect(activity.some((e) => e.kind === "thought" && e.title === "Raise the arm first.")).toBe(true);
    // The tool result the model saw carries the world's outcome and a fresh observation.
    const second = model.doStreamCalls[1]!.prompt.at(-1) as { content: { output: { value: string } }[] };
    expect(second.content[0]!.output.value).toMatch(/move_to: completed[\s\S]*End effector at x=0\.100 z=0\.450/);
    // Lockstep time stood still once the turn ended.
    const t = client!.tick;
    await new Promise((r) => setTimeout(r, 200));
    expect(client!.tick).toBe(t);
  });
});
