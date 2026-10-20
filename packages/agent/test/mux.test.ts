import type { ActivityEntry } from "@awp-demo/inspector";
import { type RunningWorld, serveWorld } from "@awp-demo/world";
import { AwpClient } from "@hyperduality/awp";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { gridworld } from "../../world/test/gridworld.ts";
import type { ControlContext, Controller } from "../src/controller.ts";
import { ControlMux } from "../src/mux.ts";

const TOKEN = "mux-test-token-000000";
let world: RunningWorld | undefined;
let mux: ControlMux | undefined;
let client: AwpClient | undefined;

afterEach(async () => {
  mux?.detach();
  await client?.close().catch(() => undefined);
  await world?.close();
  world = undefined;
});

async function setup(
  mode: "lockstep" | "streaming",
  controllers: Controller<any>[],
  opts: { handoff?: "cancel" | "inherit"; heartbeat?: "intent"; camera?: boolean } = {},
) {
  world = await serveWorld(gridworld(mode, { camera: opts.camera }), { port: 0, token: TOKEN, log: () => {} });
  client = new AwpClient({
    url: world.url,
    token: TOKEN,
    agent: { name: "mux-test", version: "0", vendor: "awp-demo" },
    consumesModalities: opts.camera ? ["text/event+json", "image/jpeg"] : ["text/event+json"],
    ...(opts.heartbeat === "intent" ? { heartbeat: "manual" as const, obsReport: false } : {}),
  });
  await client.initialize();
  await client.openSession(mode, {
    embodiment: "avatar_0",
    subscribe: opts.camera ? ["grid_view", "camera"] : ["grid_view"],
  });
  const activity: ActivityEntry[] = [];
  mux = new ControlMux(
    controllers,
    { activity: (e) => activity.push(e), controllers: () => {}, changed: () => {} },
    { rateHz: 0, ...(opts.handoff ? { handoff: opts.handoff } : {}) },
  );
  mux.attach(client);
  return { activity, mux, client, world };
}

const until = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Walks back and forth between two cells for as long as it holds control. */
function program(): Controller<{}> {
  return {
    id: "program",
    kind: "program",
    label: "Program",
    description: "Paces",
    config: z.object({}),
    create(ctx) {
      ctx.engage();
      void (async () => {
        let east = true;
        while (!ctx.signal.aborted) {
          try {
            const rec = await ctx.submit("walk_to", { cell: [east ? 60 : 0, 0] }, { preempt: "replace" });
            await ctx.settle(rec);
            east = !east;
          } catch {
            await ctx.wait({ ticks: 1 });
          }
        }
      })();
      return {};
    },
  };
}

let manualCtx: ControlContext<{}> | undefined;
function manual(): Controller<{}> {
  return {
    id: "manual",
    kind: "manual",
    label: "Manual",
    description: "Keys",
    config: z.object({}),
    create(ctx) {
      manualCtx = ctx;
      return {
        input: (dir) => {
          ctx.engage();
          void ctx.submit("move", { direction: dir }, { preempt: "replace" }).then((r) => ctx.settle(r));
        },
      };
    },
  };
}

