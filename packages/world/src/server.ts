/**
 * Runs a WorldHost behind a WebSocket server (AWP-TRN-001) and publishes it to the inspector.
 * Transport concerns live here: authentication, the timer, backpressure, the audit files.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { type WireEntry, WorldCommand, type WorldState, WorldTopic } from "@awp-demo/inspector";
import {
  createInspectorServer,
  type InspectorServer,
  type StateTopic,
  type StreamTopic,
} from "@awp-demo/inspector/server";
import { AWP_SUBPROTOCOL } from "@hyperduality/awp";
import { type WebSocket, WebSocketServer } from "ws";
import { type HostOutput, WorldHost } from "./host.ts";
import type { WorldDefinition } from "./types.ts";
import { monotonicNs, redact } from "./util.ts";

export interface ServeOptions {
  port: number;
  host?: string;
  /** Bearer credential agents must present (AWP-SEC-005). Required unless `allowAnonymous`. */
  token?: string;
  allowAnonymous?: boolean;
  /** Inspector port for the UI; omit to run without one. */
  inspectorPort?: number;
  /** Directory for the JSONL audit log (AWP-AUD-001); omit to keep none. */
  auditDir?: string;
  /** Engage the e-stop on SIGUSR1 and release it on SIGUSR2, for the conformance suite's operator hooks. */
  operatorSignals?: boolean;
  /** Sim frame rate of the UI view topic (default 30). */
  viewHz?: number;
  log?: (line: string) => void;
}

export interface RunningWorld<View = unknown> {
  host: WorldHost<View>;
  url: string;
  port: number;
  inspector: InspectorServer | undefined;
  close(): Promise<void>;
}

const HIGH_WATER = 256 * 1024;

