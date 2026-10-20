import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActionRecord, AwpClient } from "@hyperduality/awp";
import { afterEach, describe, expect, it } from "vitest";
import type { InputRecord } from "../src/host.ts";
import { type RunningWorld, serveWorld } from "../src/index.ts";
import { inputChunkProblems } from "../src/input.ts";
import { type Applied, keyboard, narrowedInputSchema } from "./keyboard.ts";

const TOKEN = "input-test-token-0123456";
let world: RunningWorld | undefined;
const problems: string[] = [];

afterEach(async () => {
  await world?.close();
  world = undefined;
  expect(problems.filter((p) => p.includes("failed its sender form"))).toEqual([]);
  problems.length = 0;
});

async function start(def: ReturnType<typeof keyboard>, auditDir?: string) {
  world = await serveWorld(def, {
    port: 0,
    token: TOKEN,
    log: (l) => problems.push(l),
    ...(auditDir ? { auditDir } : {}),
  });
  return world;
}

async function open(w: RunningWorld, mode: "lockstep" | "streaming", opts: { quiet?: boolean } = {}) {
  const c = new AwpClient({
    url: w.url,
    token: TOKEN,
    agent: { name: "test", version: "0.0.0", vendor: "awp-demo" },
    consumesModalities: ["text/event+json"],
    ...(opts.quiet ? { heartbeat: "manual" as const, obsReport: false } : {}),
  });
  await c.initialize();
  await c.openSession(mode, { embodiment: "player", subscribe: ["keys"] });
  return c;
}

const chunk = (slots: Record<string, unknown>[]) => ({ slot_ms: 50, slots });
const hold = (keys: string[], n: number) => Array.from({ length: n }, () => ({ keys }));
const aborted = (rec: ActionRecord) =>
  (rec.history.at(-1)?.raw as { aborted_at_progress?: number } | undefined)?.aborted_at_progress;
const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("input_chunk declaration (AWP-GAM-001)", () => {
  it("accepts the normative schema narrowed the allowed ways", () => {
    expect(inputChunkProblems(keyboard("lockstep").manifest)).toEqual([]);
  });

  it("refuses to start on a declaration that departs from it", async () => {
    const added = narrowedInputSchema(50);
    added.params.properties.speed = { type: "number" };
    for (const def of [
      keyboard("lockstep", { schema: added }),
      keyboard("lockstep", { schema: narrowedInputSchema(50, ["KeyW", "NotAKey"]) }),
      keyboard("lockstep", { duration: "instant" }),
      keyboard("lockstep", { schema: narrowedInputSchema(33) }),
    ])
      await expect(start(def)).rejects.toThrow(/input_chunk/);
  });
});

describe("input_chunk in lockstep", () => {
  it("executes each slot as the device state held for one advance (AWP-GAM-002)", async () => {
    const applied: Applied[] = [];
    const w = await start(keyboard("lockstep", { applied }));
    const c = await open(w, "lockstep");
    const rec = await c.submit(
      "input_chunk",
      chunk([{ keys: ["KeyW"] }, { keys: ["KeyW", "ShiftLeft"], mouse_dx: 30 }, {}]),
    );
    expect(rec.state).toBe("accepted");
    applied.length = 0;
    await c.advance(1);
    expect(applied.at(-1)?.state).toMatchObject({ held: ["KeyW"], pressed: ["KeyW"], released: [], mouse_dx: 0 });
    expect(rec.progress).toBeCloseTo(1 / 3, 2);
    await c.advance(1);
    // A key listed in consecutive slots stays down with no new press.
    expect(applied.at(-1)?.state).toMatchObject({
      held: ["KeyW", "ShiftLeft"],
      pressed: ["ShiftLeft"],
      released: [],
      mouse_dx: 30,
    });
    await c.advance(1);
    expect(applied.at(-1)?.state).toMatchObject({ held: [], pressed: [], released: ["KeyW", "ShiftLeft"] });
    expect(rec.state).toBe("completed");
    expect(applied).toHaveLength(3);
    await c.close();
  });

  it("keeps a held key down across a replacement and reports the replaced slots (AWP-GAM-003)", async () => {
    const applied: Applied[] = [];
    const w = await start(keyboard("lockstep", { applied }));
    const c = await open(w, "lockstep");
    const first = await c.submit("input_chunk", chunk(hold(["KeyW", "ShiftLeft"], 5)), { preempt: "replace" });
    await c.advance(2);
    const second = await c.submit("input_chunk", chunk([{ keys: ["ShiftLeft", "KeyD"] }, {}]), { preempt: "replace" });
    expect(first.state).toBe("executing");
    applied.length = 0;
    await c.advance(1);
    expect(first.state).toBe("preempted");
    expect(aborted(first)).toBe(0.4);
    expect(second.state).toBe("executing");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.state).toMatchObject({ held: ["ShiftLeft", "KeyD"], pressed: ["KeyD"], released: ["KeyW"] });
    await c.close();
  });

  it("releases everything when a chunk is cancelled, before the terminal status (AWP-GAM-004)", async () => {
    const applied: Applied[] = [];
    const w = await start(keyboard("lockstep", { applied }));
    const c = await open(w, "lockstep");
    const rec = await c.submit("input_chunk", chunk(hold(["KeyW"], 10)));
    await c.advance(2);
    await c.cancel(rec.action_id);
    applied.length = 0;
    await c.advance(1);
    expect(rec.state).toBe("cancelled");
    expect(aborted(rec)).toBe(0.2);
    // The release comes first in the advance that ends the chunk.
    expect(applied[0]?.state).toMatchObject({ held: [], released: ["KeyW"] });
    await c.close();
  });
});

