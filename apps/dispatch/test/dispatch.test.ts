import type { LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { type Controller, ControlMux } from "@awp-demo/agent";
import type { ActivityEntry } from "@awp-demo/inspector";
import { type ActionRun, type RunningWorld, type RunStatus, serveWorld, type WorldDefinition } from "@awp-demo/world";
import { AwpClient } from "@hyperduality/awp";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchLlm } from "../src/agent/controllers/llm.ts";
import { program } from "../src/agent/controllers/program.ts";
import type { CallsPayload, DispatchView, Kind, ShiftPayload } from "../src/shared/city.ts";
import { KINDS, UNITS } from "../src/shared/city.ts";
import { dispatch } from "../src/world/definition.ts";
import { DispatchSim } from "../src/world/sim.ts";

const TOKEN = "dispatch-test-token-00";

/** Drives runs and the sim together, `dt` ms at a time, until `done` or `limitS` shift seconds pass. */
function play(sim: DispatchSim, runs: ActionRun[], done: () => boolean, limitS = 300, dt = 100) {
  const ends = new Map<ActionRun, RunStatus>();
  let t = 0;
  while (!done() && t < limitS) {
    for (const run of runs) {
      if (ends.has(run)) continue;
      const s = run.update(dt);
      if ("done" in s || "failed" in s) ends.set(run, s);
    }
    sim.step(dt);
    t += dt / 1000;
  }
  return { ends, t };
}

const calls = (sim: DispatchSim) => sim.observe("calls") as CallsPayload;
const shift = (sim: DispatchSim) => sim.observe("shift") as ShiftPayload;
const unitOf = (kind: Kind, skip = 0) => UNITS.filter((u) => u.kind === kind)[skip]!.id;

/** A started shift whose first call is on the board. */
function firstCall(seed = 3) {
  const sim = new DispatchSim(seed, "default");
  sim.operator("start", undefined);
  play(sim, [], () => calls(sim).open.length > 0);
  const view = sim.view() as DispatchView;
  return { sim, call: view.calls[0]! };
}