export async function serveWorld<View>(def: WorldDefinition<View>, opts: ServeOptions): Promise<RunningWorld<View>> {
  const log = opts.log ?? ((l: string) => console.log(`[world] ${l}`));
  const inspector =
    opts.inspectorPort !== undefined
      ? await createInspectorServer({ port: opts.inspectorPort, process: "world" })
      : undefined;
  const wire: StreamTopic<WireEntry> | undefined = inspector?.stream<WireEntry>(WorldTopic.wire, { capacity: 5000 });
  let worldState: StateTopic<WorldState> | undefined;
  let wireN = 0;

  if (opts.auditDir) mkdirSync(opts.auditDir, { recursive: true });
  // Session ids are unique within this process only (AWP-SES-009), so each run gets its own files.
  const run = new Date().toISOString().replace(/[:.]/g, "-");
  const host = new WorldHost(def, {
    hooks: {
      audit: opts.auditDir
        ? (session, record) =>
            appendFileSync(join(opts.auditDir!, `${run}-${session}.jsonl`), `${JSON.stringify(record)}\n`)
        : undefined,
      changed: () => publishWorld(),
      invalid: (schema, problems) => log(`outgoing ${schema} failed its sender form: ${problems.join("; ")}`),
    },
  });

  const wss = new WebSocketServer({
    port: opts.port,
    host: opts.host ?? "127.0.0.1",
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(AWP_SUBPROTOCOL) ? AWP_SUBPROTOCOL : false),
    verifyClient: (info, done) => {
      const verdict = authenticate(info.req, opts);
      if (verdict === true) done(true);
      else done(false, verdict.status, verdict.message);
    },
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const port = (wss.address() as { port: number }).port;
  const url = `ws://${opts.host ?? "127.0.0.1"}:${port}`;

  const sockets = new Map<number, WebSocket>();
  /** Frames held back while a socket is congested; latest-wins keys replace (AWP-TRN-009). */
  const held = new Map<number, Map<string, HostOutput & { kind: "send" }>>();
  let connCounter = 0;

  const tap = (conn: number, from: "agent" | "world", message: unknown, bytes: number) => {
    if (!wire) return;
    const session = host.sessionOf(conn);
    wire.push({
      n: ++wireN,
      ts: Date.now(),
      conn,
      ...(session ? { session } : {}),
      from,
      message: redact(message),
      bytes,
    });
  };

  const write = (ws: WebSocket, conn: number, o: HostOutput & { kind: "send" }) => {
    const message = o.frame ? host.stampSend(o.frame, o.message, monotonicNs()) : o.message;
    const text = JSON.stringify(message);
    ws.send(text);
    tap(conn, "world", message, text.length);
  };

  const apply = (outputs: HostOutput[]) => {
    for (const o of outputs) {
      const ws = sockets.get(o.conn);
      if (!ws) continue;
      if (o.kind === "close") {
        ws.close(o.code, o.reason);
        continue;
      }
      if (o.frame?.latestWins && ws.bufferedAmount > HIGH_WATER) {
        let h = held.get(o.conn);
        if (!h) {
          h = new Map();
          held.set(o.conn, h);
        }
        h.set(o.frame.key, o);
        continue;
      }
      write(ws, o.conn, o);
    }
  };

  wss.on("connection", (ws) => {
    const id = ++connCounter;
    sockets.set(id, ws);
    host.connect(id, monotonicNs());
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1002, "AWP_MALFORMED");
        return;
      }
      const text = String(data);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* the host answers the parse error */
      }
      tap(id, "agent", parsed, text.length);
      apply(host.receiveText(id, text, monotonicNs()));
    });
    ws.on("close", () => {
      sockets.delete(id);
      held.delete(id);
      apply(host.disconnect(id, monotonicNs()));
    });
    ws.on("error", () => ws.terminate());
  });

  const timer = setInterval(() => {
    apply(host.advance(monotonicNs()));
    for (const [conn, h] of held) {
      const ws = sockets.get(conn);
      if (!ws || ws.bufferedAmount > HIGH_WATER) continue;
      for (const o of h.values()) write(ws, conn, o);
      held.delete(conn);
    }
  }, 2);

  // Inspector: manifest, sessions, render view, operator commands.
  let viewTimer: NodeJS.Timeout | undefined;
  let stateTimer: NodeJS.Timeout | undefined;
  if (inspector) {
    inspector.state(WorldTopic.manifest, def.manifest);
    worldState = inspector.state<WorldState>(WorldTopic.world, { url, ...host.describe() }, { throttleMs: 50 });
    const layout = inspector.state(WorldTopic.layout, host.sim.staticView?.() ?? null);
    const view = inspector.state(WorldTopic.view, host.sim.view());
    viewTimer = setInterval(() => view.set(host.sim.view()), 1000 / (opts.viewHz ?? 30));
    // Clocks and sequence numbers move without structural changes; refresh them a few times a second.
    stateTimer = setInterval(publishWorld, 250);
    const refreshLayout = () => layout.set(host.sim.staticView?.() ?? null);
    inspector.handle(WorldCommand.reset, (args) => {
      const a = (args ?? {}) as { initialState?: string; seed?: number };
      apply(host.operatorReset(monotonicNs(), a));
      refreshLayout();
      return host.describe();
    });
    inspector.handle(WorldCommand.estopEngage, () => apply(host.engageEStop(monotonicNs())));
    inspector.handle(WorldCommand.estopRelease, () => apply(host.releaseEStop(monotonicNs())));
    inspector.handle(WorldCommand.operator, (args) => {
      const a = args as { name: string; args?: unknown };
      return host.sim.operator?.(a.name, a.args);
    });
  }
  function publishWorld() {
    worldState?.set({ url, ...host.describe() });
  }

  const onUsr1 = () => apply(host.engageEStop(monotonicNs()));
  const onUsr2 = () => apply(host.releaseEStop(monotonicNs()));
  if (opts.operatorSignals) {
    process.on("SIGUSR1", onUsr1);
    process.on("SIGUSR2", onUsr2);
  }

  log(`${def.manifest.world.name} (${host.mode}) on ${url}${inspector ? `, inspector on :${inspector.port}` : ""}`);

  return {
    host,
    url,
    port,
    inspector,
    async close() {
      clearInterval(timer);
      process.off("SIGUSR1", onUsr1);
      process.off("SIGUSR2", onUsr2);
      if (viewTimer) clearInterval(viewTimer);
      if (stateTimer) clearInterval(stateTimer);
      for (const ws of sockets.values()) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await inspector?.close();
    },
  };
}

function authenticate(req: IncomingMessage, opts: ServeOptions): true | { status: number; message: string } {
  const url = req.url ?? "/";
  // Credentials never travel in URLs (AWP-SEC-006).
  if (/[?&](token|access_token|auth)=/i.test(url))
    return { status: 400, message: "credentials must not appear in the URL" };
  if (opts.allowAnonymous || !opts.token) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${opts.token}`) return true;
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim());
  if (offered.includes(`awp.bearer.${opts.token}`)) return true;
  return { status: 401, message: "a bearer credential is required" };
}
