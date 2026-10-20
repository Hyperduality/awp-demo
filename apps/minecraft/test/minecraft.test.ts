import { readFileSync } from "node:fs";
import type { LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { ControlMux } from "@awp-demo/agent";
import type { ActivityEntry } from "@awp-demo/inspector";
import { inputChunkProblems, type RunningWorld, serveWorld } from "@awp-demo/world";
import { AwpClient, jsonPayload } from "@hyperduality/awp";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hold } from "../src/agent/controllers/input.ts";
import { minecraftLlm } from "../src/agent/controllers/llm.ts";
import { program } from "../src/agent/controllers/program.ts";
import { DEG_PER_COUNT, KEYS, type Scene, type Status } from "../src/shared/minecraft.ts";
import { minecraft } from "../src/world/definition.ts";
import { manifest } from "../src/world/manifest.ts";

const TOKEN = "minecraft-test-token-0000";
let world: RunningWorld | undefined;
const problems: string[] = [];

beforeAll(() => {
  process.env.AWP_MINECRAFT_SIM = "fake";
});

afterEach(async () => {
  await world?.close();
  world = undefined;
  expect(problems.filter((p) => p.includes("failed its sender form"))).toEqual([]);
  problems.length = 0;
});

async function connect(mode: "lockstep" | "streaming") {
  world = await serveWorld(
    minecraft(() => {}),
    { port: 0, token: TOKEN, log: (l) => problems.push(l) },
  );
  const c = new AwpClient({
    url: world.url,
    token: TOKEN,
    agent: { name: "test", version: "0.0.0", vendor: "awp-demo" },
    consumesModalities: ["image/jpeg", "text/event+json"],
  });
  await c.initialize();
  await c.openSession(mode, { embodiment: "player", subscribe: ["pov", "status", "scene"] });
  return c;
}

const pose = (c: AwpClient) => jsonPayload<Scene>(c.latest("scene")!.frame).entities[0]!.pose;

describe("the Minecraft world", () => {
  it("declares input_chunk as AWP-GAM-001 allows, with the sidecar's keymap", () => {
    expect(inputChunkProblems(manifest)).toEqual([]);
    const keymap = JSON.parse(readFileSync(new URL("../shared/keymap.json", import.meta.url), "utf8")) as {
      keys: Record<string, string>;
      deg_per_count: number;
    };
    expect(keymap.keys).toEqual(KEYS);
    expect(keymap.deg_per_count).toBe(DEG_PER_COUNT);
  });

  it("walks and turns by device input in lockstep, one slot per advance", async () => {
    const c = await connect("lockstep");
    expect([...c.latest("pov")!.frame.payload.slice(0, 2)]).toEqual([0xff, 0xd8]);
    const walk = await c.submit("input_chunk", {
      slot_ms: 50,
      slots: [...Array.from({ length: 4 }, () => ({ keys: ["KeyW"] })), { mouse_dx: 600 }],
    });
    await c.advance(4);
    expect(pose(c).p_m[2]).toBeGreaterThan(1.3);
    await c.advance(1);
    expect(walk.state).toBe("completed");
    const scene = jsonPayload<Scene>(c.latest("scene")!.frame);
    expect(scene.entities[0]!.state.yaw_deg).toBe(90);
    expect(jsonPayload<Status>(c.latest("status")!.frame).selected_slot).toBe(1);
    await c.close();
  });

  it("streams frames at 20 Hz and runs a chunk in real time", async () => {
    const c = await connect("streaming");
    await c.freshFrame("scene");
    const start = pose(c).p_m[2];
    const rec = await c.submit("input_chunk", {
      slot_ms: 50,
      slots: Array.from({ length: 10 }, () => ({ keys: ["KeyW"] })),
    });
    await rec.settled();
    expect(rec.state).toBe("completed");
    await new Promise((r) => setTimeout(r, 300));
    expect(pose(c).p_m[2] - start).toBeCloseTo(2.16, 1);
    await c.close();
  });
});

describe("the Minecraft controllers", () => {
  it("spread a turn over a hold in whole counts that sum to it", () => {
    const slots = hold(["KeyW", "NotAKey"], 330, 10, -3);
    expect(slots).toHaveLength(7);
    expect(slots.every((s) => s.keys?.join() === "KeyW")).toBe(true);
    expect(slots.reduce((n, s) => n + (s.mouse_dx ?? 0), 0)).toBe(Math.round(10 / DEG_PER_COUNT));
    expect(slots.reduce((n, s) => n + (s.mouse_dy ?? 0), 0)).toBe(Math.round(-3 / DEG_PER_COUNT));
  });

  it("let the wanderer walk in lockstep", async () => {
    const c = await connect("lockstep");
    const mux = new ControlMux(
      [{ ...program, enabled: true }],
      { activity: () => {}, controllers: () => {}, changed: () => {} },
      { rateHz: 0 },
    );
    mux.attach(c);
    const start = pose(c).p_m;
    const t0 = Date.now();
    while (Math.hypot(pose(c).p_m[0] - start[0], pose(c).p_m[2] - start[2]) < 2) {
      if (Date.now() - t0 > 10000) throw new Error("the wanderer did not move");
      await new Promise((r) => setTimeout(r, 20));
    }
    mux.detach();
    await c.close();
  });
});

describe("the Minecraft LLM", () => {
  it("sees the view as an image and acts through input_chunk in lockstep", async () => {
    const c = await connect("lockstep");
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
        call("1", "see", {}),
        call("2", "act", { keys: ["KeyW"], hold_ms: 400, look_dx: 30 }),
        call("3", "finish", { summary: "Walked." }),
      ],
    });
    const activity: ActivityEntry[] = [];
    const mux = new ControlMux(
      [minecraftLlm({ model: () => model })] as never,
      { activity: (e) => activity.push(e), controllers: () => {}, changed: () => {} },
      { rateHz: 0 },
    );
    mux.attach(c);
    const start = pose(c).p_m[2];
    mux.message("llm", "Walk forward.");
    const t0 = Date.now();
    while (!activity.some((e) => e.title === "Walked.")) {
      if (Date.now() - t0 > 10000) throw new Error("no finish");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(activity.some((e) => e.kind === "action" && e.state === "completed")).toBe(true);
    expect(pose(c).p_m[2]).toBeGreaterThan(start + 1);
    // The view reaches the model as an image in the tool result.
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("image/jpeg");
    mux.detach();
    await c.close();
  });
});
