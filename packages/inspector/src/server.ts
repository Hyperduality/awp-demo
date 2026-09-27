/** The Node side of the inspector: topics the UI subscribes to, commands it may send. Loopback only. */
import { type WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage, StreamEvent, TopicInfo } from "./contract.ts";

export interface InspectorServerOptions {
  port: number;
  host?: string;
  process: "world" | "agent";
}

type Handler = (args: unknown) => unknown | Promise<unknown>;

export interface StateTopic<T> {
  get(): T;
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

export interface StreamTopic<T> {
  push(...items: T[]): void;
  /** Keyed streams: replace the item with the same id, or append it. */
  upsert(item: T): void;
  clear(): void;
  items(): readonly T[];
}

export interface InspectorServer {
  readonly port: number;
  state<T>(name: string, initial: T, opts?: { throttleMs?: number }): StateTopic<T>;
  stream<T>(name: string, opts?: { capacity?: number; key?: (item: T) => string; flushMs?: number }): StreamTopic<T>;
  handle(name: string, fn: Handler): void;
  close(): Promise<void>;
}

export async function createInspectorServer(opts: InspectorServerOptions): Promise<InspectorServer> {
  const wss = new WebSocketServer({ port: opts.port, host: opts.host ?? "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const clients = new Set<WebSocket>();
  const snapshots = new Map<string, () => unknown>();
  const infos = new Map<string, TopicInfo>();
  const handlers = new Map<string, Handler>();

  const send = (ws: WebSocket, m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const broadcast = (m: ServerMessage) => {
    if (clients.size === 0) return;
    const text = JSON.stringify(m);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(text);
  };

  wss.on("connection", (ws) => {
    clients.add(ws);
    send(ws, { t: "hello", process: opts.process, topics: [...infos.values()] });
    for (const [topic, snap] of snapshots) send(ws, { t: "snap", topic, data: snap() });
    ws.on("message", async (raw) => {
      let m: ClientMessage;
      try {
        m = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (m.t !== "cmd") return;
      const h = handlers.get(m.name);
      if (!h) {
        send(ws, { t: "res", id: m.id, ok: false, error: `unknown command ${m.name}` });
        return;
      }
      try {
        const data = await h(m.args);
        send(ws, { t: "res", id: m.id, ok: true, data });
      } catch (e) {
        send(ws, { t: "res", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  return {
    port: (wss.address() as { port: number }).port,

    state<T>(name: string, initial: T, o: { throttleMs?: number } = {}): StateTopic<T> {
      let value = initial;
      let timer: NodeJS.Timeout | undefined;
      let last = 0;
      snapshots.set(name, () => value);
      infos.set(name, { name, kind: "state", keyed: false });
      const flush = () => {
        timer = undefined;
        last = Date.now();
        broadcast({ t: "ev", topic: name, data: value });
      };
      const schedule = () => {
        const wait = (o.throttleMs ?? 0) - (Date.now() - last);
        if (wait <= 0 && !timer) flush();
        else if (!timer) timer = setTimeout(flush, Math.max(0, wait));
      };
      return {
        get: () => value,
        set(v) {
          value = v;
          schedule();
        },
        update(fn) {
          value = fn(value);
          schedule();
        },
      };
    },

    stream<T>(name: string, o: { capacity?: number; key?: (item: T) => string; flushMs?: number } = {}): StreamTopic<T> {
      const capacity = o.capacity ?? 2000;
      let items: T[] = [];
      let pending: T[] = [];
      let timer: NodeJS.Timeout | undefined;
      snapshots.set(name, () => ({ items }) satisfies StreamEvent<T>);
      infos.set(name, { name, kind: "stream", keyed: o.key !== undefined });
      const flush = () => {
        timer = undefined;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        broadcast({ t: "ev", topic: name, data: { items: batch } satisfies StreamEvent<T> });
      };
      const queue = (item: T) => {
        pending.push(item);
        if (!timer) timer = setTimeout(flush, o.flushMs ?? 33);
      };
      const trim = () => {
        if (items.length > capacity) items = items.slice(items.length - capacity);
      };
      return {
        push(...add) {
          items.push(...add);
          trim();
          for (const i of add) queue(i);
        },
        upsert(item) {
          const k = o.key?.(item);
          const idx = k === undefined ? -1 : items.findLastIndex((x) => o.key!(x) === k);
          if (idx >= 0) items[idx] = item;
          else {
            items.push(item);
            trim();
          }
          if (k !== undefined) {
            const p = pending.findIndex((x) => o.key!(x) === k);
            if (p >= 0) {
              pending[p] = item;
              return;
            }
          }
          queue(item);
        },
        clear() {
          items = [];
          pending = [];
          broadcast({ t: "ev", topic: name, data: { items: [], clear: true } satisfies StreamEvent<T> });
        },
        items: () => items,
      };
    },

    handle(name, fn) {
      handlers.set(name, fn);
    },

    close() {
      for (const ws of clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
