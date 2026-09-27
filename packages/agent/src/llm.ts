/**
 * Plumbing shared by LLM controllers: model construction, AWP actions as AI SDK tools, and turns
 * streamed into the activity log. What a world's LLM sees and may do stays in the world's controller.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LlmConfig } from "@awp-demo/inspector";
import { AwpError, type WorldManifest } from "@hyperduality/awp";
import {
  isStepCount,
  hasToolCall,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type PrepareStepFunction,
  type StopCondition,
  ToolLoopAgent,
  type ToolSet,
  tool,
} from "ai";
import { z } from "zod";
import type { ControlContext, Controller, ControllerInstance, HistoryEntry } from "./controller.ts";
import { summarize } from "./mux.ts";

export { LlmConfig };

const ENV_KEYS: Record<LlmConfig["provider"], string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "openai-compatible": undefined,
};

/** A model for the configured provider. The key comes from the UI (held in memory) or the environment. */
export function createModel(config: LlmConfig): LanguageModel {
  const envKey = ENV_KEYS[config.provider];
  const apiKey = config.apiKey || (envKey ? process.env[envKey] : undefined);
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ ...(apiKey ? { apiKey } : {}), ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) })(config.model);
    case "openai":
      return createOpenAI({ ...(apiKey ? { apiKey } : {}), ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) })(config.model);
    case "google":
      return createGoogleGenerativeAI({ ...(apiKey ? { apiKey } : {}) })(config.model);
    case "openai-compatible":
      if (!config.baseUrl) throw new Error("an OpenAI-compatible provider needs a base URL");
      return createOpenAICompatible({ name: "compatible", baseURL: config.baseUrl, ...(apiKey ? { apiKey } : {}) })(config.model);
  }
}

export function hasCredentials(config: LlmConfig): boolean {
  if (config.apiKey) return true;
  const envKey = ENV_KEYS[config.provider];
  return config.provider === "openai-compatible" ? Boolean(config.baseUrl) : Boolean(envKey && process.env[envKey]);
}

export interface ActionOutcome {
  action: string;
  state: string;
  reason?: string | undefined;
  detail?: string | undefined;
  /** What other controllers did while this action ran. */
  meanwhile?: string[] | undefined;
  observation?: unknown;
}

export interface ActionToolOptions {
  /** The action types to expose (default: every granted type). */
  types?: string[];
  /** Descriptions that improve on the manifest's. */
  describe?: Record<string, string>;
  /** The observation returned with each outcome. */
  observe(): unknown;
  /** How an outcome reads to the model (default JSON). */
  format?(outcome: ActionOutcome): string;
  /** Bound on ticks per action in lockstep. */
  maxTicks?: number;
  embodimentFor?(type: string): string | undefined;
}

/**
 * Each granted action type as a tool whose input schema is the manifest's `params_schema`. Executing
 * a tool submits the action, lets it run to a terminal state, and returns the outcome with a fresh
 * observation, so the model always acts on what the world reports.
 */
export function actionTools<C>(ctx: ControlContext<C>, opts: ActionToolOptions): ToolSet {
  const m = ctx.manifest;
  const granted = new Set(ctx.embodiments.flatMap((e) => m.embodiments.find((x) => x.id === e)?.action_types ?? []));
  const types = (opts.types ?? [...granted]).filter((t) => granted.has(t));
  const tools: ToolSet = {};
  for (const type of types) {
    const decl = m.action_schemas.find((a) => a.type === type);
    if (!decl) continue;
    tools[type] = tool({
      description: opts.describe?.[type] ?? decl.description ?? `The world's ${type} action.`,
      inputSchema: jsonSchema(resolveDefs(m, decl.params_schema)),
      execute: async (input: unknown) => {
        const before = ctx.history(1)[0]?.ts ?? 0;
        const params = (input ?? {}) as Record<string, unknown>;
        let outcome: ActionOutcome;
        try {
          const embodiment = opts.embodimentFor?.(type);
          const rec = await ctx.submit(type, params, embodiment ? { embodiment } : {});
          await ctx.settle(rec, { maxTicks: opts.maxTicks ?? 400 });
          outcome = { action: type, state: rec.state, reason: rec.reason, detail: rec.detail };
        } catch (e) {
          outcome = {
            action: type,
            state: "rejected",
            reason: e instanceof AwpError ? e.errorName : "error",
            detail: e instanceof AwpError ? e.detail : e instanceof Error ? e.message : String(e),
          };
        }
        const meanwhile = ctx
          .history(50)
          .filter((h) => h.ts > before && h.source !== ctx.id)
          .map(describeHistory);
        if (meanwhile.length > 0) outcome.meanwhile = meanwhile;
        outcome.observation = opts.observe();
        return outcome;
      },
      toModelOutput: ({ output }) => ({ type: "text", value: (opts.format ?? defaultFormat)(output as ActionOutcome) }),
    });
  }
  return tools;
}

