import { AwpClient, jsonPayload, AwpError } from "@hyperduality/awp";
import { afterEach, describe, expect, it } from "vitest";
import { serveWorld, type RunningWorld } from "../src/index.ts";
import { gridworld } from "./gridworld.ts";

const TOKEN = "test-token-0123456789";
let world: RunningWorld | undefined;
const problems: string[] = [];

async function start(mode: "lockstep" | "streaming") {
  world = await serveWorld(gridworld(mode), { port: 0, token: TOKEN, log: (l) => problems.push(l) });
  return world;
}

function client(url: string, trace?: unknown[]) {
  return new AwpClient({
    url,
    token: TOKEN,
    agent: { name: "test", version: "0.0.0", vendor: "awp-demo" },
    consumesModalities: ["text/event+json"],
    ...(trace ? { trace: (dir: "in" | "out", m: unknown) => trace.push({ dir, m }) } : {}),
  });
}

afterEach(async () => {
  await world?.close();
  world = undefined;
  expect(problems.filter((p) => p.includes("failed its sender form"))).toEqual([]);
  problems.length = 0;
});

describe("lockstep gridworld", () => {
  it("runs the core lockstep trace: stage, advance, complete, close", async () => {
    const w = await start("lockstep");
    const c = client(w.url);
    await c.initialize();
    const ready = await c.openSession("lockstep", { embodiment: "avatar_0", subscribe: ["grid_view"], admin: ["tick"] });
    expect(ready.granted.channels).toEqual([{ channel: "grid_view", rate_hz: null, channel_id: 1 }]);
    expect(ready.tick).toBe(0);
    const rec = await c.submit("walk_to", { cell: [2, 0] }, { preempt: "replace" });
    expect(rec.state).toBe("accepted");
    let ticks = 0;
    while (!rec.terminal) {
      await c.advance(1);
      ticks += 1;
    }
    expect(rec.state).toBe("completed");
    expect(ticks).toBe(2);
    expect(jsonPayload<{ avatar: number[] }>(c.latest("grid_view")!.frame).avatar).toEqual([2, 0]);
    await c.close();
  });

  it("preempts in lockstep at the next advance (AWP-PRE-007)", async () => {
    const w = await start("lockstep");
    const c = client(w.url);
    await c.initialize();
    await c.openSession("lockstep", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const a = await c.submit("walk_to", { cell: [5, 0] }, { preempt: "replace" });
    await c.advance(1);
    expect(a.state).toBe("executing");
    const b = await c.submit("walk_to", { cell: [0, 2] }, { preempt: "replace" });
    expect(a.state).toBe("executing");
    await c.advance(1);
    expect(a.state).toBe("preempted");
    expect(b.state).toBe("executing");
    await c.close();
  });

  it("queues and rejects per the declared policies", async () => {
    const w = await start("lockstep");
    const c = client(w.url);
    await c.initialize();
    await c.openSession("lockstep", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    await c.submit("walk_to", { cell: [3, 0] }, { preempt: "queue" });
    const q1 = await c.submit("walk_to", { cell: [3, 3] }, { preempt: "queue" });
    expect(q1.state).toBe("queued");
    await c.submit("walk_to", { cell: [0, 3] }, { preempt: "queue" });
    await expect(c.submit("walk_to", { cell: [1, 1] }, { preempt: "queue" })).rejects.toThrow(/QUEUE_FULL/);
    await expect(c.submit("walk_to", { cell: "x" as unknown as number[] })).rejects.toThrow(/params_schema/);
    await expect(c.submit("fly", {})).rejects.toBeInstanceOf(Error);
    await c.close();
  });

  it("cancels, resets and refuses a mismatched tick", async () => {
    const w = await start("lockstep");
    const c = client(w.url);
    await c.initialize();
    await c.openSession("lockstep", { embodiment: "avatar_0", subscribe: ["grid_view"], admin: ["tick", "reset"] });
    const a = await c.submit("walk_to", { cell: [5, 0] });
    await c.advance(1);
    await c.cancel(a.action_id);
    expect(a.state).toBe("cancelling");
    await c.advance(1);
    expect(a.state).toBe("cancelled");
    expect(a.reason).toBe("cancelled_by_agent");
    const tick = await c.reset();
    expect(tick).toBe(0);
    await c.close();
  });
});

describe("streaming gridworld", () => {
  it("streams frames with ts_send_ns and completes an extended action", async () => {
    const w = await start("streaming");
    const trace: { dir: string; m: { method?: string; params?: Record<string, unknown> } }[] = [];
    const c = client(w.url, trace as unknown[]);
    await c.initialize();
    await c.openSession("streaming", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const basis = await c.freshFrame("grid_view");
    const rec = await c.submit("walk_to", { cell: [2, 0] }, { basis, validForMs: 1000 });
    await rec.settled();
    expect(rec.state).toBe("completed");
    const frames = trace.filter((t) => t.m.method === "obs.frame");
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => typeof f.m.params?.ts_send_ns === "number")).toBe(true);
    await c.close();
  });

  it("enters safe state when the agent falls silent (AWP-SAF-004)", async () => {
    const w = await start("streaming");
    const c = new AwpClient({
      url: w.url,
      token: TOKEN,
      agent: { name: "quiet", version: "0.0.0", vendor: "awp-demo" },
      consumesModalities: ["text/event+json"],
      heartbeat: "manual",
      obsReport: false,
    });
    await c.initialize();
    await c.openSession("streaming", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const rec = await c.submit("walk_to", { cell: [500, 0] });
    const event = await new Promise<{ event: string }>((resolve) => c.on("event", resolve));
    expect(event.event).toBe("safe_state_entered");
    await rec.settled();
    expect(rec.state).toBe("failed");
    expect(rec.reason).toBe("connection_lost");
    await c.close();
  });

  it("refuses a missing credential", async () => {
    const w = await start("streaming");
    const c = new AwpClient({ url: w.url, agent: { name: "x", version: "0", vendor: "x" }, consumesModalities: [] });
    await expect(c.initialize(2000)).rejects.toBeDefined();
  });
});

void AwpError;
