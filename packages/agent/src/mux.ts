/**
 * The control mux: one AWP session, several controllers, one authority at a time.
 *
 * Arbitration: the highest-priority enabled controller that is engaged (or pinned by the operator)
 * holds authority. On a handoff the mux cancels the previous holder's live actions, so the world's
 * own lifecycle shows the change. In lockstep the mux also owns time: it advances while the
 * authority wants time to flow, and never while an `on-wait` controller is thinking.
 */
import { type ActivityEntry, type ControllerState, REDACTED } from "@awp-demo/inspector";
import { type ActionRecord, type AwpClient, AwpError, isTerminal, jsonPayload, type WorldManifest } from "@hyperduality/awp";
import { z } from "zod";
import {
  type ControlContext,
  type Controller,
  type ControllerInstance,
  DEFAULT_PRIORITY,
  type HistoryEntry,
  type LogInput,
  NotInControlError,
  type SubmitOptions,
} from "./controller.ts";

export interface MuxOutputs {
  activity(entry: ActivityEntry): void;
  controllers(list: ControllerState[]): void;
  changed(): void;
}

interface Slot {
  def: Controller<unknown>;
  priority: number;
  time: "continuous" | "on-wait";
  enabled: boolean;
  engaged: boolean;
  pinned: boolean;
  config: unknown;
  secrets: Set<string>;
  schema: unknown;
  status: string | undefined;
  instance: ControllerInstance<unknown> | undefined;
  abort: AbortController | undefined;
  authorityWaiters: (() => void)[];
}

