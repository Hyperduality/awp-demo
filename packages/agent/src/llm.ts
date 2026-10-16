/**
 * Plumbing shared by LLM controllers: model construction, AWP actions as AI SDK tools, and turns
 * streamed into the activity log. What a world's LLM sees and may do stays in the world's controller.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LlmConfig, PROVIDER_LABELS } from "@awp-demo/inspector";
import { type ActionRecord, AwpError, type WorldManifest } from "@hyperduality/awp";
import {
  hasToolCall,
  isStepCount,
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
import { describeEvent, summarize } from "./mux.ts";

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
      return createAnthropic({ ...(apiKey ? { apiKey } : {}), ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) })(
        config.model,
      );
    case "openai":
      return createOpenAI({ ...(apiKey ? { apiKey } : {}), ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) })(
        config.model,
      );
    case "google":
      return createGoogleGenerativeAI({ ...(apiKey ? { apiKey } : {}) })(config.model);
    case "openai-compatible":
      if (!config.baseUrl) throw new Error("an OpenAI-compatible provider needs a base URL");
      return createOpenAICompatible({ name: "compatible", baseURL: config.baseUrl, ...(apiKey ? { apiKey } : {}) })(
        config.model,
      );
  }
}

export function hasCredentials(config: LlmConfig): boolean {
  if (config.apiKey) return true;
  const envKey = ENV_KEYS[config.provider];
  return config.provider === "openai-compatible" ? Boolean(config.baseUrl) : Boolean(envKey && process.env[envKey]);
}

/** What the operator has to add before the model can be called, or undefined. */
export function missingCredentials(config: LlmConfig): string | undefined {
  if (hasCredentials(config)) return undefined;
  return config.provider === "openai-compatible"
    ? "Add a base URL in the LLM settings."
    : `Add your ${PROVIDER_LABELS[config.provider]} API key in the LLM settings.`;
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
      execute: async (input: unknown, { abortSignal }) => {
        const before = reported.get(ctx) ?? lastSeq(ctx);
        const params = (input ?? {}) as Record<string, unknown>;
        const entry: TurnAction = { type, params };
        turnActions.get(ctx)?.push(entry);
        let outcome: ActionOutcome;
        try {
          const embodiment = opts.embodimentFor?.(type);
          // Stop ends the wait for authority and for the action; the mux cancels the action on release.
          const rec = await ctx.submit(type, params, {
            ...(embodiment ? { embodiment } : {}),
            ...(abortSignal ? { signal: abortSignal } : {}),
          });
          entry.rec = rec;
          await ctx.settle(rec, { maxTicks: opts.maxTicks ?? 400, ...(abortSignal ? { signal: abortSignal } : {}) });
          outcome = { action: type, state: rec.state, reason: rec.reason, detail: rec.detail };
        } catch (e) {
          outcome = {
            action: type,
            state: "rejected",
            reason: e instanceof AwpError ? e.errorName : "error",
            detail: e instanceof AwpError ? e.detail : e instanceof Error ? e.message : String(e),
          };
          entry.rejected = outcome.detail ?? outcome.reason;
        }
        const meanwhile = since(ctx, before);
        reported.set(ctx, lastSeq(ctx));
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

/** The newest sequence number across actions and world events. */
function lastSeq(ctx: ControlContext<unknown>): number {
  return Math.max(ctx.history(1)[0]?.seq ?? 0, ctx.events(1)[0]?.seq ?? 0);
}

/** Per controller context: the last sequence number already told to the model. */
const reported = new WeakMap<ControlContext<unknown>, number>();

/** An action a turn submitted; `rec` stays live, so its state is current when read. */
interface TurnAction {
  type: string;
  params: Record<string, unknown>;
  rec?: ActionRecord;
  rejected?: string | undefined;
}

/** How a turn ended, when it did not end on its own. */
interface Ending {
  text: string;
  actions?: TurnAction[];
}

/** Per controller context: the actions of the turn in progress. */
const turnActions = new WeakMap<ControlContext<unknown>, TurnAction[]>();

function describeTurnAction(a: TurnAction): string {
  const end = a.rec
    ? `${a.rec.state}${a.rec.reason ? ` (${a.rec.reason})` : ""}`
    : `rejected${a.rejected ? ` (${a.rejected})` : ""}`;
  return `${a.type} ${summarize(a.params)} → ${end}`;
}

/** Other controllers' actions and world events after `seq`, oldest first, newest 20 at most. */
function since(ctx: ControlContext<unknown>, seq: number): string[] {
  const lines = [
    ...ctx
      .history(500)
      .filter((h) => h.seq > seq && h.source !== ctx.id)
      .map((h) => ({ seq: h.seq, line: describeHistory(h) })),
    ...ctx
      .events(100)
      .filter((e) => e.seq > seq)
      .map((e) => ({ seq: e.seq, line: `world: ${describeEvent(e)}` })),
  ]
    .sort((a, b) => a.seq - b.seq)
    .map((x) => x.line);
  return lines.length > 20 ? [`(${lines.length - 20} earlier omitted)`, ...lines.slice(-20)] : lines;
}

/** An outcome's first line, e.g. "walk_to: cancelled (world_reset)" or "move: failed (blocked: a wall)". */
export function outcomeLine(o: ActionOutcome): string {
  const why = [o.reason, o.detail].filter(Boolean).join(": ");
  return `${o.action}: ${o.state}${why ? ` (${why})` : ""}`;
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
  /** Overrides model construction (tests, custom providers). */
  model?: (config: C) => LanguageModel;
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
    unavailable: (config) => (opts.model ? undefined : missingCredentials(config)),
    hints: (config): Record<string, string> => {
      const envKey = ENV_KEYS[config.provider];
      return envKey && process.env[envKey] ? { apiKey: `Using ${envKey} from the environment` } : {};
    },
    create(ctx): ControllerInstance<C> {
      const messages: ModelMessage[] = [];
      let turn: AbortController | undefined;
      let queued: string | undefined;
      // How the last turn ended, when it did not end on its own; told to the model with the next message.
      // `actions` is set when none of the turn reached memory; their states are read when the note is sent.
      let ending: Ending | undefined;
      // What happened before this controller existed is not news to it; it can look.
      reported.set(ctx, lastSeq(ctx));

      const run = async (text: string) => {
        if (turn) {
          queued = text;
          turn.abort();
          return;
        }
        const config = ctx.config;
        const missing = opts.model ? undefined : missingCredentials(config);
        if (missing) {
          ctx.log({ kind: "error", title: "No API key", detail: missing });
          return;
        }
        turn = new AbortController();
        const signal = AbortSignal.any([turn.signal, ctx.signal]);
        const turnStart = lastSeq(ctx);
        const others = since(ctx, reported.get(ctx) ?? 0);
        reported.set(ctx, turnStart);
        const note =
          ending &&
          `(${ending.text}${ending.actions?.length ? ` Your actions in it:\n${ending.actions.map((a) => `- ${describeTurnAction(a)}`).join("\n")}` : ""})`;
        const content = [
          note,
          text,
          others.length > 0 && `Since your last turn:\n${others.map((o) => `- ${o}`).join("\n")}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        ending = undefined;
        messages.push({ role: "user", content });
        const kept = messages.length;
        const actions: TurnAction[] = [];
        turnActions.set(ctx, actions);
        const end = (text: string) => {
          ending = { text };
        };
        const stopped = () => {
          ctx.log({ kind: "system", title: "Stopped" });
          end(
            queued !== undefined
              ? "The operator interrupted your last turn with this message."
              : "The operator stopped your last turn.",
          );
        };
        ctx.engage();
        ctx.status("Thinking");
        try {
          const tools: ToolSet = { ...opts.tools(ctx), finish: finishTool };
          const agent = new ToolLoopAgent({
            model: opts.model ? opts.model(config) : createModel(config),
            instructions: opts.instructions(ctx),
            tools,
            stopWhen: opts.stopWhen ?? [isStepCount(config.maxSteps), hasToolCall("finish")],
            ...(opts.prepareStep ? { prepareStep: opts.prepareStep } : {}),
          });
          const result = await agent.stream({ messages, abortSignal: signal });
          // An abort or a model error ends the stream rather than throwing; the steps that finished are
          // still in responseMessages, and stay in memory.
          const summary = await streamToActivity(ctx, result.fullStream);
          messages.push(...(await result.responseMessages));
          if (signal.aborted) stopped();
          else if (summary.failure) end(`Your last turn ended with an error: ${summary.failure}`);
          else if (summary.endedOnToolCalls && !summary.finished && summary.steps >= config.maxSteps) {
            ctx.log({ kind: "system", title: "Step limit reached", detail: `${config.maxSteps} steps` });
            end(`Your last turn reached the step limit of ${config.maxSteps} model calls before you called finish.`);
          }
        } catch (e) {
          // An abort during a tool call throws once the tool returns.
          if (signal.aborted) stopped();
          else {
            const error = e instanceof Error ? e.message : String(e);
            ctx.log({ kind: "error", title: "Model call failed", detail: error });
            end(`Your last turn ended with an error: ${error}`);
          }
        } finally {
          // Nothing of the turn reached memory (it threw): the note lists its actions instead.
          // (`end` assigns `ending` inside closures, which TypeScript's narrowing does not see.)
          const ended = ending as Ending | undefined;
          if (ended && messages.length === kept) ended.actions = actions;
          turnActions.delete(ctx);
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

/** How a streamed turn went, for telling the model next time. */
export interface StreamSummary {
  /** The model error that ended the stream, if one did. */
  failure: string | undefined;
  /** Model calls made. */
  steps: number;
  /** The model called `finish`. */
  finished: boolean;
  /** The last model call asked for tools, so the loop was cut off rather than ending on a reply. */
  endedOnToolCalls: boolean;
}

/** Streams reasoning and text into upserted activity entries; tool calls appear as their actions do. */
export async function streamToActivity<C>(
  ctx: ControlContext<C>,
  stream: AsyncIterable<unknown>,
): Promise<StreamSummary> {
  let failure: string | undefined;
  let finished = false;
  let endedOnToolCalls = false;
  // Entries are created on the first non-empty delta, so empty reasoning blocks leave no trace.
  const buffers = new Map<string, { entry: string | undefined; text: string; kind: "thought" | "message" }>();
  let step = 0;
  let serial = 0;
  for await (const raw of stream) {
    const part = raw as StreamPart;
    switch (part.type) {
      case "start-step":
        step += 1;
        endedOnToolCalls = false;
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
        endedOnToolCalls = true;
        if (p.toolName === "finish") {
          finished = true;
          ctx.log({
            kind: "message",
            title: String((p.input as { summary?: string })?.summary ?? "Done."),
            data: { finish: true },
          });
        }
        break;
      }
      case "tool-error": {
        const p = part as { toolName: string; error: unknown };
        ctx.log({
          kind: "error",
          title: `${p.toolName} failed`,
          detail: p.error instanceof Error ? p.error.message : String(p.error),
        });
        break;
      }
      case "error": {
        const p = part as { error: unknown };
        failure = p.error instanceof Error ? p.error.message : String(p.error);
        ctx.log({ kind: "error", title: "Model error", detail: failure });
        break;
      }
    }
  }
  return { failure, steps: step, finished, endedOnToolCalls };
}
