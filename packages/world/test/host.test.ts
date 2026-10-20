import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwpClient, AwpError, jsonPayload } from "@hyperduality/awp";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningWorld, serveWorld } from "../src/index.ts";
import { gridworld, type StepProbe } from "./gridworld.ts";

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
    const ready = await c.openSession("lockstep", {
      embodiment: "avatar_0",
      subscribe: ["grid_view"],
      admin: ["tick"],
    });
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

  it("activates a session with nothing subscribed before its first admission (AWP-CTL-008)", async () => {
    const w = await start("streaming");
    const trace: { dir: string; m: { params?: { status_seq?: number }; result?: { status_seq?: number } } }[] = [];
    const c = client(w.url, trace as unknown[]);
    await c.initialize();
    await c.openSession("streaming", { embodiment: "avatar_0", subscribe: [] });
    const rec = await c.submit("walk_to", { cell: [1, 0] });
    await rec.settled();
    const seqs = trace
      .filter((t) => t.dir === "in")
      .map((t) => t.m.params?.status_seq ?? t.m.result?.status_seq)
      .filter((n): n is number => typeof n === "number" && n > 0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(rec.violations).toEqual([]);
    await c.close();
  });

  it("refuses an intent on a stale basis or past its validity (AWP-SAF-013)", async () => {
    world = await serveWorld(gridworld("streaming", { maxBasisAgeMs: 300 }), {
      port: 0,
      token: TOKEN,
      log: (l) => problems.push(l),
    });
    const c = client(world.url);
    await c.initialize();
    await c.openSession("streaming", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const old = await c.freshFrame("grid_view");
    await new Promise((r) => setTimeout(r, 450));
    const stale = await c.submit("walk_to", { cell: [2, 0] }, { basis: old }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(AwpError);
    expect((stale as AwpError).errorName).toBe("AWP_STALE_INTENT");
    expect((stale as AwpError).retryable).toBe(true);
    const fresh = await c.submit("walk_to", { cell: [2, 0] }, { basis: await c.freshFrame("grid_view") });
    expect(fresh.state).not.toBe("rejected");
    await fresh.settled();
    expect(fresh.state).toBe("completed");
    await c.close();
  });

  it("rejects a queued intent whose validity passed while it waited (AWP-SAF-013)", async () => {
    world = await serveWorld(gridworld("streaming", { maxBasisAgeMs: 5000 }), {
      port: 0,
      token: TOKEN,
      log: (l) => problems.push(l),
    });
    const c = client(world.url);
    await c.initialize();
    await c.openSession("streaming", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const first = await c.submit("walk_to", { cell: [12, 0] }, { preempt: "queue" });
    const waiting = await c.submit("walk_to", { cell: [0, 0] }, { preempt: "queue", validForMs: 100 });
    expect(waiting.state).toBe("queued");
    await waiting.settled();
    expect(first.state).toBe("completed");
    expect(waiting.state).toBe("rejected");
    expect(waiting.reason).toBe("stale_intent");
    await c.close();
  });

  it("refuses a missing credential", async () => {
    const w = await start("streaming");
    const c = new AwpClient({ url: w.url, agent: { name: "x", version: "0", vendor: "x" }, consumesModalities: [] });
    await expect(c.initialize(2000)).rejects.toBeDefined();
  });
});

describe("an async sim", () => {
  it("finishes every step of an advance, with its frames, before the result (AWP-TIM-003)", async () => {
    const probe: StepProbe = { steps: 0, inFlight: 0, maxInFlight: 0 };
    world = await serveWorld(gridworld("lockstep", { asyncStepMs: 15, probe }), {
      port: 0,
      token: TOKEN,
      log: (l) => problems.push(l),
    });
    const trace: { dir: string; m: { method?: string; params?: { tick?: number }; result?: { tick?: number } } }[] = [];
    const c = client(world.url, trace as unknown[]);
    await c.initialize();
    await c.openSession("lockstep", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    await c.submit("walk_to", { cell: [3, 0] });
    await c.advance(3);
    expect(probe.steps).toBe(3);
    expect(probe.maxInFlight).toBe(1);
    const incoming = trace.filter((t) => t.dir === "in");
    const result = incoming.findIndex((t) => t.m.result?.tick === 3);
    const frames = incoming
      .map((t, i) => ({ i, tick: t.m.method === "obs.frame" ? t.m.params?.tick : undefined }))
      .filter((f) => f.tick !== undefined && f.tick > 0);
    expect(frames.map((f) => f.tick)).toEqual([1, 2, 3]);
    expect(frames.every((f) => f.i < result)).toBe(true);
    await c.close();
  });

  it("steps at most once per stepMs with fixed pacing, counting overruns instead of bursting", async () => {
    const probe: StepProbe = { steps: 0, inFlight: 0, maxInFlight: 0 };
    world = await serveWorld(gridworld("streaming", { asyncStepMs: 30, stepMs: 10, pacing: "fixed", probe }), {
      port: 0,
      token: TOKEN,
      log: (l) => problems.push(l),
    });
    const c = client(world.url);
    await c.initialize();
    await c.openSession("streaming", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const before = probe.steps;
    await new Promise((r) => setTimeout(r, 400));
    const steps = probe.steps - before;
    expect(probe.maxInFlight).toBe(1);
    // A burst would run 40 steps in 400 ms; each step takes 30 ms, so about 13 fit.
    expect(steps).toBeLessThanOrEqual(15);
    expect(steps).toBeGreaterThanOrEqual(8);
    expect(world.host.overruns).toBeGreaterThan(0);
    await c.close();
  });
});

describe("binary observations", () => {
  it("sends a binary payload as is and hashes its bytes in the audit log (AWP-AUD-001)", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "awp-audit-"));
    world = await serveWorld(gridworld("lockstep", { camera: true }), {
      port: 0,
      token: TOKEN,
      auditDir,
      log: (l) => problems.push(l),
    });
    const c = new AwpClient({
      url: world.url,
      token: TOKEN,
      agent: { name: "test", version: "0.0.0", vendor: "awp-demo" },
      consumesModalities: ["text/event+json", "image/jpeg"],
    });
    await c.initialize();
    await c.openSession("lockstep", { embodiment: "avatar_0", subscribe: ["grid_view", "camera"] });
    await c.submit("walk_to", { cell: [2, 0] });
    await c.advance(2);
    const camera = c.latest("camera")!.frame;
    expect([...camera.payload]).toEqual([2, 0]);
    await c.close();
    const records = readdirSync(auditDir).flatMap((f) =>
      readFileSync(join(auditDir, f), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { kind: string; body: { channel_id?: number; payload_sha256?: string } }),
    );
    const frames = records.filter((r) => r.kind === "frame");
    const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
    expect(frames.map((r) => r.body.payload_sha256)).toContain(hash(Uint8Array.from([2, 0])));
    const json = JSON.stringify({ avatar: [2, 0], goal: [2, 0] });
    expect(frames.map((r) => r.body.payload_sha256)).toContain(hash(json));
  });
});

describe("a world offering both time models", () => {
  async function both() {
    world = await serveWorld(gridworld("both"), { port: 0, token: TOKEN, log: (l) => problems.push(l) });
    return world;
  }

  it("runs a lockstep session, then a streaming one (AWP-TIM-008)", async () => {
    const w = await both();
    const a = client(w.url);
    await a.initialize();
    await a.openSession("lockstep", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const walk = await a.submit("walk_to", { cell: [2, 0] });
    await a.advance(2);
    expect(walk.state).toBe("completed");
    await a.close();

    const b = client(w.url);
    await b.initialize();
    const ready = await b.openSession("streaming", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    expect(ready.granted.channels[0]?.rate_hz).toBe(20);
    const back = await b.submit("walk_to", { cell: [0, 0] });
    await back.settled();
    expect(back.state).toBe("completed");
    await b.close();
  });

  it("refuses a session in the other time model while one is bound (AWP-TIM-001)", async () => {
    const w = await both();
    const a = client(w.url);
    await a.initialize();
    await a.openSession("streaming", { embodiment: "avatar_0", subscribe: ["grid_view"] });
    const b = client(w.url);
    await b.initialize();
    const refused = await b.openSession("lockstep", {}).catch((e: unknown) => e);
    expect((refused as AwpError).errorName).toBe("AWP_TIME_MODEL_UNSUPPORTED");
    const observer = await b.openSession("streaming", { subscribe: ["grid_view"] });
    expect(observer.granted.action_types).toEqual([]);
    await b.close();
    await a.close();
  });
});