describe("input_chunk in streaming", () => {
  it("starts at the first input update after admission and runs a slot per step (AWP-GAM-002)", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "awp-input-"));
    const w = await start(keyboard("streaming"), auditDir);
    const c = await open(w, "streaming");
    const rec = await c.submit("input_chunk", chunk([{ keys: ["KeyA"] }, { keys: ["KeyA"] }, { keys: ["KeyS"] }, {}]));
    expect(rec.state).toBe("accepted");
    await rec.settled();
    expect(rec.state).toBe("completed");
    await c.close();
    const file = readdirSync(auditDir).find((f) => f.endsWith("-input.jsonl"))!;
    const records = readFileSync(join(auditDir, file), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as InputRecord)
      .filter((r) => r.action_id === rec.action_id);
    expect(records.map((r) => r.slot)).toEqual([0, 1, 2, 3]);
    expect(records.map((r) => r.state.held)).toEqual([["KeyA"], ["KeyA"], ["KeyS"], []]);
    const gaps = records.slice(1).map((r, i) => (r.ts_mono_ns - records[i]!.ts_mono_ns) / 1e6);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(45);
  });

  it("replaces at the next slot boundary, keeping a held key down (AWP-GAM-003)", async () => {
    const applied: Applied[] = [];
    const w = await start(keyboard("streaming", { applied }));
    const c = await open(w, "streaming");
    const first = await c.submit("input_chunk", chunk(hold(["KeyW", "ShiftLeft"], 20)), { preempt: "replace" });
    await until(() => (first.progress ?? 0) > 0.1);
    const second = await c.submit("input_chunk", chunk(hold(["ShiftLeft"], 2)), { preempt: "replace" });
    // Admitted mid-slot; the running chunk runs on to the boundary.
    expect(second.state).toBe("accepted");
    await second.settled();
    expect(first.state).toBe("preempted");
    expect(aborted(first)).toBeGreaterThan(0);
    const states = applied.map((a) => a.state);
    const takeover = states.findIndex((s) => s.held.length === 1 && s.held[0] === "ShiftLeft");
    expect(states[takeover]).toMatchObject({ pressed: [], released: ["KeyW"] });
    // ShiftLeft is never released between the two chunks.
    expect(states.slice(0, takeover).every((s) => !s.released.includes("ShiftLeft"))).toBe(true);
    await c.close();
  });

  it("ends a cancelled chunk at the next slot boundary, where a close outranks the cancel (AWP-LIF-008)", async () => {
    const w = await start(keyboard("streaming"));
    const c = await open(w, "streaming");
    const rec = await c.submit("input_chunk", chunk(hold(["KeyW"], 20)));
    await until(() => rec.state === "executing");
    await Promise.all([c.cancel(rec.action_id), c.close()]);
    expect(rec.state).toBe("cancelled");
    expect(rec.reason).toBe("session_closed");
  });

  it("releases on cancel, on safe-state entry and on e-stop (AWP-GAM-004)", async () => {
    const applied: Applied[] = [];
    const w = await start(keyboard("streaming", { applied, watchdogMs: 300 }));
    const c = await open(w, "streaming");
    const lastHeld = () => applied.at(-1)?.state.held;

    const cancelled = await c.submit("input_chunk", chunk(hold(["KeyW"], 20)));
    await until(() => lastHeld()?.includes("KeyW") === true);
    await c.cancel(cancelled.action_id);
    await cancelled.settled();
    expect(cancelled.state).toBe("cancelled");
    expect(lastHeld()).toEqual([]);

    const stopped = await c.submit("input_chunk", chunk(hold(["KeyD"], 20)));
    await until(() => lastHeld()?.includes("KeyD") === true);
    await w.estop(true);
    await stopped.settled();
    expect(stopped.state).toBe("failed");
    expect(stopped.reason).toBe("e_stop");
    expect(applied.find((a) => a.state.released.includes("KeyD"))).toBeDefined();
    await w.estop(false);
    await c.close();

    // A quiet agent: the watchdog enters safe state and the chunk ends released.
    const quiet = await open(w, "streaming", { quiet: true });
    const left = await quiet.submit("input_chunk", chunk(hold(["KeyS"], 20)));
    await left.settled();
    expect(left.state).toBe("failed");
    expect(left.reason).toBe("connection_lost");
    expect(applied.find((a) => a.state.released.includes("KeyS"))).toBeDefined();
    expect(lastHeld()).toEqual([]);
    await quiet.close();
  });
});
