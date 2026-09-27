/** The browser side of the inspector: one client per process, reconnecting, with batched updates. */
import type { ClientMessage, ServerMessage, StreamEvent, TopicInfo } from "./contract.ts";

export type ConnectionState = "connecting" | "open" | "closed";

type Listener = () => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface InspectorClientOptions {
  /** Keep at most this many items per stream topic (default 5000). */
  capacity?: number;
}

export class InspectorClient {
  readonly url: string;
  private ws: WebSocket | undefined;
  private state: ConnectionState = "connecting";
  private readonly values = new Map<string, unknown>();
  private readonly infos = new Map<string, TopicInfo>();
  private readonly keyIndex = new Map<string, Map<string, number>>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly dirty = new Set<string>();
  private readonly pending = new Map<number, Pending>();
  private readonly capacity: number;
  private nextId = 1;
  private frame: number | undefined;
  private retryMs = 250;
  private stopped = false;
  processName: "world" | "agent" | undefined;

  constructor(url: string, opts: InspectorClientOptions = {}) {
    this.url = url;
    this.capacity = opts.capacity ?? 5000;
    this.open();
  }

  get connection(): ConnectionState {
    return this.state;
  }

  /** The current value of a topic: a state value, or a stream's item array. */
  get<T>(topic: string): T | undefined {
    return this.values.get(topic) as T | undefined;
  }

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  command<T = unknown>(name: string, args?: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    const m: ClientMessage = { t: "cmd", id, name, args };
    ws.send(JSON.stringify(m));
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private open(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 250;
      this.setState("open");
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      this.setState("closed");
      if (!this.stopped) setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 3000);
    };
  }

  private onMessage(m: ServerMessage): void {
    switch (m.t) {
      case "hello":
        this.processName = m.process;
        for (const t of m.topics) this.infos.set(t.name, t);
        return;
      case "snap": {
        const info = this.infos.get(m.topic);
        if (info?.kind === "stream") {
          const items = (m.data as StreamEvent<unknown>).items.slice(-this.capacity);
          this.values.set(m.topic, items);
          if (info.keyed) this.reindex(m.topic, items);
        } else this.values.set(m.topic, m.data);
        this.markDirty(m.topic);
        return;
      }
      case "ev": {
        const info = this.infos.get(m.topic);
        if (info?.kind === "stream") this.applyStream(m.topic, info, m.data as StreamEvent<unknown>);
        else this.values.set(m.topic, m.data);
        this.markDirty(m.topic);
        return;
      }
      case "res": {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(m.error));
        return;
      }
    }
  }

  private applyStream(topic: string, info: TopicInfo, ev: StreamEvent<unknown>): void {
    let items = ev.clear ? [] : [...((this.values.get(topic) as unknown[] | undefined) ?? [])];
    if (!info.keyed) {
      items.push(...ev.items);
    } else {
      const index = ev.clear ? new Map<string, number>() : (this.keyIndex.get(topic) ?? new Map<string, number>());
      for (const item of ev.items) {
        const k = (item as { id: string }).id;
        const at = index.get(k);
        if (at !== undefined && items[at] !== undefined && (items[at] as { id: string }).id === k) items[at] = item;
        else {
          index.set(k, items.length);
          items.push(item);
        }
      }
      this.keyIndex.set(topic, index);
    }
    if (items.length > this.capacity) {
      items = items.slice(items.length - this.capacity);
      if (info.keyed) this.reindex(topic, items);
    }
    this.values.set(topic, items);
  }

  private reindex(topic: string, items: unknown[]): void {
    this.keyIndex.set(topic, new Map(items.map((x, i) => [(x as { id: string }).id, i])));
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.markDirty("$connection");
  }

  private markDirty(topic: string): void {
    this.dirty.add(topic);
    if (this.frame !== undefined) return;
    const run = () => {
      this.frame = undefined;
      const topics = [...this.dirty];
      this.dirty.clear();
      for (const t of topics) for (const fn of this.listeners.get(t) ?? []) fn();
    };
    this.frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : (setTimeout(run, 16) as unknown as number);
  }
}