interface Tracked {
  source: string;
  rec: ActionRecord;
  type: string;
  params: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ControlMux {
  client: AwpClient | undefined;
  manifest: WorldManifest | undefined;
  authority: string | null = null;
  readonly clock = { paused: false, rateHz: 20, waiting: 0 };

  private readonly slots = new Map<string, Slot>();
  private readonly out: MuxOutputs;
  private readonly latestPayload = new Map<string, unknown>();
  private readonly frameListeners = new Map<string, Set<(p: unknown) => void>>();
  private observationWaiters: (() => void)[] = [];
  private tickListeners = new Set<() => void>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly historyLog: HistoryEntry[] = [];
  private stepRequests = 0;
  private poke: (() => void) | undefined;
  private pacing = false;
  private actionCounter = 0;
  private readonly runId = Math.random().toString(36).slice(2, 6);
  private tickNs = 50e6;
  private lastTickTs: number | undefined;
  private entryCounter = 0;
  private detachers: (() => void)[] = [];

  constructor(controllers: Controller<unknown>[], out: MuxOutputs, clock?: { rateHz?: number; paused?: boolean }) {
    this.out = out;
    if (clock?.rateHz !== undefined) this.clock.rateHz = clock.rateHz;
    if (clock?.paused !== undefined) this.clock.paused = clock.paused;
    for (const def of controllers) {
      const schema = z.toJSONSchema(def.config, { io: "input", unrepresentable: "any" }) as {
        properties?: Record<string, { "x-secret"?: boolean }>;
      };
      const secrets = new Set(Object.entries(schema.properties ?? {}).filter(([, v]) => v["x-secret"]).map(([k]) => k));
      this.slots.set(def.id, {
        def,
        priority: def.priority ?? DEFAULT_PRIORITY[def.kind],
        time: def.time ?? (def.kind === "llm" ? "on-wait" : "continuous"),
        enabled: def.enabled ?? true,
        engaged: false,
        pinned: false,
        config: def.config.parse({}),
        secrets,
        schema,
        status: undefined,
        instance: undefined,
        abort: undefined,
        authorityWaiters: [],
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Session binding

  attach(client: AwpClient): void {
    this.client = client;
    this.manifest = client.manifest?.raw;
    this.lastTickTs = undefined;
    const onFrame = (name: string, frame: Parameters<typeof jsonPayload>[0]) => {
      let payload: unknown;
      try {
        payload = jsonPayload(frame);
      } catch {
        return;
      }
      this.latestPayload.set(name, payload);
      if (client.mode === "lockstep" && typeof frame.ts_mono_ns === "number") {
        if (this.lastTickTs !== undefined && frame.ts_mono_ns > this.lastTickTs) this.tickNs = frame.ts_mono_ns - this.lastTickTs;
        this.lastTickTs = Math.max(this.lastTickTs ?? 0, frame.ts_mono_ns);
      }
      for (const fn of this.frameListeners.get(name) ?? []) fn(payload);
      if (client.mode === "streaming") this.flushObservationWaiters();
    };
    const onStatus = (rec: ActionRecord) => this.onStatus(rec);
    const onEvent = (e: { event: string; detail?: Record<string, unknown> }) => {
      this.emit({
        source: "world",
        kind: "event",
        title: EVENT_TITLES[e.event] ?? e.event,
        detail: e.detail ? describeDetail(e.detail) : undefined,
        data: e,
      });
    };
    client.on("frame", onFrame);
    client.on("status", onStatus);
    client.on("event", onEvent);
    this.detachers = [
      () => client.off("frame", onFrame),
      () => client.off("status", onStatus),
      () => client.off("event", onEvent),
    ];
    for (const ch of client.channels.values()) {
      const f = ch.tracker.latest;
      if (f) onFrame(ch.grant.channel, f.frame);
    }
    for (const slot of this.slots.values()) if (slot.enabled) this.startSlot(slot);
    this.publish();
    if (client.mode === "lockstep") void this.pace();
  }

  detach(): void {
    for (const slot of this.slots.values()) this.stopSlot(slot);
    for (const d of this.detachers) d();
    this.detachers = [];
    this.client = undefined;
    this.authority = null;
    this.tracked.clear();
    this.flushObservationWaiters();
    this.wake();
    this.publish();
  }

  // ---------------------------------------------------------------------------------------------
  // Operator commands

  enable(id: string, enabled: boolean): void {
    const slot = this.slot(id);
    if (slot.enabled === enabled) return;
    slot.enabled = enabled;
    if (enabled) this.startSlot(slot);
    else this.stopSlot(slot);
    this.recompute();
    this.publish();
  }

  configure(id: string, patch: Record<string, unknown>): void {
    const slot = this.slot(id);
    const current = slot.config as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (slot.secrets.has(k) && v === REDACTED) continue;
      merged[k] = v === "" && slot.secrets.has(k) ? undefined : v;
    }
    slot.config = slot.def.config.parse(merged);
    slot.instance?.configure?.(slot.config);
    this.publish();
  }

  take(id: string): void {
    for (const s of this.slots.values()) s.pinned = false;
    const slot = this.slot(id);
    if (!slot.enabled) this.enable(id, true);
    slot.pinned = true;
    this.recompute();
    this.publish();
  }

  release(id: string): void {
    const slot = this.slot(id);
    slot.pinned = false;
    this.recompute();
    this.publish();
  }

  input(id: string, input: unknown): void {
    this.slot(id).instance?.input?.(input);
  }

  message(id: string, text: string): void {
    const slot = this.slot(id);
    if (!slot.enabled) this.enable(id, true);
    this.emit({ source: "operator", kind: "message", title: text });
    slot.instance?.message?.(text);
  }

  interrupt(id: string): void {
    this.slot(id).instance?.interrupt?.();
  }

  setPaused(paused: boolean): void {
    this.clock.paused = paused;
    this.wake();
    this.out.changed();
  }

  setRate(hz: number): void {
    this.clock.rateHz = hz;
    this.wake();
    this.out.changed();
  }

  step(): void {
    this.stepRequests += 1;
    this.wake();
  }

  controllerStates(): ControllerState[] {
    return [...this.slots.values()].map((s) => ({
      id: s.def.id,
      kind: s.def.kind,
      label: s.def.label,
      description: s.def.description,
      priority: s.priority,
      time: s.time,
      enabled: s.enabled,
      engaged: s.engaged,
      authority: this.authority === s.def.id,
      pinned: s.pinned,
      status: s.status,
      config: redactConfig(s.config, s.secrets),
      configSchema: s.schema,
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Controllers

  private slot(id: string): Slot {
    const s = this.slots.get(id);
    if (!s) throw new Error(`no controller ${id}`);
    return s;
  }

  private startSlot(slot: Slot): void {
    if (!this.client || slot.instance) return;
    slot.abort = new AbortController();
    const ctx = this.context(slot, slot.abort.signal);
    try {
      slot.instance = slot.def.create(ctx);
    } catch (e) {
      this.emit({ source: slot.def.id, kind: "error", title: `${slot.def.label} failed to start`, detail: String(e) });
    }
  }

  private stopSlot(slot: Slot): void {
    slot.abort?.abort();
    slot.abort = undefined;
    try {
      slot.instance?.stop?.();
    } catch {
      /* ignore */
    }
    slot.instance = undefined;
    slot.engaged = false;
    slot.pinned = false;
    slot.status = undefined;
    for (const w of slot.authorityWaiters.splice(0)) w();
  }

  private setEngaged(slot: Slot, engaged: boolean): void {
    if (slot.engaged === engaged) return;
    slot.engaged = engaged;
    this.recompute();
    this.publish();
  }

  private recompute(): void {
    const candidates = [...this.slots.values()].filter((s) => s.enabled && s.abort && (s.pinned || s.engaged));
    const next = candidates.find((s) => s.pinned) ?? candidates.sort((a, b) => b.priority - a.priority)[0];
    const nextId = next?.def.id ?? null;
    if (nextId === this.authority) return;
    const prev = this.authority ? this.slots.get(this.authority) : undefined;
    this.authority = nextId;
    if (prev) {
      for (const t of this.tracked.values()) {
        if (t.source === prev.def.id && !t.rec.terminal) this.client?.cancel(t.rec.action_id).catch(() => undefined);
      }
    }
    const title = next
      ? prev
        ? `${next.def.label} took control from ${prev.def.label}`
        : `${next.def.label} took control`
      : `${prev?.def.label ?? "Controller"} released control`;
    this.emit({ source: "mux", kind: "handoff", title, data: { from: prev?.def.id ?? null, to: nextId } });
    prev?.instance?.authority?.(false);
    if (next) {
      next.instance?.authority?.(true);
      for (const w of next.authorityWaiters.splice(0)) w();
    }
    this.wake();
  }

  private context(slot: Slot, signal: AbortSignal): ControlContext<unknown> {
    const mux = this;
    const id = slot.def.id;
    return {
      id,
      get manifest() {
        return mux.manifest!;
      },
      get mode() {
        return mux.client?.mode ?? "streaming";
      },
      get embodiments() {
        return mux.client?.embodiments ?? [];
      },
      signal,
      get config() {
        return slot.config;
      },
      get tickMs() {
        return mux.tickNs / 1e6;
      },
      latest: <T>(channel: string) => mux.latestPayload.get(channel) as T | undefined,
      onFrame: <T>(channel: string, fn: (p: T) => void) => {
        let set = mux.frameListeners.get(channel);
        if (!set) mux.frameListeners.set(channel, (set = new Set()));
        const f = fn as (p: unknown) => void;
        set.add(f);
        const off = () => set.delete(f);
        signal.addEventListener("abort", off, { once: true });
        return off;
      },
      nextObservation: () => mux.nextObservation(signal),
      get hasAuthority() {
        return mux.authority === id;
      },
      engage: () => mux.setEngaged(slot, true),
      release: () => mux.setEngaged(slot, false),
      acquire: async () => {
        mux.setEngaged(slot, true);
        await mux.awaitAuthority(slot, signal);
      },
      submit: (type, params, opts) => mux.submit(slot, signal, type, params, opts),
      cancel: async (actionId) => {
        await mux.client?.cancel(actionId);
      },
      command: async (channel, payload) => {
        if (mux.authority !== id) return;
        await mux.client?.sendCommandFrame(channel, new TextEncoder().encode(JSON.stringify(payload)));
      },
      settle: (rec, opts) => mux.settle(rec, signal, opts),
      wait: (opts) => mux.wait(signal, opts),
      history: (limit = 50) => mux.historyLog.slice(-limit),
      log: (entry: LogInput) => mux.emit({ ...entry, source: id }),
      status: (text) => {
        if (slot.status === text) return;
        slot.status = text;
        mux.publish();
      },
    };
  }

  private async awaitAuthority(slot: Slot, signal: AbortSignal): Promise<void> {
    while (this.authority !== slot.def.id) {
      if (signal.aborted) throw new DOMException("stopped", "AbortError");
      if (!slot.engaged) throw new NotInControlError(slot.def.id);
      await new Promise<void>((r) => slot.authorityWaiters.push(r));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Actions

  private async submit(
    slot: Slot,
    signal: AbortSignal,
    type: string,
    params: Record<string, unknown>,
    opts: SubmitOptions = {},
  ): Promise<ActionRecord> {
    await this.awaitAuthority(slot, signal);
    const client = this.client;
    if (!client) throw new Error("no session");
    const actionId = `${slot.def.id}-${this.runId}-${++this.actionCounter}`;
    const entryId = `act:${actionId}`;
    const detail = summarize(params);
    this.emit({ id: entryId, source: slot.def.id, kind: "action", title: type, detail, actionId, state: "submitted", data: { params } });
    try {
      const rec = await client.submit(type, params, {
        actionId,
        ...(opts.embodiment ? { embodimentId: opts.embodiment } : {}),
        ...(opts.preempt ? { preempt: opts.preempt } : {}),
        ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
      });
      this.tracked.set(actionId, { source: slot.def.id, rec, type, params });
      this.onStatus(rec);
      return rec;
    } catch (e) {
      const reason = e instanceof AwpError ? e.errorName : e instanceof Error ? e.message : String(e);
      const why = e instanceof AwpError ? (e.detail ?? e.errorName) : reason;
      this.emit({ id: entryId, source: slot.def.id, kind: "action", title: type, detail, actionId, state: "rejected", data: { params, reason, error: why } });
      this.remember({ actionId, source: slot.def.id, type, params, state: "rejected", reason: why, ts: Date.now() });
      throw e;
    }
  }

  private onStatus(rec: ActionRecord): void {
    const t = this.tracked.get(rec.action_id);
    if (!t) return;
    this.emit({
      id: `act:${rec.action_id}`,
      source: t.source,
      kind: "action",
      title: t.type,
      detail: summarize(t.params),
      actionId: rec.action_id,
      state: rec.state,
      data: { params: t.params, reason: rec.reason, progress: rec.progress },
    });
    if (isTerminal(rec.state)) {
      this.remember({ actionId: rec.action_id, source: t.source, type: t.type, params: t.params, state: rec.state, reason: rec.reason, ts: Date.now() });
      this.wake();
    }
  }

  private remember(h: HistoryEntry): void {
    this.historyLog.push(h);
    if (this.historyLog.length > 500) this.historyLog.splice(0, this.historyLog.length - 500);
  }

  // ---------------------------------------------------------------------------------------------
  // Time

  private async settle(rec: ActionRecord, signal: AbortSignal, opts: { maxTicks?: number; timeoutMs?: number } = {}): Promise<ActionRecord> {
    if (rec.terminal || rec.lost) return rec;
    const client = this.client;
    if (!client) return rec;
    if (client.mode === "streaming") {
      await Promise.race([rec.settled(), sleep(opts.timeoutMs ?? 30000), abortPromise(signal)]);
      return rec;
    }
    const maxTicks = opts.maxTicks ?? 2000;
    let ticks = 0;
    this.clock.waiting += 1;
    this.wake();
    try {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.tickListeners.delete(onTick);
          resolve();
        };
        const onTick = () => {
          ticks += 1;
          if (rec.terminal || rec.lost || ticks >= maxTicks || signal.aborted) done();
        };
        this.tickListeners.add(onTick);
        void rec.settled().then(done);
        signal.addEventListener("abort", done, { once: true });
      });
    } finally {
      this.clock.waiting -= 1;
    }
    return rec;
  }

  private async wait(signal: AbortSignal, opts: { ticks?: number; ms?: number }): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (client.mode === "streaming") {
      const ms = opts.ms ?? (opts.ticks ?? 1) * (this.tickNs / 1e6);
      await Promise.race([sleep(ms), abortPromise(signal)]);
      return;
    }
    const n = opts.ticks ?? Math.max(1, Math.ceil((opts.ms ?? 0) / (this.tickNs / 1e6)));
    let seen = 0;
    this.clock.waiting += 1;
    this.wake();
    try {
      await new Promise<void>((resolve) => {
        const onTick = () => {
          seen += 1;
          if (seen >= n || signal.aborted) {
            this.tickListeners.delete(onTick);
            resolve();
          }
        };
        this.tickListeners.add(onTick);
        signal.addEventListener(
          "abort",
          () => {
            this.tickListeners.delete(onTick);
            resolve();
          },
          { once: true },
        );
      });
    } finally {
      this.clock.waiting -= 1;
    }
  }

  private nextObservation(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      this.observationWaiters.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  private flushObservationWaiters(): void {
    const ws = this.observationWaiters;
    this.observationWaiters = [];
    for (const w of ws) w();
  }

  /** Lockstep pacer: the only caller of world.tick. */
  private async pace(): Promise<void> {
    if (this.pacing) return;
    this.pacing = true;
    try {
      while (this.client && this.client.mode === "lockstep") {
        const client = this.client;
        const holder = this.authority ? this.slots.get(this.authority) : undefined;
        const wantsTime = holder !== undefined && (holder.time === "continuous" || this.clock.waiting > 0);
        const step = this.stepRequests > 0;
        if (!step && (this.clock.paused || !wantsTime)) {
          await new Promise<void>((r) => {
            this.poke = r;
            setTimeout(r, 250);
          });
          continue;
        }
        if (step) this.stepRequests -= 1;
        const started = Date.now();
        try {
          await client.advance(1);
        } catch (e) {
          if (this.client !== client) break;
          this.emit({ source: "mux", kind: "error", title: "Advance failed", detail: e instanceof Error ? e.message : String(e) });
          await sleep(500);
          continue;
        }
        for (const fn of [...this.tickListeners]) fn();
        this.flushObservationWaiters();
        this.out.changed();
        const period = this.clock.rateHz > 0 ? 1000 / this.clock.rateHz : 0;
        const rest = period - (Date.now() - started);
        if (rest > 0) await sleep(rest);
        else await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.pacing = false;
    }
  }

  private wake(): void {
    const p = this.poke;
    this.poke = undefined;
    p?.();
  }

  // ---------------------------------------------------------------------------------------------
  // Output

  private emit(entry: LogInput & { source: string }): string {
    const id = entry.id ?? `e${++this.entryCounter}`;
    this.out.activity({ ts: Date.now(), ...entry, id } as ActivityEntry);
    return id;
  }

  private publish(): void {
    this.out.controllers(this.controllerStates());
    this.out.changed();
  }
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function redactConfig(config: unknown, secrets: Set<string>): unknown {
  if (!config || typeof config !== "object") return config;
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const k of secrets) if (out[k]) out[k] = REDACTED;
  return out;
}

/** A compact one-line rendering of action params. */
export function summarize(params: Record<string, unknown>): string {
  const parts = Object.entries(params).map(([k, v]) => `${k} ${formatValue(v)}`);
  return parts.join(" · ");
}

function formatValue(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (Array.isArray(v)) return `[${v.map(formatValue).join(", ")}]`;
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function describeDetail(d: Record<string, unknown>): string | undefined {
  const parts = Object.entries(d)
    .filter(([k]) => k !== "embodiment" || Object.keys(d).length === 1)
    .map(([k, v]) => `${k} ${formatValue(v)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

const EVENT_TITLES: Record<string, string> = {
  safe_state_entered: "Safe state entered",
  safe_state_exited: "Safe state exited",
  e_stop_engaged: "E-stop engaged",
  e_stop_released: "E-stop released",
  world_resetting: "World reset",
  channel_degraded: "Channel degraded",
  envelope_violation: "Envelope violation",
  collision: "Collision",
  entity_appeared: "Entity appeared",
  entity_removed: "Entity removed",
};
