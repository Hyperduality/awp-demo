/**
 * A learned policy as a controller: frames go to a policy server over a WebSocket, and the device input
 * it answers is submitted as `input_chunk`. The server speaks one JSON message per request:
 *
 *   {"type": "reset"}                              -> {"type": "reset"}         its memory starts over
 *   {"type": "config", "delay_ms": 300}            -> {"type": "config", ...}   added inference delay
 *   {"type": "act", "id": 7, "frame_b64": "..."}   -> {"type": "slots", "id": 7, "slots": [...], "latency_ms": 9}
 */
import { z } from "zod";
import type { ControlContext, Controller, ControllerInstance } from "./controller.ts";

export const PolicyConfig = z.object({
  url: z.string().default("ws://127.0.0.1:8716").meta({ title: "Policy Server" }),
  delayMs: z.number().int().min(0).max(5000).default(0).meta({
    title: "Inference Delay (ms)",
    description: "Added to every decision, as a slower policy or a slower machine would add it.",
  }),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

/** One slot of device input, as `input_chunk` takes it. */
export interface PolicySlot {
  keys?: string[];
  mouse_dx?: number;
  mouse_dy?: number;
  [field: string]: unknown;
}

export interface PolicyControllerOptions {
  id?: string;
  label?: string;
  description: string;
  enabled?: boolean;
  /** The binary channel (an image, say) whose frames the policy sees. */
  channel: string;
  /** The world's fixed `slot_ms`: one slot per decision. */
  slotMs: number;
  /** Streaming: how long a decision stays valid after the frame it rests on (default 100 ms). */
  validForMs?: number;
}

interface Reply {
  type: string;
  id?: number;
  slots?: PolicySlot[];
  latency_ms?: number;
  error?: string;
}

/**
 * Each decision rests on the newest frame. In streaming, a frame that arrives while the policy is busy is
 * skipped for the next, and the decision goes in as two slots, the second holding the keys over the slot
 * boundary so they stay down until the next decision replaces it. In lockstep the world waits: one slot,
 * then one advance.
 */
export function createPolicyController(opts: PolicyControllerOptions): Controller<PolicyConfig> {
  return {
    id: opts.id ?? "policy",
    kind: "policy",
    label: opts.label ?? "Policy",
    description: opts.description,
    config: PolicyConfig,
    enabled: opts.enabled ?? true,
    time: "on-wait",
    create(ctx): ControllerInstance<PolicyConfig> {
      const server = new PolicyServer(ctx.config.url);
      server.send({ type: "config", delay_ms: ctx.config.delayMs });
      void run(ctx, server, opts).catch((e: unknown) => {
        if (!ctx.signal.aborted) ctx.status(`Stopped: ${e instanceof Error ? e.message : String(e)}`);
      });
      return {
        configure(config) {
          server.send({ type: "config", delay_ms: config.delayMs });
        },
        stop() {
          server.close();
        },
      };
    },
  };
}

async function run(ctx: ControlContext<PolicyConfig>, server: PolicyServer, opts: PolicyControllerOptions) {
  await server.request({ type: "reset" });
  let resets = ctx.events().filter((e) => e.event === "world_resetting").length;
  ctx.engage();
  let decisions = 0;
  while (!ctx.signal.aborted) {
    await ctx.acquire();
    const basis = ctx.frame(opts.channel);
    if (!basis) {
      await ctx.nextObservation();
      continue;
    }
    // The policy's memory is one episode; a reset starts another.
    const seen = ctx.events().filter((e) => e.event === "world_resetting").length;
    if (seen !== resets) {
      resets = seen;
      await server.request({ type: "reset" });
    }
    const reply = await server.request({
      type: "act",
      frame_b64: Buffer.from(basis.frame.payload).toString("base64"),
    });
    if (ctx.signal.aborted) return;
    const slot = reply.slots?.[0] ?? {};
    ctx.alive();
    decisions += 1;
    ctx.status(`${decisions.toLocaleString()} decisions · ${Math.round(reply.latency_ms ?? 0)} ms`);
    const slots = ctx.mode === "streaming" ? [slot, { keys: slot.keys ?? [] }] : [slot];
    try {
      await ctx.submit(
        "input_chunk",
        { slot_ms: opts.slotMs, slots },
        { preempt: "replace", basis, ...(ctx.mode === "streaming" ? { validForMs: opts.validForMs ?? 100 } : {}) },
      );
    } catch (e) {
      // A refused intent (stale, say) is the world's call; the next frame brings another decision.
      ctx.log({ kind: "decision", title: "Decision refused", detail: e instanceof Error ? e.message : String(e) });
    }
    if (ctx.mode === "lockstep") await ctx.wait({ ticks: 1 });
    else if (ctx.frame(opts.channel) === basis) await ctx.nextObservation();
  }
}

/** One WebSocket to the policy server, with requests answered in order. */
class PolicyServer {
  private readonly ws: WebSocket;
  private readonly opened: Promise<void>;
  private readonly waiting: { resolve(r: Reply): void; reject(e: Error): void }[] = [];
  private next = 0;
  private closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`no policy server at ${url}`)), { once: true });
    });
    this.opened.catch(() => undefined);
    this.ws.addEventListener("message", (e) => {
      const reply = JSON.parse(String(e.data)) as Reply;
      if (reply.type === "config") return;
      const w = this.waiting.shift();
      if (reply.type === "error") w?.reject(new Error(reply.error ?? "the policy server failed"));
      else w?.resolve(reply);
    });
    this.ws.addEventListener("close", () => {
      for (const w of this.waiting.splice(0)) w.reject(new Error("the policy server closed"));
    });
  }

  send(message: Record<string, unknown>): void {
    void this.opened.then(() => {
      if (!this.closed) this.ws.send(JSON.stringify(message));
    });
  }

  async request(message: Record<string, unknown>): Promise<Reply> {
    await this.opened;
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.ws.send(JSON.stringify({ ...message, id: ++this.next }));
    });
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}