describe("dispatch sim", () => {
  it("routes around the river by the bridges", () => {
    const sim = new DispatchSim(1, "default");
    // G2 to F6 is five blocks as the crow flies, seven by road over the bridge on E or H.
    const run = sim.start("medic_1", "stage", { at: "F6" }, { actionId: "a" });
    const { ends, t } = play(sim, [run], () => false, 20, 50);
    expect(ends.get(run)).toEqual({ done: true });
    const arrived = (sim.view() as DispatchView).units.find((u) => u.id === "medic_1")!;
    expect([arrived.x, arrived.y]).toEqual([5, 5]);
    expect(Math.abs(t - 20)).toBeLessThan(0.1);
    const fresh = new DispatchSim(1, "default");
    const timed = fresh.start("medic_1", "stage", { at: "F6" }, { actionId: "b" });
    let elapsed = 0;
    while (!("done" in timed.update(50))) elapsed += 0.05;
    expect(elapsed).toBeCloseTo(7 / 1.1, 1);
  });

  it("brings the same calls for the same seed", () => {
    const a = new DispatchSim(5, "rush");
    const b = new DispatchSim(5, "rush");
    for (const sim of [a, b]) {
      sim.operator("start", undefined);
      play(sim, [], () => false, 60);
    }
    const summary = (sim: DispatchSim) => calls(sim).open.map((c) => `${c.id} ${c.at} ${c.text}`);
    expect(summary(a).length).toBeGreaterThan(2);
    expect(summary(a)).toEqual(summary(b));
  });

  it("refuses a dispatch to a call that is not open", () => {
    const { sim } = firstCall();
    expect(sim.admit("engine_1", "dispatch", { call: 99 })).toMatchObject({ error: "AWP_PARAMS_INVALID" });
    expect(sim.admit("engine_1", "dispatch", { call: 1 })).toEqual({ ok: true });
  });

  it("resolves a call once every kind it needs has worked the scene, and says when a unit is not needed", () => {
    let found: ReturnType<typeof firstCall> | undefined;
    for (let seed = 1; seed < 50 && !found; seed++) {
      const f = firstCall(seed);
      if (KINDS.some((k) => !f.call.needs[k])) found = f;
    }
    const { sim, call } = found!;
    const spare = KINDS.find((k) => !call.needs[k])!;
    const wasted = sim.start(unitOf(spare), "dispatch", { call: call.id }, { actionId: "spare" });
    play(sim, [wasted], () => false, 15);
    const updates = calls(sim).open.find((c) => c.id === call.id)!.updates;
    expect(updates.some((u) => u.includes("needed here"))).toBe(true);
    expect(updates.some((u) => u.includes("too"))).toBe(true);

    const runs = KINDS.flatMap((k) =>
      Array.from({ length: call.needs[k] ?? 0 }, (_, i) =>
        sim.start(unitOf(k, i), "dispatch", { call: call.id }, { actionId: `${k}${i}` }),
      ),
    );
    const { ends } = play(sim, runs, () => shift(sim).resolved > 0);
    expect([...ends.values()].every((s) => "done" in s)).toBe(true);
    expect(shift(sim).resolved).toBe(1);
    expect(calls(sim).closed[0]).toMatchObject({ id: call.id, outcome: "resolved" });
    expect(calls(sim).closed[0]!.points).toBeGreaterThan(0);
  });

  it("escalates a call nobody answers, then loses it", () => {
    const { sim, call } = firstCall();
    play(sim, [], () => calls(sim).open.find((c) => c.id === call.id)!.updates.length > 0);
    expect(calls(sim).open.find((c) => c.id === call.id)!.updates.length).toBe(1);
    play(sim, [], () => calls(sim).closed.some((c) => c.id === call.id));
    const lost = calls(sim).closed.find((c) => c.id === call.id)!;
    expect(lost.outcome).toBe("lost");
    expect(lost.points).toBeLessThan(0);
    expect(lost.note).toMatch(/^lost after \d+ s: no /);
  });

  it("fails a unit on its way to a call that closes first", () => {
    const { sim, call } = firstCall();
    const far = UNITS.map((u) => u.id).sort(
      (a, b) => calls(sim).open[0]!.eta_s[b]! - calls(sim).open[0]!.eta_s[a]!,
    )[0]!;
    const run = sim.start(far, "dispatch", { call: call.id }, { actionId: "late" });
    // Losing the call takes its whole window; slow the unit down by never driving it.
    play(sim, [], () => calls(sim).closed.some((c) => c.id === call.id));
    const s = run.update(100);
    expect(s).toMatchObject({ failed: "world_error" });
  });
});

// ---------------------------------------------------------------------------------------------

let world: RunningWorld | undefined;
let client: AwpClient | undefined;
let mux: ControlMux | undefined;
afterEach(async () => {
  mux?.detach();
  mux = undefined;
  await client?.close().catch(() => undefined);
  client = undefined;
  await world?.close();
  world = undefined;
});

async function desk(
  controllers: Controller<any>[],
  def: WorldDefinition<DispatchView> = dispatch,
  opts: { speed?: number; start?: boolean } = {},
) {
  world = await serveWorld(def, { port: 0, token: TOKEN, log: () => {} });
  client = new AwpClient({
    url: world.url,
    token: TOKEN,
    agent: { name: "t", version: "0", vendor: "t" },
    consumesModalities: ["text/event+json"],
    heartbeat: "manual",
    obsReport: false,
  });
  await client.initialize();
  await client.openSession("streaming", {
    embodiments: UNITS.map((u) => u.id),
    subscribe: ["units", "calls", "shift"],
  });
  await client.waitForFrame("calls");
  const activity: ActivityEntry[] = [];
  const events: string[] = [];
  client.on("event", (e: { event: string }) => events.push(e.event));
  mux = new ControlMux(
    controllers,
    {
      activity: (e) => {
        const i = activity.findIndex((a) => a.id === e.id);
        if (i >= 0) activity[i] = e;
        else activity.push(e);
      },
      controllers: () => {},
      changed: () => {},
    },
    { handoff: "inherit" },
  );
  mux.attach(client);
  world.host.sim.operator?.("speed", { speed: opts.speed ?? 3 });
  if (opts.start !== false) world.host.sim.operator?.("start", undefined);
  const until = async (cond: () => boolean, what: string, ms = 15000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { activity, events, until, mux, world };
}

describe("rules dispatcher", () => {
  it("answers calls from its own observations and resolves some", async () => {
    const t = await desk([{ ...program, enabled: true } as Controller<any>]);
    const view = () => world!.host.sim.view() as DispatchView;
    await t.until(() => view().shift.resolved >= 2, "two calls resolved", 30000);
    expect(t.activity.some((e) => e.kind === "decision")).toBe(true);
    expect(t.activity.some((e) => e.kind === "action" && e.state === "completed")).toBe(true);
  }, 40000);
});

// ---------------------------------------------------------------------------------------------

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const say = (text: string) => (): LanguageModelV4StreamResult => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  ]),
});
const call = (name: string, input: unknown) => (): LanguageModelV4StreamResult => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: `${name}-${Math.random()}`, toolName: name, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
  ]),
});

