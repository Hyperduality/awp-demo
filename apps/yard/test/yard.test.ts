import type { LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { ControlMux } from "@awp-demo/agent";
import { type ActivityEntry, type ServerMessage, WorldTopic } from "@awp-demo/inspector";
import { type RunningWorld, serveWorld } from "@awp-demo/world";
import { AwpClient, AwpError, jsonPayload } from "@hyperduality/awp";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { yardLlm } from "../src/agent/controllers/llm.ts";
import { manual } from "../src/agent/controllers/manual.ts";
import { readYard, renderYard } from "../src/agent/controllers/observe.ts";
import {
  CAMERA,
  EMBODIMENT,
  type Proprio,
  type Scene,
  type SensorsView,
  type TaskObs,
  type YardLayout,
  type YardView,
} from "../src/shared/yard.ts";
import { yard } from "../src/world/definition.ts";
import { manifest } from "../src/world/manifest.ts";
import type { YardSim } from "../src/world/sim.ts";

const TOKEN = "yard-test-token-00000000";
let world: RunningWorld | undefined;
const problems: string[] = [];

afterEach(async () => {
  await world?.close();
  world = undefined;
  expect(problems.filter((p) => p.includes("failed its sender form"))).toEqual([]);
  problems.length = 0;
});

async function connect(initialState: "default" | "empty" = "empty") {
  world = await serveWorld(yard, { port: 0, token: TOKEN, log: (l) => problems.push(l) });
  const c = new AwpClient({
    url: world.url,
    token: TOKEN,
    agent: { name: "test", version: "0.0.0", vendor: "awp-demo" },
    consumesModalities: ["text/event+json", "proprio/json", "image/raw", "pointcloud/xyz32"],
  });
  await c.initialize();
  await c.openSession("streaming", {
    embodiment: EMBODIMENT,
    subscribe: manifest.observation_channels.map((ch) => ch.id),
    admin: ["reset"],
  });
  if (initialState !== "default") await c.reset({ initialState });
  return c;
}

const proprio = (c: AwpClient) => jsonPayload<Proprio>(c.latest("proprio")!.frame);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setpoint = (c: AwpClient, s: object) => c.sendCommandFrame("drive", new TextEncoder().encode(JSON.stringify(s)));

describe("the yard world", () => {
  it("declares its command channel and frames as the spec asks", () => {
    // AWP-CMD-002: a type that names a command channel is a streaming one, and the channel is declared.
    const teleop = manifest.action_schemas.find((a) => a.type === "teleop")!;
    expect(teleop.duration).toBe("streaming");
    expect(manifest.command_channels?.map((ch) => ch.id)).toContain(teleop.command_channel);
    expect(teleop.watchdog_ms).toBeGreaterThan(0);
    expect(manifest.capabilities?.command_channels).toBe(true);
    // AWP-UNI-004: the dynamic frames are the ones awp.tf publishes.
    const dynamic = yard.frameTree!.frames.filter((f) => f.dynamic).map((f) => f.id);
    expect(dynamic).toEqual(["base", "forks"]);
    for (const e of manifest.embodiments)
      for (const ch of e.channels) expect(manifest.observation_channels.map((x) => x.id)).toContain(ch);
  });

  it("streams proprio, the scene, transforms and the binary sensor frames", async () => {
    const c = await connect("default");
    await Promise.all(["proprio", "scene", "task", "awp.tf", "depth", "rgb", "lidar"].map((ch) => c.freshFrame(ch)));
    expect(proprio(c).pose.frame).toBe("world");
    expect(proprio(c).carrying).toBeNull();
    const scene = jsonPayload<Scene>(c.latest("scene")!.frame);
    // From where it is parked, the sensors pick out one pallet; the bays come with the site map.
    expect(scene.entities.filter((e) => e.id.startsWith("pallet_")).map((e) => e.id)).toEqual(["pallet_7"]);
    expect(scene.entities.filter((e) => e.class === "bay" && e.state?.source === "site_map")).toHaveLength(6);
    expect(scene.entities.find((e) => e.id === EMBODIMENT)?.class).toBe("forklift");
    const tf = jsonPayload<{ transforms: { frame: string; parent: string }[] }>(c.latest("awp.tf")!.frame);
    expect(tf.transforms.map((t) => `${t.parent}>${t.frame}`)).toEqual(["world>base", "base>forks"]);
    expect(c.latest("depth")!.frame.payload.byteLength).toBe(CAMERA.width * CAMERA.height * 4);
    expect(c.latest("rgb")!.frame.payload.byteLength).toBe(CAMERA.width * CAMERA.height * 3);
    expect(c.latest("lidar")!.frame.payload.byteLength % 12).toBe(0);
    expect(jsonPayload<TaskObs>(c.latest("task")!.frame).orders).toHaveLength(3);
    await c.close();
  });

  it("drives by setpoints on the command channel, and counts the ones it refused", async () => {
    const c = await connect();
    await c.freshFrame("proprio");
    const y0 = proprio(c).pose.p_m[1];
    const teleop = await c.submit("teleop", {});
    await teleop.until((r) => r.state === "executing");
    // The truck starts facing north: forward is +y.
    for (let i = 0; i < 45; i++) {
      await setpoint(c, { v_mps: 1.5, steer_rad: 0 });
      await sleep(33);
    }
    expect(proprio(c).v_mps).toBeGreaterThan(1);
    expect(proprio(c).pose.p_m[1]).toBeGreaterThan(y0 + 0.8);
    // AWP-CMD-006: a setpoint past the envelope is dropped, and the status says how many were.
    for (let i = 0; i < 10; i++) {
      await setpoint(c, { v_mps: 9, steer_rad: 0 });
      await sleep(33);
    }
    await sleep(1100);
    expect(proprio(c).v_mps).toBeLessThanOrEqual(3.05);
    const last = teleop.history.at(-1)?.raw as
      | { stream?: { frames_applied: number; clamped_count: number } }
      | undefined;
    const stream = last?.stream;
    expect(stream?.clamped_count).toBeGreaterThanOrEqual(1);
    expect(stream?.frames_applied).toBeGreaterThan(20);
    // AWP-CMD-005: with the setpoints gone, the watchdog stops the truck and fails the action.
    await teleop.settled();
    expect(teleop.state).toBe("failed");
    expect(teleop.reason).toBe("watchdog");
    await sleep(2000);
    expect(Math.abs(proprio(c).v_mps)).toBeLessThan(0.1);
    await c.close();
  }, 20_000);

  it("refuses a drive outside the yard, and replaces a drive with a stop", async () => {
    const c = await connect();
    await c.freshFrame("proprio");
    await expect(c.submit("drive_to", { x_m: 60, y_m: 0 })).rejects.toBeInstanceOf(AwpError);
    const drive = await c.submit("drive_to", { x_m: -15, y_m: 0 });
    await drive.until((r) => r.state === "executing");
    await sleep(2000);
    expect(Math.abs(proprio(c).v_mps)).toBeGreaterThan(0.3);
    const stop = await c.submit("stop", {}, { preempt: "replace" });
    await stop.settled();
    await drive.settled();
    expect(drive.state).toBe("preempted");
    await sleep(2500);
    expect(Math.abs(proprio(c).v_mps)).toBeLessThan(0.1);
    await c.close();
  }, 20_000);
});

describe("the yard's inspector topics", () => {
  it("publish poses for the layout they belong to, the sensor frames, and a new layout after a reset", async () => {
    world = await serveWorld(yard, {
      port: 0,
      token: TOKEN,
      inspectorPort: 0,
      viewHz: 60,
      topics: [{ name: "sensors", hz: 5, read: (sim) => (sim as YardSim).sensorsView() }],
      log: (l) => problems.push(l),
    });
    // The UI's end of the inspector, reduced to what it keeps: the latest value on each state topic.
    const topics = new Map<string, unknown>();
    const socket = new WebSocket(`ws://127.0.0.1:${world.inspector?.port}`);
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.t === "snap" || m.t === "ev") topics.set(m.topic, m.data);
    });
    const ui = { get: <T>(topic: string) => topics.get(topic) as T | undefined, close: () => socket.close() };
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await sleep(30);
      expect(ok()).toBe(true);
    };
    await until(() => ui.get(WorldTopic.layout) !== undefined && ui.get("sensors") !== undefined);
    const layout = ui.get<YardLayout>(WorldTopic.layout)!;
    const view = ui.get<YardView>(WorldTopic.view)!;
    expect(view.key).toBe(layout.key);
    // Seven float32 per body, base64: four characters for every three bytes.
    expect(view.poses.length).toBe(Math.ceil((layout.bodies.length * 7 * 4) / 3) * 4);
    expect(layout.bodies.filter((b) => b.id.startsWith(`${EMBODIMENT}.wheel_`))).toHaveLength(4);
    expect(layout.bays.map((b) => b.id)).toContain("trailer_2");
    const sensors = ui.get<SensorsView>("sensors")!;
    expect((sensors.depth.length * 3) / 4).toBeGreaterThanOrEqual(CAMERA.width * CAMERA.height * 4);
    expect(sensors.seen).toContain("pallet_7");

    // A session's reset makes a new sim: its layout goes out before the poses that belong to it are drawn.
    const c = new AwpClient({
      url: world.url,
      token: TOKEN,
      agent: { name: "test", version: "0.0.0", vendor: "awp-demo" },
      consumesModalities: ["proprio/json"],
    });
    await c.initialize();
    await c.openSession("streaming", { embodiment: EMBODIMENT, subscribe: ["proprio"], admin: ["reset"] });
    await c.reset({ initialState: "empty" });
    await until(() => ui.get<YardLayout>(WorldTopic.layout)?.key !== layout.key);
    const empty = ui.get<YardLayout>(WorldTopic.layout)!;
    expect(empty.key).toMatch(/^empty:/);
    expect(empty.bodies.length).toBeLessThan(layout.bodies.length);
    await until(() => ui.get<YardView>(WorldTopic.view)?.key === empty.key);
    await c.close();
    ui.close();
  });
});