describe("control mux", () => {
  it("hands control to a higher priority, cancels the old holder's action, and hands back", async () => {
    const { activity, mux } = await setup("lockstep", [program(), manual()]);
    await until(() => mux.authority === "program");
    await until(() => activity.some((e) => e.kind === "action" && e.state === "executing"));
    mux.input("manual", "north");
    await until(() => mux.authority === "manual");
    await until(() => activity.some((e) => e.source === "program" && e.kind === "action" && e.state === "cancelled"));
    await until(() => activity.some((e) => e.source === "manual" && e.kind === "action" && e.state === "completed"));
    expect(activity.find((e) => e.kind === "handoff" && e.title === "Manual took control from Program")).toBeDefined();
    manualCtx!.release();
    await until(() => mux.authority === "program");
    expect(activity.some((e) => e.kind === "handoff" && e.title === "Program took control from Manual")).toBe(true);
  });

  it("gives controllers a binary channel as its bytes", async () => {
    let ctxRef: ControlContext<{}> | undefined;
    const watcher: Controller<{}> = {
      id: "program",
      kind: "program",
      label: "Watcher",
      description: "Reads the camera",
      config: z.object({}),
      create(ctx) {
        ctxRef = ctx;
        return {};
      },
    };
    await setup("lockstep", [watcher], { camera: true });
    await until(() => ctxRef?.latest("camera") !== undefined);
    expect(ctxRef!.latest("camera")).toBeInstanceOf(Uint8Array);
    expect([...ctxRef!.latest<Uint8Array>("camera")!]).toEqual([0, 0]);
    expect(ctxRef!.latest("grid_view")).toEqual({ avatar: [0, 0], goal: [2, 0] });
  });

  it("refuses submissions from a controller that is not engaged", async () => {
    await setup("lockstep", [program(), manual()]);
    await until(() => mux!.authority === "program");
    await expect(manualCtx!.submit("move", { direction: "north" })).rejects.toThrow(/does not hold control/);
  });

  it("freezes lockstep time while an on-wait controller thinks", async () => {
    let ctxRef: ControlContext<{}> | undefined;
    const thinker: Controller<{}> = {
      id: "llm",
      kind: "llm",
      label: "LLM",
      description: "Thinks",
      config: z.object({}),
      create(ctx) {
        ctxRef = ctx;
        ctx.engage();
        return {};
      },
    };
    const { client } = await setup("lockstep", [thinker]);
    await until(() => ctxRef?.hasAuthority === true);
    const t0 = client.tick;
    await new Promise((r) => setTimeout(r, 150));
    expect(client.tick).toBe(t0);
    const rec = await ctxRef!.submit("walk_to", { cell: [3, 0] });
    await ctxRef!.settle(rec);
    expect(rec.state).toBe("completed");
    expect(client.tick).toBeGreaterThan(t0!);
    const after = client.tick;
    await new Promise((r) => setTimeout(r, 150));
    expect(client.tick).toBe(after);
  });
});

/** Drives with an intent heartbeat: alive while `beating` says so. */
function walker(beating: () => boolean): Controller<{}> {
  return {
    id: "llm",
    kind: "llm",
    label: "Walker",
    description: "Walks far",
    config: z.object({}),
    liveness: "intent",
    create(ctx) {
      ctx.engage();
      const timer = setInterval(() => beating() && ctx.alive(), 100);
      void (async () => {
        await ctx.acquire();
        while (!ctx.frame("grid_view")) await ctx.nextObservation();
        await ctx.submit("walk_to", { cell: [400, 0] }, { basis: ctx.frame("grid_view") });
      })();
      return { stop: () => clearInterval(timer) };
    },
  };
}

describe("control mux in streaming", () => {
  it("leaves the previous holder's actions running when set to inherit", async () => {
    let held: ControlContext<{}> | undefined;
    const desk: Controller<{}> = {
      id: "manual",
      kind: "manual",
      label: "Manual",
      description: "Takes the desk",
      config: z.object({}),
      create(ctx) {
        held = ctx;
        return { input: () => ctx.engage() };
      },
    };
    const { activity, mux } = await setup("streaming", [program(), desk], { handoff: "inherit" });
    await until(() => activity.some((e) => e.source === "program" && e.kind === "action" && e.state === "executing"));
    mux.input("manual", null);
    await until(() => mux.authority === "manual");
    await new Promise((r) => setTimeout(r, 200));
    const program_ = activity.filter((e) => e.source === "program" && e.kind === "action");
    expect(program_.at(-1)?.state).toBe("executing");
    expect(activity.some((e) => e.source === "program" && e.state === "cancelled")).toBe(false);
    held!.release();
    await until(() => mux.authority === "program");
  });

  it("names the basis of a submission and reports its age", async () => {
    const { activity } = await setup("streaming", [walker(() => true)], { heartbeat: "intent" });
    await until(() => activity.some((e) => e.kind === "action" && e.state === "executing"));
    const entry = activity.find((e) => e.kind === "action" && e.state === "submitted")!;
    const age = (entry.data as { basisAgeMs?: number }).basisAgeMs;
    expect(typeof age).toBe("number");
    expect(age).toBeLessThan(1000);
  });

  it("stops the heartbeat when an intent controller stops showing life (AWP-SAF-005)", async () => {
    let beating = true;
    const { client } = await setup("streaming", [walker(() => beating)], { heartbeat: "intent" });
    const events: string[] = [];
    client.on("event", (e: { event: string }) => events.push(e.event));
    await new Promise((r) => setTimeout(r, 1600));
    expect(events).not.toContain("safe_state_entered");
    beating = false;
    await until(() => events.includes("safe_state_entered"), 3000);
  });
});