function scripted(replies: (() => LanguageModelV4StreamResult)[]) {
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => (replies[n++] ?? say("Nothing to do."))(),
  });
  const prompt = (i: number) => JSON.stringify(model.doStreamCalls[i]?.prompt ?? "");
  return { model, prompt };
}

/** The dispatch world with its safety bounds swapped for ones a test can wait out. */
function bounded(safety: { max_basis_age_ms?: number; watchdog_ms?: number }): WorldDefinition<DispatchView> {
  const policy = dispatch.manifest.safety_policy;
  return {
    ...dispatch,
    manifest: {
      ...dispatch.manifest,
      safety_policy: {
        ...policy,
        ...(safety.max_basis_age_ms !== undefined ? { max_basis_age_ms: safety.max_basis_age_ms } : {}),
        ...(safety.watchdog_ms !== undefined
          ? { safe_state: { behavior: "hold", watchdog_ms: safety.watchdog_ms } }
          : {}),
      },
    },
  };
}

describe("llm supervisor", () => {
  it("wakes on a new call, dispatches, and thinks on while the unit drives", async () => {
    const { model, prompt } = scripted([
      say("Waiting for calls."),
      call("dispatch", { embodiment: "police_1", call: 1 }),
      say("Police on the way."),
    ]);
    const t = await desk([dispatchLlm({ model: () => model })], dispatch, { speed: 1 });
    t.mux.message("llm", "");
    await t.until(() => model.doStreamCalls.length >= 3, "three model calls");
    expect(prompt(0)).toContain("You are on duty at the dispatch desk.");
    expect(prompt(1)).toContain("New call #1");
    // The tool came back on admission, so the model's next call saw the unit still on its way.
    expect(prompt(2)).toMatch(/dispatch police_1: (accepted|executing)/);
    expect(prompt(2)).toContain("police_1 (police car)");
    const action = t.activity.find((e) => e.kind === "action" && e.source === "llm")!;
    expect(action.state).not.toBe("completed");
    expect((action.data as { basisAgeMs?: number }).basisAgeMs).toBeLessThan(2000);
  }, 20000);

  it("hears when the world refuses a decision that took too long (AWP-SAF-013)", async () => {
    const { model, prompt } = scripted([call("stage", { embodiment: "engine_1", at: "C3" }), say("Noted.")]);
    const t = await desk(
      [dispatchLlm({ model: () => model, delay: () => ({ thinkingMs: 700 }) })],
      bounded({ max_basis_age_ms: 400 }),
      { start: false },
    );
    t.mux.message("llm", "Stage engine_1 at C3.");
    await t.until(() => model.doStreamCalls.length >= 2, "second model call");
    expect(prompt(1)).toContain("AWP_STALE_INTENT");
    const refused = t.activity.find((e) => e.kind === "action" && e.state === "rejected")!;
    expect((refused.data as { basisAgeMs: number }).basisAgeMs).toBeGreaterThan(400);
  }, 20000);

  it("lets the world stop the units when the model goes quiet (AWP-SAF-005)", async () => {
    const { model } = scripted([call("stage", { embodiment: "medic_1", at: "A7" }), say("On it.")]);
    const t = await desk([dispatchLlm({ model: () => model })], bounded({ watchdog_ms: 1500 }), { start: false });
    t.mux.configure("llm", { stallS: 3 });
    t.mux.message("llm", "Stage medic_1 at A7.");
    await t.until(() => t.events.includes("safe_state_entered"), "safe state", 8000);
    expect(model.doStreamCalls.length).toBe(0);
  }, 20000);
});