describe("the yard controllers", () => {
  it("render the yard for a model from observations alone", async () => {
    const c = await connect("default");
    const mux = new ControlMux([], { activity: () => {}, controllers: () => {}, changed: () => {} }, { rateHz: 0 });
    mux.attach(c);
    await Promise.all(["proprio", "scene", "task"].map((ch) => c.freshFrame(ch)));
    const latest = <T>(ch: string) => jsonPayload<T>(c.latest(ch)!.frame);
    const text = renderYard(readYard({ latest, onFrame: () => () => {} } as never)!);
    expect(text).toMatch(/Truck at \(9\.0, -12\.5\) heading north/);
    // What it has not seen, it says it has not seen; nothing tells it where those pallets are.
    expect(text).toMatch(/pallet_\d \(Pallet \d \(.+\)\) to (bay_[abc]|trailer_\d) \(.+\): waiting; not seen yet/);
    expect(text).not.toMatch(/pallet_[1-6][^\n]*at \(-12/);
    expect(text).toMatch(
      /In view of the sensors now:\n(- .+\n)*- pallet_7 \(Pallet 7 \(.+\)\), a pallet, at \(5\.0, 3\.0\)/,
    );
    expect(text).toMatch(/trailer_2 \(Trailer slot 2\), a bay at \(15\.0, 8\.7\), surface 1\.25 m up/);
    expect(text).toMatch(/receiving_pad \(Receiving pad\), a zone at \(-12\.6, 0\.0\)/);
    expect(text).toMatch(/container_1, a container, at/);
    mux.detach();
    await c.close();
  });

  it("let a person drive: input becomes a teleop action and a stream of setpoints", async () => {
    const c = await connect();
    const activity: ActivityEntry[] = [];
    const mux = new ControlMux(
      [manual],
      { activity: (e) => activity.push(e), controllers: () => {}, changed: () => {} },
      { rateHz: 0 },
    );
    mux.attach(c);
    await c.freshFrame("proprio");
    mux.input("manual", { throttle: 1, steer: 0, lift: 1, tilt: 0 });
    await sleep(2500);
    expect(proprio(c).v_mps).toBeGreaterThan(1);
    expect(proprio(c).fork_height_m).toBeGreaterThan(0.3);
    expect(activity.some((a) => a.kind === "action" && a.title.includes("teleop"))).toBe(true);
    mux.input("manual", { throttle: 0, steer: 0, lift: 0, tilt: 0 });
    await sleep(2500);
    expect(Math.abs(proprio(c).v_mps)).toBeLessThan(0.1);
    await c.close();
  }, 20_000);
});

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

describe("the yard's language model", () => {
  it("is shown what the sensors know, acts, and is woken when its own action ends", async () => {
    const c = await connect("default");
    let n = 0;
    const replies = [call("drive_to", { x_m: 9, y_m: -10.5 }), say("Driving north a little."), say("There now.")];
    const model = new MockLanguageModelV4({ doStream: async () => (replies[n++] ?? say("Nothing more."))() });
    const prompt = (i: number) => JSON.stringify(model.doStreamCalls[i]?.prompt ?? "");
    const mux = new ControlMux(
      [yardLlm({ model: () => model })],
      { activity: () => {}, controllers: () => {}, changed: () => {} },
      { rateHz: 0, handoff: "inherit" },
    );
    mux.attach(c);
    await Promise.all(["proprio", "scene", "task"].map((ch) => c.freshFrame(ch)));
    mux.message("llm", "");
    const until = async (ok: () => boolean, ms: number) => {
      for (let t = 0; t < ms && !ok(); t += 50) await sleep(50);
      expect(ok()).toBe(true);
    };
    await until(() => model.doStreamCalls.length >= 2, 5000);
    expect(prompt(0)).toContain("Find the ordered pallets and deliver them.");
    expect(prompt(0)).toContain("not seen yet");
    expect(prompt(0)).toContain("pallet_7");
    expect(prompt(0)).not.toMatch(/pallet_1[^"]{0,80}-12\.0/);
    // The tool came back on admission, with the truck only just setting off.
    expect(prompt(1)).toMatch(/drive_to: (accepted|executing)/);
    // Nothing else happens in the yard: the third call is the model being woken by its own drive ending.
    await until(() => model.doStreamCalls.length >= 3, 12000);
    expect(prompt(2)).toMatch(/you: drive_to .*completed/);
    expect(Math.abs(proprio(c).pose.p_m[1] + 10.5)).toBeLessThan(0.3);
    mux.detach();
    await c.close();
  }, 30_000);
});
