/** Runs one agent process: a session on the world, a control mux, and an inspector for the UI. */
import {
  type ActivityEntry,
  AgentCommand,
  type AgentStatus,
  AgentTopic,
  type ControllerState,
} from "@awp-demo/inspector";
import { createInspectorServer } from "@awp-demo/inspector/server";
import { AwpClient, type OpenOptions, type TimeModel, type WorldManifest } from "@hyperduality/awp";
import type { Controller } from "./controller.ts";
import { ControlMux } from "./mux.ts";

export interface AgentOptions {
  name: string;
  worldUrl: string;
  token?: string;
  inspectorPort?: number;
  consumes: string[];
  controllers: Controller<any>[];
  /** What to bind and subscribe to, given the world's manifest. */
  open(manifest: WorldManifest): OpenOptions & { mode?: TimeModel };
  clock?: { rateHz?: number; paused?: boolean };
  log?: (line: string) => void;
}

export interface RunningAgent {
  mux: ControlMux;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runAgent(opts: AgentOptions): Promise<RunningAgent> {
  const log = opts.log ?? ((l: string) => console.log(`[agent] ${l}`));
  const inspector = opts.inspectorPort !== undefined ? await createInspectorServer({ port: opts.inspectorPort, process: "agent" }) : undefined;
  const activity = inspector?.stream<ActivityEntry>(AgentTopic.activity, { capacity: 2000, key: (e) => e.id });
  const controllersTopic = inspector?.state<ControllerState[]>(AgentTopic.controllers, [], { throttleMs: 50 });
  let connection: AgentStatus["connection"] = "connecting";
  let error: string | undefined;
  const statusTopic = inspector?.state<AgentStatus>(AgentTopic.status, snapshot(), { throttleMs: 100 });

  const mux: ControlMux = new ControlMux(
    opts.controllers,
    {
      activity: (e) => activity?.upsert(e),
      controllers: (list) => controllersTopic?.set(list),
      changed: () => statusTopic?.set(snapshot()),
    },
    opts.clock,
  );

  function snapshot(): AgentStatus {
    const c = mux?.client;
    const best = c?.estimator.best;
    return {
      connection,
      worldUrl: opts.worldUrl,
      sessionId: c?.ready?.session_id,
      mode: c?.mode,
      tick: c?.mode === "lockstep" ? c.tick : undefined,
      rttMs: best ? best.rtt_ns / 1e6 : undefined,
      offsetMs: best ? best.offset_ns / 1e6 : undefined,
      authority: mux?.authority ?? null,
      clock: mux ? { ...mux.clock, waiting: mux.clock.waiting > 0 } : { paused: false, rateHz: 20, waiting: false },
      error,
      manifest: c?.manifest?.raw,
    };
  }
  const setConnection = (c: AgentStatus["connection"], e?: string) => {
    connection = c;
    error = e;
    statusTopic?.set(snapshot());
  };

  if (inspector) {
    const arg = (a: unknown) => (a ?? {}) as Record<string, unknown>;
    inspector.handle(AgentCommand.enable, (a) => mux.enable(String(arg(a).id), Boolean(arg(a).enabled)));
    inspector.handle(AgentCommand.configure, (a) => mux.configure(String(arg(a).id), arg(arg(a).config)));
    inspector.handle(AgentCommand.take, (a) => mux.take(String(arg(a).id)));
    inspector.handle(AgentCommand.release, (a) => mux.release(String(arg(a).id)));
    inspector.handle(AgentCommand.input, (a) => mux.input(String(arg(a).id), arg(a).input));
    inspector.handle(AgentCommand.message, (a) => mux.message(String(arg(a).id), String(arg(a).text)));
    inspector.handle(AgentCommand.stop, (a) => mux.interrupt(String(arg(a).id)));
    inspector.handle(AgentCommand.clockPause, (a) => mux.setPaused(Boolean(arg(a).paused)));
    inspector.handle(AgentCommand.clockStep, () => mux.step());
    inspector.handle(AgentCommand.clockRate, (a) => mux.setRate(Number(arg(a).hz)));
    inspector.handle(AgentCommand.reconnect, () => current?.dropConnection?.());
  }

  let stopped = false;
  let current: (AwpClient & { dropConnection?: () => void }) | undefined;
  const statusTimer = setInterval(() => statusTopic?.set(snapshot()), 500);

  const loop = async () => {
    let backoff = 500;
    while (!stopped) {
      setConnection("connecting");
      const client = new AwpClient({
        url: opts.worldUrl,
        ...(opts.token ? { token: opts.token } : {}),
        agent: { name: opts.name, version: "0.1.0", vendor: "awp-demo" },
        consumesModalities: opts.consumes,
        logger: (level, message) => {
          if (level === "warn" || level === "error") log(`${level}: ${message}`);
        },
      });
      current = client;
      try {
        const manifest = await client.initialize(10000);
        const { mode, ...open } = opts.open(manifest.raw);
        await client.openSession(mode ?? manifest.timeModels[0]!, open);
      } catch (e) {
        setConnection("error", e instanceof Error ? e.message : String(e));
        client.disconnect?.();
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
        continue;
      }
      backoff = 500;
      log(`session ${client.ready?.session_id} on ${opts.worldUrl} (${client.mode})`);
      setConnection("connected");
      client.on("suspended", () => setConnection("suspended"));
      client.on("resumed", () => setConnection("connected"));
      mux.attach(client);
      await client.whenClosed();
      mux.detach();
      setConnection("closed", client.closeReason);
      if (!stopped) await sleep(1000);
    }
  };
  void loop();

  return {
    mux,
    async stop() {
      stopped = true;
      clearInterval(statusTimer);
      mux.detach();
      await current?.close().catch(() => undefined);
      await inspector?.close();
    },
  };
}
