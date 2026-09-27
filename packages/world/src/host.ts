/**
 * A sans-IO AWP world host (Core World, spec 0.1-draft.10). Every entry point takes the current
 * monotonic time in ns and returns the messages to send; the host never reads a clock or does IO.
 * The host owns the protocol — sessions, grants, lifecycle, time — and a `Sim` owns the physics.
 */
import {
  type ActionSchemaDecl,
  type ActionState,
  type AdminOperation,
  type ChannelDecl,
  ErrorCode,
  type ErrorName,
  isTerminal,
  JsonRpcCode,
  parseJsonChecked,
  type TimeModel,
  transition,
  validate,
  type WorldManifest,
  compileParamsSchema,
} from "@hyperduality/awp";
import type { ActionRun, Sim, WorldDefinition } from "./types.ts";
import { decodeB64Json, jsonEqual, jsonPayloadB64, mintToken, redact, sha256Hex, stats } from "./util.ts";

type Id = number | string | null;
type Json = Record<string, unknown>;

export type HostOutput =
  | { kind: "send"; conn: number; message: Json; frame?: FrameMeta }
  | { kind: "close"; conn: number; code: number; reason: string };

/** Frames carry enough to be restamped (`ts_send_ns`) and replaced (latest-wins) by the transport. */
export interface FrameMeta {
  session: string;
  key: string;
  latestWins: boolean;
  streaming: boolean;
}

export interface AuditRecord {
  ts_mono_ns: number;
  direction: "in" | "out" | "internal";
  kind: string;
  body: unknown;
  class?: string;
  prev_hash?: string;
}

export interface HostHooks {
  /** A session's audit record (AWP-AUD-001); already redacted and hash-chained. */
  audit?(sessionId: string, record: AuditRecord): void;
  /** Something visible to inspectors changed (sessions, actions, grants). */
  changed?(): void;
  /** Every outgoing message failing its sender-form schema (AWP-VER-004). */
  invalid?(what: string, problems: string[], message: unknown): void;
}

export interface HostOptions {
  hooks?: HostHooks;
  /** Validate every outgoing message against its sender-form schema (default true). */
  validateOutgoing?: boolean;
}

class AwpFailure extends Error {
  readonly code: number;
  readonly errorName: string;
  readonly detail: string | undefined;
  readonly extra: Json;
  constructor(code: number, errorName: string, detail?: string, extra: Json = {}) {
    super(detail ?? errorName);
    this.code = code;
    this.errorName = errorName;
    this.detail = detail;
    this.extra = extra;
  }
}

function fail(name: ErrorName, detail?: string, extra: Json = {}): never {
  throw new AwpFailure(ErrorCode[name], name, detail, extra);
}

const RETRYABLE = new Set<string>(["AWP_BUSY", "AWP_QUEUE_FULL", "AWP_ESTOP_ACTIVE", "AWP_EMBODIMENT_UNAVAILABLE"]);

interface Conn {
  id: number;
  initialized: boolean;
  consumes: Set<string>;
  maxObsRateHz: number | undefined;
  session: Session | undefined;
  lastRecvNs: number;
  lastPingSentNs: number;
  openedNs: number;
  pingId: number;
  agent?: unknown;
}

interface Grant {
  channel: string;
  decl: ChannelDecl;
  channelId: number;
  rateHz: number | null;
  command: boolean;
  seq: number;
  nextDueNs: number;
  resync: boolean;
  lastCmdSeq: number;
  lastDeliveredNs: number;
  degraded: boolean;
}

interface Action {
  id: string;
  type: string;
  schema: ActionSchemaDecl;
  embodiment: string;
  group: string;
  params: Json;
  submission: Json;
  order: number;
  state: ActionState;
  lastSeq: number;
  lastTs: number;
  lastReason: string | undefined;
  receivedTs: number;
  run: ActionRun | undefined;
  progress: number;
  clamped: boolean;
  deadlineNs: number | undefined;
  /** Lockstep replace: preempts the group's executing action at the next advance (AWP-PRE-007). */
  replaces: boolean;
  lastProgressNs: number;
  abortDoneNs: number | undefined;
  abortReason: string | undefined;
  stream: { frames_applied: number; last_seq: number; clamped_count: number; lastFrameNs: number } | undefined;
  /** Lockstep: the run already updated during this advance, when it began. */
  executedThisTick?: boolean;
}

interface Session {
  id: string;
  token: string;
  mode: TimeModel;
  conn: Conn | undefined;
  state: "ready" | "active" | "suspended" | "closed";
  observer: boolean;
  multi: boolean;
  embodiments: string[];
  grantedTypes: string[];
  admin: AdminOperation[];
  grants: Map<string, Grant>;
  nextChannelId: number;
  statusSeq: number;
  log: { seq: number; message: Json }[];
  acked: number;
  originNs: number;
  advancesAtOpen: number;
  actions: Map<string, Action>;
  actionOrder: number;
  closing: Id[] | undefined;
  closeReason: string;
  lastAgentNs: number;
  inSafeState: boolean;
  suspendedAtNs: number | undefined;
  task: unknown;
  lastTelemetryNs: number;
  telemetry: { obs: number[]; admission: number[]; o2a: number[]; command: number[]; perChannel: Map<number, number[]> };
  auditHash: string;
  agent: unknown;
  openedAtWallMs: number;
}

export class WorldHost<View = unknown> {
  readonly manifest: WorldManifest;
  readonly mode: TimeModel;
  sim: Sim<View>;
  tick = 0;
  eStop = false;

  private readonly def: WorldDefinition<View>;
  private readonly hooks: HostHooks;
  private readonly validateOut: boolean;
  private readonly tickNs: number;
  private readonly stepNs: number;
  private readonly heartbeatMs: number;
  private readonly windowMs: number;
  private readonly watchdogMs: number | undefined;
  private readonly conns = new Map<number, Conn>();
  private readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, Session>();
  private readonly types = new Map<string, ActionSchemaDecl>();
  private readonly channels = new Map<string, ChannelDecl>();
  private readonly validators = new Map<string, ReturnType<typeof compileParamsSchema>>();
  private out: HostOutput[] = [];
  /** The request being handled; handlers that must follow their result with notifications answer it themselves. */
  private currentId: Id = null;
  private now = 0;
  private advances = 0;
  private simTimeNs = 0;
  private lastAdvanceNs: number | undefined;
  private sessionCounter = 0;
  private initialState: string;
  private seed: number;

  constructor(def: WorldDefinition<View>, options: HostOptions = {}) {
    this.def = def;
    this.manifest = def.manifest;
    this.hooks = options.hooks ?? {};
    this.validateOut = options.validateOutgoing ?? true;
    const problems = validate("world-manifest", def.manifest, "sender");
    if (problems.length > 0) throw new Error(`world manifest is invalid: ${problems.join("; ")}`);
    const [mode] = def.manifest.time_models;
    if (!mode || def.manifest.time_models.length !== 1) throw new Error("a world host serves exactly one time model");
    this.mode = mode;
    this.tickNs = Math.round((def.tickMs ?? 50) * 1e6);
    this.stepNs = Math.round((def.stepMs ?? 1000 / 60) * 1e6);
    this.heartbeatMs = def.heartbeatIntervalMs ?? 5000;
    this.windowMs = def.reconnectWindowMs ?? 30000;
    this.watchdogMs = def.manifest.safety_policy.safe_state?.watchdog_ms;
    for (const a of def.manifest.action_schemas) {
      this.types.set(a.type, a);
      this.validators.set(a.type, compileParamsSchema(def.manifest, a));
    }
    for (const c of [...def.manifest.observation_channels, ...(def.manifest.command_channels ?? [])]) this.channels.set(c.id, c);
    this.initialState = def.manifest.initial_states?.[0] ?? "default";
    this.seed = def.defaultSeed ?? 1;
    this.sim = def.createSim({ seed: this.seed, initialState: this.initialState });
  }

  // ---------------------------------------------------------------------------------------------
  // Entry points

  connect(conn: number, now: number): void {
    this.now = now;
    this.conns.set(conn, {
      id: conn,
      initialized: false,
      consumes: new Set(),
      maxObsRateHz: undefined,
      session: undefined,
      lastRecvNs: now,
      lastPingSentNs: now,
      openedNs: now,
      pingId: 0,
    });
  }