export function describeHistory(h: HistoryEntry): string {
  return `${h.source}: ${h.type} ${summarize(h.params)} → ${h.state}${h.reason ? ` (${h.reason})` : ""}`;
}

function defaultFormat(o: ActionOutcome): string {
  return JSON.stringify(o);
}

/** Inline `#/$defs/...` references so a provider sees a self-contained schema. */
function resolveDefs(m: WorldManifest, schema: Record<string, unknown>): Record<string, never> {
  const defs = (m.$defs ?? {}) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.$ref === "string" && o.$ref.startsWith("#/$defs/")) return walk(defs[o.$ref.slice(8)]);
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(schema) as Record<string, never>;
}

export interface LlmControllerOptions<C extends LlmConfig> {
  id?: string;
  label?: string;
  description: string;
  config?: z.ZodType<C>;
  enabled?: boolean;
  /** System instructions for this world. */
  instructions(ctx: ControlContext<C>): string;
  /** The tools, usually `actionTools(ctx, …)` plus a `finish` tool. */
  tools(ctx: ControlContext<C>): ToolSet;
  /** The message a "start" sends when the operator gives none. */
  kickoff?(ctx: ControlContext<C>): string;
  /** Context-window management between steps. */
  prepareStep?: PrepareStepFunction<ToolSet>;
  stopWhen?: StopCondition<ToolSet>[];
}

/** A tool the model calls when the task is done; ends the turn. */
export const finishTool = tool({
  description: "Call when the task is complete (or cannot be completed), with a one-paragraph summary.",
  inputSchema: z.object({ summary: z.string() }),
  execute: async ({ summary }) => ({ done: true, summary }),
});

/**
 * An LLM controller: each operator message starts a turn; the turn engages the controller, runs a
 * ToolLoopAgent whose tools act on the world, streams reasoning, text, and tool calls into the
 * activity log, then releases control. Losing authority mid-turn pauses the tools until it returns.
 */
export function createLlmController<C extends LlmConfig = LlmConfig>(opts: LlmControllerOptions<C>): Controller<C> {
  return {
    id: opts.id ?? "llm",
    kind: "llm",
    label: opts.label ?? "LLM",
    description: opts.description,
    config: (opts.config ?? LlmConfig) as z.ZodType<C>,
    enabled: opts.enabled ?? true,
    create(ctx): ControllerInstance<C> {
      const messages: ModelMessage[] = [];
      let turn: AbortController | undefined;
      let queued: string | undefined;
      let seenHistory = 0;

      const run = async (text: string) => {
        if (turn) {
          queued = text;
          turn.abort();
          return;
        }
        const config = ctx.config;
        if (!hasCredentials(config)) {
          ctx.log({ kind: "error", title: "No API key", detail: `Add a ${config.provider} key in the LLM settings.` });
          return;
        }
        turn = new AbortController();
        const signal = AbortSignal.any([turn.signal, ctx.signal]);
        const others = ctx
          .history(100)
          .slice(seenHistory)
          .filter((h) => h.source !== ctx.id)
          .map(describeHistory);
        seenHistory = ctx.history(100).length;
        const content = others.length > 0 ? `${text}\n\nSince your last turn, other controllers acted:\n${others.map((o) => `- ${o}`).join("\n")}` : text;
        messages.push({ role: "user", content });
        ctx.engage();
        ctx.status("Thinking");
        try {
          const tools: ToolSet = { ...opts.tools(ctx), finish: finishTool };
          const agent = new ToolLoopAgent({
            model: createModel(config),
            instructions: opts.instructions(ctx),
            tools,
            stopWhen: opts.stopWhen ?? [isStepCount(config.maxSteps), hasToolCall("finish")],
            ...(opts.prepareStep ? { prepareStep: opts.prepareStep } : {}),
          });
          const result = await agent.stream({ messages, abortSignal: signal });
          await streamToActivity(ctx, result.fullStream);
          messages.push(...(await result.responseMessages));
        } catch (e) {
          if (!signal.aborted) ctx.log({ kind: "error", title: "Model call failed", detail: e instanceof Error ? e.message : String(e) });
          else ctx.log({ kind: "system", title: "Stopped" });
          // Keep the transcript well-formed: drop a dangling user turn with no answer.
          if (messages.at(-1)?.role === "user") messages.pop();
        } finally {
          turn = undefined;
          ctx.status(undefined);
          ctx.release();
          if (queued !== undefined) {
            const next = queued;
            queued = undefined;
            void run(next);
          }
        }
      };

      return {
        message: (text) => void run(text.trim() || (opts.kickoff?.(ctx) ?? "Begin.")),
        interrupt: () => turn?.abort(),
        stop: () => turn?.abort(),
      };
    },
  };
}

