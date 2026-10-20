import { type RunningWorld, serveWorld } from "@awp-demo/world";
import { AwpClient } from "@hyperduality/awp";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { type Applied, keyboard } from "../../world/test/keyboard.ts";
import { ControlMux } from "../src/mux.ts";
import { createPolicyController } from "../src/policy.ts";

const TOKEN = "policy-test-token-00000";
let world: RunningWorld | undefined;
let mux: ControlMux | undefined;
let client: AwpClient | undefined;
let server: WebSocketServer | undefined;

afterEach(async () => {
  mux?.detach();
  await client?.close().catch(() => undefined);
  await world?.close();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  world = undefined;
  server = undefined;
});

const until = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A policy server that walks forward and turns a little each decision, and records what it was asked. */
async function fakePolicy() {
  const seen: { type: string; delay_ms?: number }[] = [];
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => server!.once("listening", r));
  server.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { type: string; id?: number; delay_ms?: number };
      seen.push(m);
      if (m.type === "act")
        ws.send(JSON.stringify({ type: "slots", id: m.id, slots: [{ keys: ["KeyW"], mouse_dx: 5 }] }));
      else ws.send(JSON.stringify({ type: m.type }));
    }),
  );
  const { port } = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${port}`, seen };
}

async function setup(mode: "lockstep" | "streaming", applied: Applied[], url: string) {
  world = await serveWorld(keyboard(mode, { applied }), { port: 0, token: TOKEN, log: () => {} });
  client = new AwpClient({
    url: world.url,
    token: TOKEN,
    agent: { name: "policy-test", version: "0", vendor: "awp-demo" },
    consumesModalities: ["text/event+json"],
  });
  await client.initialize();
  await client.openSession(mode, { embodiment: "player", subscribe: ["keys"] });
  const policy = createPolicyController({ description: "Walks forward", channel: "keys", slotMs: 50 });
  mux = new ControlMux([policy], { activity: () => {}, controllers: () => {}, changed: () => {} }, { rateHz: 0 });
  mux.configure("policy", { url });
  mux.attach(client);
  return client;
}

describe("policy controller", () => {
  it("in lockstep, decides on each frame and the world waits for it", async () => {
    const { url, seen } = await fakePolicy();
    const applied: Applied[] = [];
    const c = await setup("lockstep", applied, url);
    await until(() => seen.filter((m) => m.type === "act").length >= 5);
    expect(seen.find((m) => m.type !== "config")?.type).toBe("reset");
    await until(() => applied.some((a) => a.state.held.includes("KeyW")));
    // One decision per advance: time moves only when the policy waits.
    const acts = seen.filter((m) => m.type === "act").length;
    expect(Math.abs((c.tick ?? 0) - acts)).toBeLessThanOrEqual(2);
    expect(applied.find((a) => a.state.mouse_dx === 5)).toBeDefined();
  });

  it("in streaming, keeps keys down between decisions with a hold-over slot", async () => {
    const { url, seen } = await fakePolicy();
    const applied: Applied[] = [];
    await setup("streaming", applied, url);
    await until(() => seen.filter((m) => m.type === "act").length >= 10);
    await until(() => applied.filter((a) => a.state.held.includes("KeyW")).length >= 10);
    const first = applied.findIndex((a) => a.state.held.includes("KeyW"));
    const later = applied.slice(first, first + 10);
    expect(later.every((a) => a.state.held.includes("KeyW"))).toBe(true);
    expect(later.slice(1).every((a) => a.state.pressed.length === 0)).toBe(true);
  });

  it("passes the operator's inference delay to the server", async () => {
    const { url, seen } = await fakePolicy();
    await setup("streaming", [], url);
    await until(() => seen.some((m) => m.type === "act"));
    mux!.configure("policy", { url, delayMs: 300 });
    await until(() => seen.some((m) => m.type === "config" && m.delay_ms === 300));
  });
});