  disconnect(conn: number, now: number): HostOutput[] {
    this.now = now;
    const c = this.conns.get(conn);
    if (!c) return this.drain();
    this.conns.delete(conn);
    const s = c.session;
    if (s && s.conn === c) this.suspend(s, "connection_lost");
    return this.drain();
  }

  receiveText(conn: number, text: string, now: number): HostOutput[] {
    this.now = now;
    const c = this.conns.get(conn);
    if (!c) return this.drain();
    c.lastRecvNs = now;
    let parsed: ReturnType<typeof parseJsonChecked>;
    try {
      parsed = parseJsonChecked(text);
    } catch {
      this.sendRaw(c, { jsonrpc: "2.0", id: null, error: { code: JsonRpcCode.PARSE_ERROR, message: "Parse error" } });
      return this.drain();
    }
    const msg = parsed.value;
    if (Array.isArray(msg)) {
      this.sendRaw(c, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JsonRpcCode.INVALID_REQUEST, message: "Invalid Request", data: { detail: "batches are not used" } },
      });
      return this.drain();
    }
    if (!msg || typeof msg !== "object" || (msg as Json).jsonrpc !== "2.0") {
      this.sendRaw(c, { jsonrpc: "2.0", id: null, error: { code: JsonRpcCode.INVALID_REQUEST, message: "Invalid Request" } });
      return this.drain();
    }
    const m = msg as Json;
    const s = c.session;
    if (s) this.audit(s, "in", "control", m);
    const method = typeof m.method === "string" ? m.method : undefined;
    const hasId = Object.hasOwn(m, "id");
    // The watchdog counts agent-originated messages only; responses to our pings do not reset it (AWP-SAF-003).
    if (method && s && s.conn === c) s.lastAgentNs = now;
    if (parsed.outOfRange.length > 0) {
      if (method && hasId) this.error(c, m.id as Id, "AWP_INTEGER_RANGE", `integer beyond 2^53 − 1 at ${parsed.outOfRange[0]}`);
      if (s) this.beginClose(s, "protocol_error", undefined);
      this.out.push({ kind: "close", conn: c.id, code: 1002, reason: "AWP_INTEGER_RANGE" });
      return this.drain();
    }
    if (!method) return this.drain(); // a response (to our ping)
    if (!hasId) {
      this.onNotification(c, method, (m.params ?? {}) as Json);
      return this.drain();
    }
    const id = m.id as Id;
    this.currentId = id;
    try {
      const result = this.onRequest(c, method, m.params ?? {}, id);
      if (result !== undefined) this.result(c, id, method, result);
    } catch (e) {
      if (e instanceof AwpFailure) {
        this.sendRaw(c, {
          jsonrpc: "2.0",
          id,
          error: {
            code: e.code,
            message: e.errorName,
            data: { retryable: RETRYABLE.has(e.errorName) || e.extra.retryable === true, ...(e.detail ? { detail: e.detail } : {}), ...e.extra },
          },
        });
      } else throw e;
    }
    return this.drain();
  }

  /** Timers: streaming physics and frames, deadlines, watchdogs, heartbeats, retention. */
  advance(now: number): HostOutput[] {
    this.now = now;
    if (this.mode === "streaming") {
      if (this.lastAdvanceNs === undefined) this.lastAdvanceNs = now;
      let budget = now - this.lastAdvanceNs;
      while (budget >= this.stepNs) {
        budget -= this.stepNs;
        this.simTimeNs += this.stepNs;
        this.stepStreaming(this.stepNs / 1e6);
      }
      this.lastAdvanceNs = now - budget;
      for (const s of this.sessions.values()) this.serviceStreaming(s);
    }
    for (const s of [...this.sessions.values()]) this.serviceSession(s);
    for (const c of [...this.conns.values()]) this.serviceConn(c);
    return this.drain();
  }

  /** Stamps `ts_send_ns` on a streaming frame the transport is about to write (AWP-OBS-006). */
  stampSend(meta: FrameMeta, message: Json, now: number): Json {
    const s = this.sessions.get(meta.session);
    if (!s || !meta.streaming) return message;
    const params = message.params as Json;
    const send = Math.max(now - s.originNs, params.ts_mono_ns as number);
    params.ts_send_ns = send;
    s.telemetry.obs.push(send - (params.ts_mono_ns as number));
    const per = s.telemetry.perChannel.get(params.channel_id as number) ?? [];
    per.push(send - (params.ts_mono_ns as number));
    s.telemetry.perChannel.set(params.channel_id as number, per);
    return message;
  }

  // Operator surface (out of band, like awp-sim's signals)

  engageEStop(now: number): HostOutput[] {
    this.now = now;
    if (this.eStop) return this.drain();
    this.eStop = true;
    for (const s of this.sessions.values()) {
      for (const emb of s.embodiments) {
        this.sim.safeStop(emb);
        this.event(s, "e_stop_engaged", { embodiment: emb, source: "operator" });
      }
      for (const a of this.liveActions(s)) {
        if (a.state === "executing" || a.state === "cancelling") this.finish(s, a, "failed", { reason: "e_stop" });
        else this.finish(s, a, "cancelled", { reason: "e_stop" });
      }
    }
    this.hooks.changed?.();
    return this.drain();
  }

  releaseEStop(now: number): HostOutput[] {
    this.now = now;
    if (!this.eStop) return this.drain();
    this.eStop = false;
    for (const s of this.sessions.values()) for (const emb of s.embodiments) this.event(s, "e_stop_released", { embodiment: emb, source: "operator" });
    this.hooks.changed?.();
    return this.drain();
  }

  /** `world.reset` on behalf of the operator (the UI), not a session. */
  operatorReset(now: number, opts: { initialState?: string; seed?: number } = {}): HostOutput[] {
    this.now = now;
    this.resetWorld("operator", opts);
    return this.drain();
  }

  // ---------------------------------------------------------------------------------------------
  // Introspection for inspectors

  sessionNow(sessionId: string): number | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.clock(s) : undefined;
  }

  sessionOf(conn: number): string | undefined {
    return this.conns.get(conn)?.session?.id;
  }

  describe() {
    return {
      mode: this.mode,
      tick: this.tick,
      eStop: this.eStop,
      seed: this.seed,
      initialState: this.initialState,
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id,
        state: s.state,
        mode: s.mode,
        observer: s.observer,
        embodiments: s.embodiments,
        connected: s.conn !== undefined,
        closing: s.closing !== undefined,
        inSafeState: s.inSafeState,
        clockNs: this.clock(s),
        statusSeq: s.statusSeq,
        grantedTypes: s.grantedTypes,
        admin: s.admin,
        agent: s.agent,
        task: s.task,
        channels: [...s.grants.values()].map((g) => ({
          channel: g.channel,
          channelId: g.channelId,
          rateHz: g.rateHz,
          seq: g.command ? g.lastCmdSeq : g.seq,
          command: g.command,
          modality: g.decl.modality,
          lossClass: g.decl.loss_class,
        })),
        actions: [...s.actions.values()].slice(-50).map((a) => ({
          id: a.id,
          type: a.type,
          embodiment: a.embodiment,
          state: a.state,
          reason: a.lastReason,
          progress: a.progress,
          params: a.params,
        })),
      })),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Requests

  private onRequest(c: Conn, method: string, rawParams: unknown, id: Id): unknown {
    if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
      throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", "params must be an object");
    }
    const p = rawParams as Json;
    if (method === "ping") return this.rpcPing(c, p);
    if (method === "initialize") return this.rpcInitialize(c, p);
    if (!KNOWN_METHODS.has(method) || !this.offered(method)) {
      throw new AwpFailure(JsonRpcCode.METHOD_NOT_FOUND, "Method not found", method);
    }
    if (!c.initialized) throw new AwpFailure(JsonRpcCode.INVALID_REQUEST, "Invalid Request", "initialize first");
    if (method === "world.manifest") return this.manifest;
    if (method === "session.open") return this.rpcOpen(c, p);
    if (method === "session.resume") return this.rpcResume(c, p);
    const s = c.session;
    if (!s || s.state === "closed") fail("AWP_SESSION_UNKNOWN", "no session on this connection");
    const schema = PARAMS_SCHEMA[method];
    if (schema) {
      const problems = validate(schema, p, "receiver");
      if (problems.length > 0) throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", problems.join("; "));
    }
    if (s.closing) {
      if (method === "session.close") {
        s.closing.push(id);
        return undefined;
      }
      if (method !== "action.status") fail("AWP_SESSION_EXPIRED", "the session is closing");
    }
    switch (method) {
      case "session.close":
        this.beginClose(s, "session_closed", id);
        return undefined;
      case "obs.subscribe":
        return this.rpcSubscribe(c, s, p);
      case "obs.unsubscribe":
        return this.rpcUnsubscribe(s, p);
      case "action.submit":
        return this.rpcSubmit(s, p);
      case "action.cancel":
        return this.rpcCancel(s, p);
      case "action.status":
        return this.rpcStatus(s, p);
      case "world.tick":
        return this.rpcTick(s, p);
      case "world.reset":
        return this.rpcReset(s, p);
      case "task.update":
        this.checkTask(p.task);
        s.task = p.task;
        this.hooks.changed?.();
        return {};
      default:
        throw new AwpFailure(JsonRpcCode.METHOD_NOT_FOUND, "Method not found", method);
    }
  }

  private offered(method: string): boolean {
    if (method === "task.update") return this.manifest.capabilities?.task === true;
    if (method === "world.tick") return this.mode === "lockstep";
    if (method === "world.reset") return (this.manifest.initial_states?.length ?? 0) > 0;
    return true;
  }

  private rpcPing(c: Conn, p: Json): Json {
    const s = c.session;
    if (s && typeof p.last_status_seq === "number") this.acknowledge(s, p.last_status_seq);
    // Before a session exists the pong is stamped on the world's own clock (AWP-SES-012).
    const t = s ? this.clock(s) : Math.max(0, this.now - c.openedNs);
    return { origin_ns: p.origin_ns ?? 0, receive_ns: t, transmit_ns: t };
  }

  private rpcInitialize(c: Conn, p: Json): WorldManifest {
    const problems = validate("agent-manifest", p, "receiver");
    if (problems.length > 0) throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", problems.join("; "));
    const versions = p.protocol_versions as string[];
    if (!versions.includes(this.manifest.protocol_version)) {
      fail("AWP_VERSION_UNSUPPORTED", `this world speaks ${this.manifest.protocol_version}`, { supported: [this.manifest.protocol_version] });
    }
    c.initialized = true;
    c.consumes = new Set(p.consumes_modalities as string[]);
    c.maxObsRateHz = typeof p.max_obs_rate_hz === "number" ? p.max_obs_rate_hz : undefined;
    c.agent = p.agent;
    return this.manifest;
  }

  private rpcOpen(c: Conn, p: Json): undefined {
    const problems = validate("session-open", p, "receiver");
    if (problems.length > 0) throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", problems.join("; "));
    if (c.session && c.session.state !== "closed") fail("AWP_SESSION_EXISTS", "this connection already holds a session");
    const mode = p.mode as TimeModel;
    if (mode !== this.mode) fail("AWP_TIME_MODEL_UNSUPPORTED", `this world runs ${this.mode}`);
    if (p.takeover) fail("AWP_EMBODIMENT_UNAVAILABLE", "transfer is not supported");
    const requested = p.embodiments ? (p.embodiments as string[]) : p.embodiment ? [p.embodiment as string] : [];
    const multi = Array.isArray(p.embodiments);
    const decls = requested.map((e) => {
      const d = this.manifest.embodiments.find((x) => x.id === e);
      if (!d) fail("AWP_EMBODIMENT_UNAVAILABLE", `no embodiment ${e}`);
      return d;
    });
    if (multi && decls.length > 1) {
      const group = decls[0]!.multi_bind_group;
      if (!group || decls.some((d) => d.multi_bind_group !== group)) {
        fail("AWP_EMBODIMENT_UNAVAILABLE", "embodiments bound together must share a multi_bind_group");
      }
    }
    for (const d of decls) {
      if (d.shared_control) continue;
      for (const other of this.sessions.values()) {
        if (other.state !== "closed" && other.embodiments.includes(d.id)) fail("AWP_EMBODIMENT_UNAVAILABLE", `${d.id} is bound by another session`);
      }
    }
    // One controlling session at a time, so any_session tick authority needs no grant (AWP-TIM-012).
    if (decls.length > 0 && this.mode === "lockstep") {
      for (const other of this.sessions.values()) {
        if (other.state !== "closed" && !other.observer) fail("AWP_EMBODIMENT_UNAVAILABLE", "another session controls this world");
      }
    }
    if (p.task !== undefined) {
      if (this.manifest.capabilities?.task !== true) throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", "this world has no task capability");
      this.checkTask(p.task);
    }
    const observer = decls.length === 0;
    const offeredTypes = new Set(decls.flatMap((d) => d.action_types));
    const grantedTypes = p.action_types
      ? (p.action_types as string[]).filter((t) => offeredTypes.has(t))
      : [...offeredTypes];
    const admin = ((p.admin as AdminOperation[] | undefined) ?? []).filter((op) => this.adminAvailable(op, observer));

    const s: Session = {
      id: `sess_${String(++this.sessionCounter).padStart(2, "0")}`,
      token: mintToken("st_"),
      mode,
      conn: c,
      state: "ready",
      observer,
      multi,
      embodiments: decls.map((d) => d.id),
      grantedTypes,
      admin,
      grants: new Map(),
      nextChannelId: 1,
      statusSeq: 0,
      log: [],
      acked: 0,
      originNs: this.now,
      advancesAtOpen: this.advances,
      actions: new Map(),
      actionOrder: 0,
      closing: undefined,
      closeReason: "session_closed",
      lastAgentNs: this.now,
      inSafeState: false,
      suspendedAtNs: undefined,
      task: p.task,
      lastTelemetryNs: this.now,
      telemetry: { obs: [], admission: [], o2a: [], command: [], perChannel: new Map() },
      auditHash: "",
      agent: c.agent,
      openedAtWallMs: Date.now(),
    };
    for (const sub of (p.subscribe as { channel: string; rate_hz?: number }[] | undefined) ?? []) {
      const decl = this.manifest.observation_channels.find((x) => x.id === sub.channel);
      if (!decl) fail("AWP_CHANNEL_UNKNOWN", `no channel ${sub.channel}`);
      if (!this.readable(c, s, decl)) continue;
      this.grantChannel(s, c, decl, sub.rate_hz, false);
    }
    for (const t of grantedTypes) {
      const cc = this.types.get(t)?.command_channel;
      const decl = cc ? this.manifest.command_channels?.find((x) => x.id === cc) : undefined;
      if (decl && !s.grants.has(decl.id)) this.grantChannel(s, c, decl, undefined, true);
    }
    if (typeof p.seed === "number" && this.manifest.capabilities?.seed === true && !observer) {
      this.seed = p.seed;
      this.sim = this.def.createSim({ seed: this.seed, initialState: this.initialState });
    }
    this.sessions.set(s.id, s);
    this.byToken.set(s.token, s);
    c.session = s;

    const ready = this.readyObject(s);
    this.audit(s, "internal", "header", { manifest: this.manifest, session_id: s.id, agent: s.agent }, "audit_record");
    this.result(c, this.currentId, "session.open", ready);
    this.sessionState(s, "ready", "opened");
    if (this.mode === "lockstep") {
      for (const g of s.grants.values()) if (!g.command) this.emitFrame(s, g, false);
      this.activate(s);
    }
    this.hooks.changed?.();
    return undefined;
  }

  private readyObject(s: Session, extra: Json = {}): Json {
    const envelopes = this.manifest.safety_policy.envelopes.filter((e) => s.embodiments.includes(e.embodiment));
    return {
      session_id: s.id,
      session_token: s.token,
      reconnect_window_ms: Math.max(this.windowMs, this.watchdogMs ?? 0),
      heartbeat_interval_ms: this.heartbeatMs,
      granted: {
        channels: [...s.grants.values()].map((g) => ({ channel: g.channel, rate_hz: g.rateHz, channel_id: g.channelId })),
        action_types: s.grantedTypes,
        admin: s.admin,
        envelopes,
      },
      stream_endpoints: [{ binding: "inline" }],
      frame_tree: this.def.frameTree ?? { frames: [{ id: "world", parent: null }] },
      clock_anchor: new Date(s.openedAtWallMs).toISOString(),
      ...(this.mode === "lockstep" ? { tick: this.tick } : {}),
      ...extra,
    };
  }

  private adminAvailable(op: AdminOperation, observer: boolean): boolean {
    if (op === "tick") return this.mode === "lockstep" && !observer && ![...this.sessions.values()].some((x) => x.admin.includes("tick"));
    if (op === "reset") return (this.manifest.initial_states?.length ?? 0) > 0 && ![...this.sessions.values()].some((x) => x.admin.includes("reset"));
    return false;
  }

  private readable(c: Conn, s: Session, decl: ChannelDecl): boolean {
    if (!c.consumes.has(decl.modality)) return false; // AWP-AGM-001
    if (s.observer) return true;
    return this.manifest.embodiments.some((e) => s.embodiments.includes(e.id) && e.channels.includes(decl.id));
  }

  private grantChannel(s: Session, c: Conn, decl: ChannelDecl, requestedHz: number | undefined, command: boolean): Grant {
    const existing = s.grants.get(decl.id);
    let rate: number | null = null;
    if (this.mode === "streaming") {
      rate = decl.rate_hz ?? 10;
      if (requestedHz !== undefined) rate = Math.min(rate, requestedHz);
      if (!command && c.maxObsRateHz !== undefined) rate = Math.min(rate, c.maxObsRateHz);
    }
    const g: Grant = existing ?? {
      channel: decl.id,
      decl,
      channelId: s.nextChannelId++,
      rateHz: rate,
      command,
      seq: 0,
      nextDueNs: this.now,
      resync: false,
      lastCmdSeq: 0,
      lastDeliveredNs: this.now,
      degraded: false,
    };
    g.rateHz = rate;
    s.grants.set(decl.id, g);
    return g;
  }

  private rpcSubscribe(c: Conn, s: Session, p: Json): Json {
    const added: Grant[] = [];
    for (const sub of p.channels as { channel: string; rate_hz?: number }[]) {
      const decl = this.manifest.observation_channels.find((x) => x.id === sub.channel);
      if (!decl) fail("AWP_CHANNEL_UNKNOWN", `no channel ${sub.channel}`);
      if (!this.readable(c, s, decl)) fail("AWP_FORBIDDEN", `channel ${sub.channel} is not readable by this session`);
    }
    for (const sub of p.channels as { channel: string; rate_hz?: number }[]) {
      const decl = this.manifest.observation_channels.find((x) => x.id === sub.channel)!;
      const isNew = !s.grants.has(decl.id);
      const g = this.grantChannel(s, c, decl, sub.rate_hz, false);
      if (isNew) added.push(g);
    }
    const result = { granted: this.grantList(s) };
    if (this.mode === "lockstep" && added.length > 0) {
      this.result(c, this.currentId, "obs.subscribe", result);
      for (const g of added) this.emitFrame(s, g, false);
      this.hooks.changed?.();
      return undefined as unknown as Json;
    }
    this.hooks.changed?.();
    return result;
  }

  private rpcUnsubscribe(s: Session, p: Json): Json {
    for (const name of p.channels as string[]) {
      const decl = this.manifest.observation_channels.find((x) => x.id === name);
      if (!decl) fail("AWP_CHANNEL_UNKNOWN", `no channel ${name}`);
    }
    for (const name of p.channels as string[]) s.grants.delete(name);
    this.hooks.changed?.();
    return { granted: this.grantList(s) };
  }

  private grantList(s: Session) {
    return [...s.grants.values()].map((g) => ({ channel: g.channel, rate_hz: g.rateHz, channel_id: g.channelId }));
  }

  private checkTask(task: unknown): void {
    const t = task as { content?: { type?: string }[] } | undefined;
    if (!t || !Array.isArray(t.content) || t.content.length === 0) fail("AWP_PARAMS_INVALID", "a task has content blocks");
    for (const b of t.content) if (b.type !== "text") fail("AWP_PARAMS_INVALID", `content block type ${b.type} is not supported`);
  }

  // ---------------------------------------------------------------------------------------------
  // Actions

  private rpcSubmit(s: Session, p: Json): Json {
    const receivedTs = this.clock(s);
    const actionId = p.action_id as string;
    const submission: Json = {};
    for (const k of IDENTITY_FIELDS) if (Object.hasOwn(p, k)) submission[k] = p[k];
    const prior = s.actions.get(actionId);
    if (prior) {
      if (!jsonEqual(prior.submission, submission)) fail("AWP_ACTION_ID_CONFLICT", `${actionId} was submitted with different content`);
      return this.submitResult(prior); // AWP-ACT-001
    }
    if (s.observer) fail("AWP_FORBIDDEN", "observer sessions cannot act");
    let embodiment: string;
    if (s.multi) {
      if (typeof p.embodiment_id !== "string") throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", "embodiment_id is required in a multi-bind session");
      embodiment = p.embodiment_id;
    } else embodiment = (p.embodiment_id as string | undefined) ?? s.embodiments[0]!;
    if (!s.embodiments.includes(embodiment)) fail("AWP_FORBIDDEN", `${embodiment} is not bound to this session`);
    const type = p.type as string;
    const schema = this.types.get(type);
    const emb = this.manifest.embodiments.find((e) => e.id === embodiment)!;
    if (!schema || !s.grantedTypes.includes(type) || !emb.action_types.includes(type)) fail("AWP_FORBIDDEN", `${type} is not granted for ${embodiment}`);
    if (this.eStop) fail("AWP_ESTOP_ACTIVE", "the e-stop is engaged");
    const params = (p.params ?? {}) as Json;
    const check = this.validators.get(type)!;
    if (!check(params)) {
      fail("AWP_PARAMS_INVALID", (check.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; "));
    }
    const policies = Array.isArray(schema.preemption) ? schema.preemption : [schema.preemption];
    const preempt = (p.preempt as string | undefined) ?? policies[0]!;
    if (!policies.includes(preempt as never)) fail("AWP_PARAMS_INVALID", `${type} does not offer preempt ${preempt}`);
    const verdict = this.sim.admit?.(embodiment, type, params) ?? { ok: true };
    if ("error" in verdict) fail(verdict.error, verdict.detail, verdict.retryable ? { retryable: true } : {});

    const group = `${embodiment}/${schema.concurrency_group ?? "_"}`;
    const live = this.liveActions(s).filter((a) => a.group === group);
    let initial: ActionState = "accepted";
    if (preempt === "reject" && live.length > 0) fail("AWP_BUSY", `${group} is busy`, { retry_after_ms: 100 });
    if (preempt === "queue" && live.length > 0) {
      const queued = live.filter((a) => a.state === "queued").length;
      if (queued >= (schema.max_queue ?? 1)) fail("AWP_QUEUE_FULL", `the queue of ${group} is full`, { retry_after_ms: 100 });
      initial = "queued";
    }
    if (typeof p.basis_ts_mono_ns === "number") s.telemetry.o2a.push(Math.max(0, receivedTs - p.basis_ts_mono_ns));

    const a: Action = {
      id: actionId,
      type,
      schema,
      embodiment,
      group,
      params,
      submission,
      order: ++s.actionOrder,
      state: "accepted",
      lastSeq: 0,
      lastTs: receivedTs,
      lastReason: undefined,
      receivedTs,
      run: undefined,
      progress: 0,
      clamped: false,
      deadlineNs: typeof p.deadline_ms === "number" ? receivedTs + p.deadline_ms * 1e6 : undefined,
      replaces: false,
      lastProgressNs: 0,
      abortDoneNs: undefined,
      abortReason: undefined,
      stream: undefined,
    };
    if (schema.max_duration_ms !== undefined) {
      const cap = receivedTs + schema.max_duration_ms * 1e6;
      a.deadlineNs = a.deadlineNs === undefined ? cap : Math.min(a.deadlineNs, cap);
    }
    if (preempt === "replace") {
      for (const other of live) {
        if (other.state === "executing" || other.state === "cancelling") {
          if (this.mode === "streaming") this.preempt(s, other);
          else a.replaces = true; // AWP-PRE-007
        } else this.finish(s, other, "cancelled", { reason: "superseded" });
      }
    }
    s.actions.set(actionId, a);
    // The admission transition is first reported in the result (AWP-CTL-008).
    a.state = initial;
    a.lastSeq = ++s.statusSeq;
    a.lastTs = receivedTs;
    this.retain(s, this.statusMessage(s, a, {}));
    this.audit(s, "internal", "status", { action_id: a.id, state: initial });
    this.activate(s);
    const result = this.submitResult(a);
    s.telemetry.admission.push(Math.max(0, this.clock(s) - receivedTs));
    this.result(s.conn!, this.currentId, "action.submit", result);
    if (this.mode === "streaming") this.pump(s);
    this.hooks.changed?.();
    return undefined as unknown as Json;
  }

  private submitResult(a: Action): Json {
    return {
      action_id: a.id,
      state: a.state,
      status_seq: a.lastSeq,
      received_ts_mono_ns: a.receivedTs,
      ts_mono_ns: a.lastTs,
      ...(a.lastReason && (a.state === "rejected" || a.state === "failed" || a.state === "cancelled") ? { reason: a.lastReason } : {}),
    };
  }

  private rpcCancel(s: Session, p: Json): Json {
    const a = s.actions.get(p.action_id as string);
    if (!a) fail("AWP_ACTION_UNKNOWN", `no action ${p.action_id}`);
    if (isTerminal(a.state) || a.state === "cancelling") {
      return { action_id: a.id, state: a.state, status_seq: a.lastSeq, ...(a.lastReason ? { reason: a.lastReason } : {}) };
    }
    if (a.state === "executing") {
      this.transitionQuiet(s, a, "cancelling", { reason: "cancelled_by_agent" });
      const result = { action_id: a.id, state: a.state, status_seq: a.lastSeq, reason: "cancelled_by_agent" };
      this.result(s.conn!, this.currentId, "action.cancel", result);
      this.startAbort(s, a, "cancelled_by_agent", true);
      if (this.mode === "streaming") this.pump(s);
      return undefined as unknown as Json;
    }
    this.transitionQuiet(s, a, "cancelled", { reason: "cancelled_by_agent" });
    const result = { action_id: a.id, state: a.state, status_seq: a.lastSeq, reason: "cancelled_by_agent" };
    this.result(s.conn!, this.currentId, "action.cancel", result);
    if (this.mode === "streaming") this.pump(s);
    this.hooks.changed?.();
    return undefined as unknown as Json;
  }

  private rpcStatus(s: Session, p: Json): Json {
    const a = s.actions.get(p.action_id as string);
    if (!a) fail("AWP_ACTION_UNKNOWN", `no action ${p.action_id}`);
    const status = this.statusParams(s, a, {});
    status.status_seq = a.lastSeq;
    return status;
  }

  // ---------------------------------------------------------------------------------------------
  // Lockstep

  private rpcTick(s: Session, p: Json): Json {
    if (s.observer) fail("AWP_TICK_NOT_AUTHORIZED", "observer sessions cannot advance the world");
    const expected = p.expected_tick as number;
    if (expected !== this.tick) fail("AWP_TICK_MISMATCH", `the world is at tick ${this.tick}`, { tick: this.tick });
    const count = (p.count as number | undefined) ?? 1;
    for (let i = 0; i < count; i++) this.advanceTick();
    return { tick: this.tick };
  }

  private advanceTick(): void {
    this.tick += 1;
    this.advances += 1;
    const dt = this.tickNs / 1e6;
    const live = [...this.sessions.values()].filter((s) => s.state !== "closed");
    for (const s of live) this.startStaged(s);
    for (const s of live) this.updateRuns(s, dt, true);
    this.sim.step(dt);
    for (const s of live) {
      this.promoteQueued(s);
      for (const g of s.grants.values()) if (!g.command) this.emitFrame(s, g, false);
    }
    this.hooks.changed?.();
  }

  /** At the start of an advance: deferred aborts end, lockstep replacements take effect, staged actions begin. */
  private startStaged(s: Session): void {
    for (const a of this.liveActions(s)) {
      if (a.state === "cancelling" && a.abortDoneNs === -1) {
        this.finish(s, a, "cancelled", { reason: a.abortReason ?? "cancelled_by_agent", aborted_at_progress: round3(a.progress) });
      }
    }
    const staged = [...s.actions.values()].filter((a) => a.state === "accepted").sort((x, y) => x.order - y.order);
    for (const a of staged) {
      const running = this.liveActions(s).find((o) => o.group === a.group && (o.state === "executing" || o.state === "cancelling"));
      if (running) {
        if (!a.replaces || running.state === "cancelling") continue;
        this.preempt(s, running);
      }
      this.begin(s, a);
    }
  }

  private promoteQueued(s: Session): void {
    const groups = new Set([...s.actions.values()].filter((a) => a.state === "queued").map((a) => a.group));
    for (const group of groups) {
      const inGroup = this.liveActions(s).filter((a) => a.group === group);
      if (inGroup.some((a) => a.state !== "queued")) continue;
      const next = inGroup.sort((x, y) => x.order - y.order)[0];
      if (next) this.transition(s, next, "accepted", {});
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Streaming

  private stepStreaming(dt: number): void {
    for (const s of this.sessions.values()) if (s.state !== "closed") this.updateRuns(s, dt, false);
    this.sim.step(dt);
  }

  /** Streaming: promote queued, start accepted, as soon as a group frees. */
  private pump(s: Session): void {
    for (let guard = 0; guard < 16; guard++) {
      let changed = false;
      const groups = new Set(this.liveActions(s).map((a) => a.group));
      for (const group of groups) {
        const inGroup = this.liveActions(s)
          .filter((a) => a.group === group)
          .sort((x, y) => x.order - y.order);
        if (inGroup.some((a) => a.state === "executing" || a.state === "cancelling")) continue;
        const accepted = inGroup.find((a) => a.state === "accepted");
        if (accepted) {
          this.begin(s, accepted);
          changed = true;
          continue;
        }
        const queued = inGroup.find((a) => a.state === "queued");
        if (queued) {
          this.transition(s, queued, "accepted", {});
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private serviceStreaming(s: Session): void {
    if (s.state === "closed") return;
    const now = this.clock(s);
    for (const a of this.liveActions(s)) {
      if (a.state === "cancelling" && a.abortDoneNs !== undefined && now >= a.abortDoneNs) {
        this.finish(s, a, "cancelled", { reason: a.abortReason ?? "cancelled_by_agent", aborted_at_progress: a.progress });
        continue;
      }
      if (a.deadlineNs !== undefined && now > a.deadlineNs) {
        if (a.state === "executing") {
          a.run?.abort?.();
          this.finish(s, a, "failed", { reason: "deadline_exceeded" });
        } else if (a.state !== "cancelling") this.finish(s, a, "rejected", { reason: "deadline_exceeded" });
        continue;
      }
      if (a.state === "executing" && a.schema.duration === "streaming" && a.stream) {
        const watchdog = (a.schema.watchdog_ms ?? 500) * 1e6;
        if (now - a.stream.lastFrameNs > watchdog) {
          a.run?.abort?.();
          this.finish(s, a, "failed", { reason: "watchdog" });
          continue;
        }
        if (now - a.lastProgressNs >= 1e9) {
          a.lastProgressNs = now;
          this.statusUpdate(s, a, { stream: this.streamStats(a) });
        }
      } else if (a.state === "executing" && a.schema.duration === "extended" && now - a.lastProgressNs >= 2e8) {
        a.lastProgressNs = now;
        this.statusUpdate(s, a, { progress: round3(a.progress) });
      }
    }
    this.pump(s);
    // Frames at the negotiated rates.
    if (s.conn) {
      for (const g of s.grants.values()) {
        if (g.command || g.rateHz === null) continue;
        const period = 1e9 / g.rateHz;
        if (this.now >= g.nextDueNs) {
          this.emitFrame(s, g, true);
          g.nextDueNs = Math.max(g.nextDueNs + period, this.now);
        }
      }
    }
    // A reliable channel that cannot be delivered past stale_after_ms is degraded (AWP-SAF-009).
    for (const g of s.grants.values()) {
      if (g.command || g.rateHz === null || g.decl.loss_class !== "reliable" || g.degraded) continue;
      const staleNs = (g.decl.stale_after_ms ?? 2000 / g.rateHz) * 1e6;
      if (this.now - g.lastDeliveredNs > staleNs) {
        g.degraded = true;
        this.event(s, "channel_degraded", { channel: g.channel, channel_id: g.channelId });
      }
    }
    // Watchdog (AWP-SAF-003/004): runs whether or not the session is connected.
    if (this.watchdogMs !== undefined && !s.observer && !s.inSafeState && this.now - s.lastAgentNs > this.watchdogMs * 1e6) {
      this.enterSafeState(s);
    }
    if (s.conn && this.now - s.lastTelemetryNs >= 1e9) this.telemetry(s);
  }

  private telemetry(s: Session): void {
    const t = s.telemetry;
    const channels: Json = {};
    for (const [id, samples] of t.perChannel) {
      const st = stats(samples);
      if (st) channels[String(id)] = st;
    }
    const params: Json = { window_ms: Math.max(1, Math.round((this.now - s.lastTelemetryNs) / 1e6)) };
    const add = (k: string, v: number[]) => {
      const st = stats(v);
      if (st) params[k] = st;
    };
    add("observation_latency_ns", t.obs);
    add("admission_latency_ns", t.admission);
    add("observation_to_action_ns", t.o2a);
    add("command_latency_ns", t.command);
    if (Object.keys(channels).length > 0) params.channels = channels;
    s.lastTelemetryNs = this.now;
    s.telemetry = { obs: [], admission: [], o2a: [], command: [], perChannel: new Map() };
    this.notifyUnsequenced(s, "session.telemetry", params);
  }

  private enterSafeState(s: Session): void {
    s.inSafeState = true;
    for (const emb of s.embodiments) this.sim.safeStop(emb);
    for (const a of this.liveActions(s)) {
      if (a.state === "executing" || a.state === "cancelling") this.finish(s, a, "failed", { reason: "connection_lost" });
      else this.finish(s, a, "cancelled", { reason: "safe_state" });
    }
    const behavior = this.manifest.safety_policy.safe_state?.behavior ?? "hold";
    for (const emb of s.embodiments) this.event(s, "safe_state_entered", { embodiment: emb, behavior });
    this.hooks.changed?.();
  }

  private onNotification(c: Conn, method: string, p: Json): void {
    const s = c.session;
    if (method === "cmd.frame" && s && s.mode === "streaming") this.onCommandFrame(s, p);
    // obs.report is accepted (AWP-OBS-007); unknown notifications are ignored (AWP-VER-003).
  }

  private onCommandFrame(s: Session, p: Json): void {
    const g = [...s.grants.values()].find((x) => x.command && x.channelId === p.channel_id);
    if (!g) return;
    const bound = this.liveActions(s).filter((a) => a.state === "executing" && a.schema.command_channel === g.channel);
    if (bound.length !== 1) return; // AWP-CMD-003
    const a = bound[0]!;
    const seq = p.seq as number;
    if (seq <= g.lastCmdSeq) return; // AWP-CMD-007
    g.lastCmdSeq = seq;
    let payload: unknown;
    try {
      payload = decodeB64Json(p.payload_b64 as string);
    } catch {
      return;
    }
    const verdict = a.run?.command?.(payload);
    const st = a.stream!;
    st.frames_applied += 1;
    st.last_seq = seq;
    st.lastFrameNs = this.clock(s);
    if (verdict?.clamped) {
      st.clamped_count += 1;
      a.clamped = true;
    }
    if (typeof p.ts_mono_ns === "number") s.telemetry.command.push(Math.max(0, this.clock(s) - p.ts_mono_ns));
    this.audit(s, "in", "frame", { channel_id: p.channel_id, seq, ts_mono_ns: p.ts_mono_ns, payload_sha256: sha256Hex(String(p.payload_b64)) });
  }

  private streamStats(a: Action) {
    const st = a.stream!;
    return { frames_applied: st.frames_applied, last_seq: st.last_seq, clamped_count: st.clamped_count };
  }

  // ---------------------------------------------------------------------------------------------
  // Execution

  private begin(s: Session, a: Action): void {
    const run = this.sim.start(a.embodiment, a.type, a.params, { actionId: a.id, sessionId: s.id });
    a.run = run;
    a.lastProgressNs = this.clock(s);
    if (a.schema.duration === "streaming") a.stream = { frames_applied: 0, last_seq: 0, clamped_count: 0, lastFrameNs: this.clock(s) };
    const extra: Json = a.schema.duration === "extended" && this.mode === "streaming" ? { progress: 0 } : {};
    if (this.mode === "lockstep") {
      // One status per advance: the start carries the advance's progress (AWP-LIF-003).
      const status = run.update(this.tickNs / 1e6);
      a.executedThisTick = true;
      if ("failed" in status) {
        this.transition(s, a, "executing", {});
        this.finish(s, a, "failed", { reason: status.failed, ...(status.detail ? { detail: status.detail } : {}) });
      } else if ("done" in status) {
        a.clamped ||= status.clamped === true;
        this.transition(s, a, "executing", {});
        this.finish(s, a, "completed", a.clamped ? { clamped: true } : {});
      } else {
        a.progress = clamp01(status.progress ?? 0);
        a.clamped ||= status.clamped === true;
        this.transition(s, a, "executing", a.schema.duration === "extended" ? { progress: round3(a.progress) } : {});
      }
    } else {
      this.transition(s, a, "executing", extra);
    }
    if (s.inSafeState) {
      s.inSafeState = false;
      this.event(s, "safe_state_exited", { embodiment: a.embodiment });
    }
  }

  private updateRuns(s: Session, dt: number, lockstep: boolean): void {
    for (const a of this.liveActions(s)) {
      if (a.state !== "executing" || !a.run) continue;
      if (a.executedThisTick) {
        a.executedThisTick = false;
        continue;
      }
      const status = a.run.update(dt);
      if ("failed" in status) {
        this.finish(s, a, "failed", { reason: status.failed, ...(status.detail ? { detail: status.detail } : {}) });
      } else if ("done" in status) {
        a.clamped ||= status.clamped === true;
        a.progress = 1;
        this.finish(s, a, "completed", a.clamped ? { clamped: true } : {});
      } else {
        a.progress = clamp01(status.progress ?? a.progress);
        a.clamped ||= status.clamped === true;
        if (lockstep && a.schema.duration === "extended") this.statusUpdate(s, a, { progress: round3(a.progress) });
      }
    }
    if (!lockstep) this.pump(s);
  }

  private preempt(s: Session, a: Action): void {
    a.run?.abort?.();
    this.finish(s, a, "preempted", {});
  }

  private startAbort(s: Session, a: Action, reason: string, deferInLockstep = false): void {
    const ms = a.run?.abort?.() ?? 0;
    if (this.mode === "lockstep" && deferInLockstep) {
      a.abortReason = reason;
      a.abortDoneNs = -1;
      return;
    }
    if (this.mode === "lockstep" || ms <= 0) {
      this.finish(s, a, "cancelled", { reason, aborted_at_progress: round3(a.progress) });
    } else {
      a.abortDoneNs = this.clock(s) + ms * 1e6;
      a.abortReason = reason;
    }
  }

  /** Terminal transitions (through `cancelling` where the table requires it). */
  private finish(s: Session, a: Action, to: ActionState, extra: Json): void {
    if (isTerminal(a.state)) return;
    if (to === "cancelled" && a.state === "executing") {
      this.transition(s, a, "cancelling", { reason: extra.reason });
      a.run?.abort?.();
      this.transition(s, a, "cancelled", { ...extra, aborted_at_progress: round3(a.progress) });
      return;
    }
    if (to === "cancelled" && a.state === "cancelling") {
      this.transition(s, a, "cancelled", { ...extra, aborted_at_progress: round3(a.progress) });
      return;
    }
    if (to === "preempted" && a.state === "cancelling") return;
    this.transition(s, a, to, extra);
  }

  private transition(s: Session, a: Action, to: ActionState, extra: Json): void {
    this.move(s, a, to, extra);
    a.lastSeq = this.notify(s, "action.status", this.statusParams(s, a, extra));
  }

  /** A transition first reported in a request's result (submit or cancel): sequenced and retained, not sent. */
  private transitionQuiet(s: Session, a: Action, to: ActionState, extra: Json): void {
    this.move(s, a, to, extra);
    a.lastSeq = ++s.statusSeq;
    this.retain(s, this.statusMessage(s, a, extra));
  }

  private move(s: Session, a: Action, to: ActionState, extra: Json): void {
    const from = a.state;
    if (!transition(from, to)) throw new Error(`illegal transition ${from} → ${to} for ${a.id}`);
    a.state = to;
    a.lastTs = this.clock(s);
    a.lastReason = typeof extra.reason === "string" ? extra.reason : undefined;
    if (isTerminal(to)) a.run = undefined;
    this.hooks.changed?.();
  }

  /** A same-state status (progress, stream counters), stamped now. */
  private statusUpdate(s: Session, a: Action, extra: Json): void {
    const params = this.statusParams(s, a, extra);
    params.ts_mono_ns = this.clock(s);
    this.notify(s, "action.status", params);
  }

  private statusParams(s: Session, a: Action, extra: Json): Json {
    const p: Json = { action_id: a.id, state: a.state, status_seq: 0, ts_mono_ns: a.lastTs };
    if (this.mode === "lockstep") p.tick = this.tick;
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p[k] = v;
    if (a.state === "executing" && a.schema.duration === "streaming" && a.stream && p.stream === undefined) p.stream = this.streamStats(a);
    return p;
  }

  private statusMessage(s: Session, a: Action, extra: Json): Json {
    const params = this.statusParams(s, a, extra);
    params.status_seq = a.lastSeq;
    return { jsonrpc: "2.0", method: "action.status", params };
  }

  private liveActions(s: Session): Action[] {
    return [...s.actions.values()].filter((a) => !isTerminal(a.state));
  }

  // ---------------------------------------------------------------------------------------------
  // Reset

  private rpcReset(s: Session, p: Json): Json {
    if (!s.admin.includes("reset")) fail("AWP_FORBIDDEN", "reset is not granted");
    const initial = p.initial_state as string | undefined;
    if (initial !== undefined && !(this.manifest.initial_states ?? []).includes(initial)) fail("AWP_PARAMS_INVALID", `no initial state ${initial}`);
    if (p.seed !== undefined && this.manifest.capabilities?.seed !== true) fail("AWP_PARAMS_INVALID", "this world takes no seed");
    this.resetWorld(s.id, { initialState: initial, seed: p.seed as number | undefined });
    return this.mode === "lockstep" ? { tick: this.tick } : {};
  }

  private resetWorld(initiator: string, opts: { initialState?: string | undefined; seed?: number | undefined }): void {
    const initial = opts.initialState ?? this.initialState;
    const live = [...this.sessions.values()].filter((s) => s.state !== "closed");
    for (const s of live) {
      this.event(s, "world_resetting", { initiator, kind: "reset", initial_state: initial });
      for (const a of this.liveActions(s)) this.finish(s, a, "cancelled", { reason: "world_reset" });
    }
    this.initialState = initial;
    if (opts.seed !== undefined) this.seed = opts.seed;
    this.sim = this.def.createSim({ seed: this.seed, initialState: this.initialState });
    if (this.mode === "lockstep") {
      this.tick = 0;
      for (const s of live) for (const g of s.grants.values()) if (!g.command) this.emitFrame(s, g, false);
    }
    this.hooks.changed?.();
  }

  // ---------------------------------------------------------------------------------------------
  // Session lifecycle

  private rpcResume(c: Conn, p: Json): undefined {
    const problems = validate("session-resume", p, "receiver");
    if (problems.length > 0) throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", problems.join("; "));
    const s = this.byToken.get(p.session_token as string);
    if (!s || s.state === "closed") fail("AWP_SESSION_UNKNOWN", "this world holds no such session");
    if (s.closing) fail("AWP_SESSION_EXPIRED", "the session is closing");
    if (c.session && c.session !== s && c.session.state !== "closed") fail("AWP_SESSION_EXISTS", "this connection already holds a session");
    const last = p.last_status_seq as number;
    if (last > s.statusSeq) throw new AwpFailure(JsonRpcCode.INVALID_PARAMS, "Invalid params", "last_status_seq is ahead of the session");
    if (s.conn && s.conn !== c) {
      const old = s.conn;
      old.session = undefined;
      this.out.push({ kind: "close", conn: old.id, code: 1000, reason: "connection_replaced" });
      s.conn = undefined;
      this.sessionState(s, "suspended", "connection_replaced");
    }
    this.acknowledge(s, last);
    s.conn = c;
    c.session = s;
    s.suspendedAtNs = undefined;
    s.lastAgentNs = this.now;
    const replayTo = s.statusSeq;
    const ready = this.readyObject(s, { replay_to_status_seq: replayTo, safe_state: s.inSafeState });
    this.result(c, this.currentId, "session.resume", ready);
    for (const entry of s.log) if (entry.seq > last) this.sendRaw(c, entry.message);
    s.state = "suspended";
    this.sessionState(s, "active", "resumed");
    for (const g of s.grants.values()) {
      if (g.command) continue;
      if (this.mode === "lockstep") this.emitFrame(s, g, false, true);
      else if (g.decl.loss_class === "reliable") g.resync = true;
    }
    this.hooks.changed?.();
    return undefined;
  }

  private beginClose(s: Session, reason: string, id: Id | undefined): void {
    if (s.closing) {
      if (id !== undefined) s.closing.push(id);
      return;
    }
    s.closing = id === undefined ? [] : [id];
    s.closeReason = reason;
    for (const a of this.liveActions(s)) {
      if (a.state === "executing") {
        this.transition(s, a, "cancelling", { reason: "session_closed" });
        this.startAbort(s, a, "session_closed");
      } else if (a.state === "cancelling") {
        // Close outranks the agent's own cancel while its abort runs (AWP-LIF-008).
        if (precedence("session_closed") < precedence(a.abortReason ?? "cancelled_by_agent")) a.abortReason = "session_closed";
      } else this.finish(s, a, "cancelled", { reason: "session_closed" });
    }
    this.maybeClosed(s);
  }

  private maybeClosed(s: Session): void {
    if (!s.closing || this.liveActions(s).length > 0) return;
    for (const emb of s.embodiments) this.sim.safeStop(emb);
    this.sessionState(s, "closed", s.closeReason === "protocol_error" ? "protocol_error" : s.closeReason);
    const c = s.conn;
    for (const id of s.closing) if (c) this.sendRaw(c, { jsonrpc: "2.0", id, result: {} });
    this.dropSession(s);
  }

  private suspend(s: Session, reason: "connection_lost"): void {
    if (s.state === "closed" || s.state === "suspended") return;
    s.conn = undefined;
    s.suspendedAtNs = this.now;
    if (s.closing) {
      // A closing session that loses its connection ends at once.
      this.maybeClosed(s);
      if (!this.sessions.has(s.id)) return;
    }
    this.sessionState(s, "suspended", reason);
    this.hooks.changed?.();
  }

  private serviceSession(s: Session): void {
    if (s.closing) {
      this.maybeClosed(s);
      return;
    }
    if (s.state === "suspended" && s.suspendedAtNs !== undefined && this.now - s.suspendedAtNs > this.windowMs * 1e6) {
      if (this.watchdogMs !== undefined && !s.inSafeState && !s.observer) this.enterSafeState(s);
      for (const a of this.liveActions(s)) this.finish(s, a, "cancelled", { reason: "session_closed" });
      for (const emb of s.embodiments) this.sim.safeStop(emb);
      this.sessionState(s, "closed", "window_expired");
      this.dropSession(s);
    }
  }

  private serviceConn(c: Conn): void {
    const s = c.session;
    if (s && s.conn === c && s.state !== "closed") {
      if (this.now - c.lastPingSentNs >= this.heartbeatMs * 1e6) {
        c.lastPingSentNs = this.now;
        this.sendRaw(c, { jsonrpc: "2.0", id: `w${++c.pingId}`, method: "ping", params: { origin_ns: this.clock(s) } });
      }
      if (this.now - c.lastRecvNs > 3 * this.heartbeatMs * 1e6) {
        this.out.push({ kind: "close", conn: c.id, code: 1001, reason: "heartbeat lost" });
        this.conns.delete(c.id);
        this.suspend(s, "connection_lost");
      }
    } else if (this.now - c.lastRecvNs > Math.max(15000, 3 * this.heartbeatMs) * 1e6) {
      this.out.push({ kind: "close", conn: c.id, code: 1000, reason: "idle" });
      this.conns.delete(c.id);
    }
  }

  private dropSession(s: Session): void {
    s.state = "closed";
    this.sessions.delete(s.id);
    this.byToken.delete(s.token);
    if (s.conn) s.conn.session = undefined;
    this.hooks.changed?.();
  }

  private activate(s: Session): void {
    if (s.state === "ready") this.sessionState(s, "active", "first_activity");
  }

  private sessionState(s: Session, state: Session["state"], reason: string): void {
    s.state = state;
    this.notify(s, "session.state", { state, status_seq: 0, ts_mono_ns: this.clock(s), reason });
  }

  private event(s: Session, event: string, detail: Json): void {
    const params: Json = { event, status_seq: 0, ts_mono_ns: this.clock(s), detail };
    if (this.mode === "lockstep") params.tick = this.tick;
    this.notify(s, "world.event", params);
  }

  // ---------------------------------------------------------------------------------------------
  // Frames

  private emitFrame(s: Session, g: Grant, streaming: boolean, resync = false): void {
    if (!s.conn) return;
    let payload: unknown;
    try {
      payload = this.sim.observe(g.channel);
    } catch {
      return;
    }
    g.seq += 1;
    g.lastDeliveredNs = this.now;
    g.degraded = false;
    const wantResync = resync || g.resync;
    g.resync = false;
    const params: Json = {
      channel_id: g.channelId,
      seq: g.seq,
      ts_mono_ns: this.clock(s),
      flags: wantResync ? 0b1001 : 0b0001,
      payload_b64: jsonPayloadB64(payload),
    };
    if (this.mode === "lockstep") params.tick = this.tick;
    const message = { jsonrpc: "2.0", method: "obs.frame", params };
    if (this.validateOut) this.check("frame-inline", params, message);
    this.audit(s, "out", "frame", { channel_id: g.channelId, seq: g.seq, ts_mono_ns: params.ts_mono_ns, tick: params.tick, payload_sha256: sha256Hex(params.payload_b64 as string) });
    this.out.push({
      kind: "send",
      conn: s.conn.id,
      message,
      frame: { session: s.id, key: `${s.id}:${g.channelId}`, latestWins: streaming && g.decl.loss_class === "latest-wins", streaming },
    });
    if (streaming) this.activate(s);
  }

  // ---------------------------------------------------------------------------------------------
  // Messaging

  private notify(s: Session, method: string, params: Json): number {
    params.status_seq = ++s.statusSeq;
    const message = { jsonrpc: "2.0", method, params };
    this.retain(s, message);
    if (s.conn) this.sendTo(s, s.conn, message);
    return params.status_seq as number;
  }

  private notifyUnsequenced(s: Session, method: string, params: Json): void {
    if (s.conn) this.sendTo(s, s.conn, { jsonrpc: "2.0", method, params });
  }

  private retain(s: Session, message: Json): void {
    s.log.push({ seq: (message.params as Json).status_seq as number, message });
  }

  private acknowledge(s: Session, seq: number): void {
    s.acked = Math.max(s.acked, seq);
    // Acknowledged notifications may be discarded (AWP-CTL-010).
    if (s.log.length > 0 && s.log[0]!.seq <= s.acked) s.log = s.log.filter((e) => e.seq > s.acked);
  }

  private result(c: Conn, id: Id, method: string, result: unknown): void {
    const message = { jsonrpc: "2.0", id, result };
    if (this.validateOut && RESULT_SCHEMA[method]) this.check(RESULT_SCHEMA[method], result, message);
    this.sendRaw(c, message);
  }

  private error(c: Conn, id: Id, name: ErrorName, detail: string): void {
    this.sendRaw(c, { jsonrpc: "2.0", id, error: { code: ErrorCode[name], message: name, data: { retryable: false, detail } } });
  }

  private sendRaw(c: Conn, message: Json): void {
    const s = c.session;
    if (s && s.conn === c) {
      this.sendTo(s, c, message);
      return;
    }
    this.out.push({ kind: "send", conn: c.id, message });
  }

  private sendTo(s: Session, c: Conn, message: Json): void {
    if (this.validateOut && typeof message.method === "string" && NOTIFICATION_SCHEMA[message.method]) {
      this.check(NOTIFICATION_SCHEMA[message.method]!, message.params, message);
    }
    this.audit(s, "out", "control", message);
    this.out.push({ kind: "send", conn: c.id, message });
  }

  private check(schema: string, value: unknown, message: unknown): void {
    const problems = validate(schema, value, "sender");
    if (problems.length > 0) this.hooks.invalid?.(schema, problems, message);
  }

  private audit(s: Session, direction: AuditRecord["direction"], kind: string, body: unknown, cls?: string): void {
    if (!this.hooks.audit) return;
    const record: AuditRecord = { ts_mono_ns: this.clock(s), direction, kind, body: redact(body) };
    if (cls) record.class = cls;
    if (s.auditHash) record.prev_hash = s.auditHash;
    s.auditHash = sha256Hex(JSON.stringify(record));
    this.hooks.audit(s.id, record);
  }

  private clock(s: Session): number {
    if (s.mode === "lockstep") return (this.advances - s.advancesAtOpen) * this.tickNs;
    return Math.max(0, this.now - s.originNs);
  }

  private drain(): HostOutput[] {
    const out = this.out;
    this.out = [];
    return out;
  }
}

/** Terminating causes, strongest first (AWP-LIF-008). */
const PRECEDENCE = ["e_stop", "safe_state", "connection_lost", "world_reset", "session_closed", "transferred", "cancelled_by_agent"];

function precedence(reason: string): number {
  const i = PRECEDENCE.indexOf(reason);
  return i < 0 ? PRECEDENCE.length : i;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

const IDENTITY_FIELDS = ["type", "params", "embodiment_id", "preempt", "deadline_ms", "basis_ts_mono_ns", "valid_until_ns"];

const KNOWN_METHODS = new Set([
  "world.manifest",
  "session.open",
  "session.resume",
  "session.close",
  "obs.subscribe",
  "obs.unsubscribe",
  "action.submit",
  "action.cancel",
  "action.status",
  "world.tick",
  "world.reset",
  "task.update",
]);

const PARAMS_SCHEMA: Record<string, string> = {
  "action.submit": "action-submit",
  "action.cancel": "action-ref",
  "action.status": "action-ref",
  "obs.subscribe": "subscribe",
  "obs.unsubscribe": "unsubscribe",
  "world.tick": "tick",
  "world.reset": "reset",
  "task.update": "task-update",
};

const RESULT_SCHEMA: Record<string, string> = {
  initialize: "world-manifest",
  "world.manifest": "world-manifest",
  "session.open": "session-ready",
  "session.resume": "session-ready",
  "session.close": "empty-result",
  ping: "ping-result",
  "action.submit": "action-submit-result",
  "action.cancel": "action-cancel-result",
  "action.status": "action-status",
  "obs.subscribe": "subscribe-result",
  "obs.unsubscribe": "subscribe-result",
  "world.tick": "tick-result",
  "world.reset": "reset-result",
  "task.update": "empty-result",
};

const NOTIFICATION_SCHEMA: Record<string, string> = {
  "action.status": "action-status",
  "world.event": "world-event",
  "session.state": "session-state",
  "session.telemetry": "session-telemetry",
};