type StreamPart =
  | { type: "reasoning-start" | "reasoning-end" | "text-start" | "text-end"; id: string }
  | { type: "reasoning-delta" | "text-delta"; id: string; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; input: unknown; output: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; error: unknown }
  | { type: "error"; error: unknown }
  | { type: string };

/** Streams reasoning and text into upserted activity entries; tool calls appear as their actions do. */
export async function streamToActivity<C>(ctx: ControlContext<C>, stream: AsyncIterable<unknown>): Promise<void> {
  // Entries are created on the first non-empty delta, so empty reasoning blocks leave no trace.
  const buffers = new Map<string, { entry: string | undefined; text: string; kind: "thought" | "message" }>();
  let step = 0;
  let serial = 0;
  for await (const raw of stream) {
    const part = raw as StreamPart;
    switch (part.type) {
      case "start-step":
        step += 1;
        break;
      case "reasoning-start":
      case "text-start": {
        const p = part as { id: string; type: string };
        const kind = p.type === "reasoning-start" ? "thought" : "message";
        buffers.set(`${step}:${p.type.split("-")[0]}:${p.id}`, { entry: undefined, text: "", kind });
        break;
      }
      case "reasoning-delta":
      case "text-delta": {
        const p = part as { id: string; type: string; text: string };
        const b = buffers.get(`${step}:${p.type.split("-")[0]}:${p.id}`);
        if (!b) break;
        b.text += p.text;
        if (!b.text.trim()) break;
        b.entry ??= `${ctx.id}:${Date.now()}:${++serial}`;
        ctx.log({ id: b.entry, kind: b.kind, title: b.text, streaming: true });
        break;
      }
      case "reasoning-end":
      case "text-end": {
        const p = part as { id: string; type: string };
        const key = `${step}:${p.type.split("-")[0]}:${p.id}`;
        const b = buffers.get(key);
        buffers.delete(key);
        if (b?.entry) ctx.log({ id: b.entry, kind: b.kind, title: b.text.trim(), streaming: false });
        break;
      }
      case "tool-call": {
        const p = part as { toolName: string; input: unknown };
        if (p.toolName === "finish") {
          ctx.log({ kind: "message", title: String((p.input as { summary?: string })?.summary ?? "Done."), data: { finish: true } });
        }
        break;
      }
      case "tool-error": {
        const p = part as { toolName: string; error: unknown };
        ctx.log({ kind: "error", title: `${p.toolName} failed`, detail: p.error instanceof Error ? p.error.message : String(p.error) });
        break;
      }
      case "error": {
        const p = part as { error: unknown };
        ctx.log({ kind: "error", title: "Model error", detail: p.error instanceof Error ? p.error.message : String(p.error) });
        break;
      }
    }
  }
}
