/**
 * Plumbing shared by LLM controllers: model construction, AWP actions as AI SDK tools, and turns
 * streamed into the activity log. What a world's LLM sees and may do stays in the world's controller.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LlmConfig, PROVIDER_LABELS } from "@awp-demo/inspector";
import { type ActionRecord, AwpError, type ReceivedFrame, type WorldManifest } from "@hyperduality/awp";
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

/** Where an unset API key comes from, as placeholders for the UI. */
function credentialHints(config: LlmConfig): Record<string, string> {
  const envKey = ENV_KEYS[config.provider];
  return envKey && process.env[envKey] ? { apiKey: `Using ${envKey} from the environment` } : {};
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
  /** Set once the world admitted the action. */
  action_id?: string | undefined;
  embodiment?: string | undefined;
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
  /**
   * Wait for each action to end before the tool returns (default true). Without, the tool returns
   * once the world admits the action, and how it ends is news for later: the model can think while
   * the world acts, which a streaming world needs.
   */
  settle?: boolean;
  /** The frame the model's decision rests on, named as the basis of each submission (AWP-ACT-007). */
  basis?(): ReceivedFrame | undefined;
  /** How long each intent stays valid (`valid_until_ns`). */
  validForMs?: number;
  /** What happened since the model last heard, for each outcome (default: others' actions and world events). */
  meanwhile?(): string[];
}

/**
 * Each granted action type as a tool whose input schema is the manifest's `params_schema`. Executing
 * a tool submits the action, lets it run to a terminal state (unless `settle` is false), and returns
 * the outcome with a fresh observation, so the model always acts on what the world reports. When a
 * type is granted on several bound embodiments, its tool also takes the `embodiment` to act with.
 */
export function actionTools<C>(ctx: ControlContext<C>, opts: ActionToolOptions): ToolSet {
  const m = ctx.manifest;
  const offering = (type: string) =>
    ctx.embodiments.filter((e) => m.embodiments.find((x) => x.id === e)?.action_types.includes(type));
  const granted = new Set(ctx.embodiments.flatMap((e) => m.embodiments.find((x) => x.id === e)?.action_types ?? []));
  const types = (opts.types ?? [...granted]).filter((t) => granted.has(t));
  const tools: ToolSet = {};
  for (const type of types) {
    const decl = m.action_schemas.find((a) => a.type === type);
    if (!decl) continue;
    const candidates = opts.embodimentFor ? [] : offering(type);
    const pick = candidates.length > 1;
    const schema = resolveDefs(m, decl.params_schema) as Record<string, unknown>;
    tools[type] = tool({
      description: opts.describe?.[type] ?? decl.description ?? `The world's ${type} action.`,
      inputSchema: jsonSchema(pick ? withEmbodiment(schema, candidates) : (schema as Record<string, never>)),
      execute: async (input: unknown, { abortSignal }) => {
        ctx.alive();
        const before = reported.get(ctx) ?? lastSeq(ctx);
        const { embodiment: chosen, ...rest } = (input ?? {}) as Record<string, unknown>;
        const params = pick ? rest : ((input ?? {}) as Record<string, unknown>);
        const embodiment = pick ? String(chosen) : opts.embodimentFor?.(type);
        const entry: TurnAction = { type, params, embodiment };
        turnActions.get(ctx)?.push(entry);
        let outcome: ActionOutcome;
        try {
          const basis = opts.basis?.();
          // Stop ends the wait for authority and for the action; the mux cancels the action on release.
          const rec = await ctx.submit(type, params, {
            ...(embodiment ? { embodiment } : {}),
            ...(abortSignal ? { signal: abortSignal } : {}),
            ...(basis ? { basis } : {}),
            ...(opts.validForMs !== undefined ? { validForMs: opts.validForMs } : {}),
          });
          entry.rec = rec;
          if (opts.settle !== false)
            await ctx.settle(rec, { maxTicks: opts.maxTicks ?? 400, ...(abortSignal ? { signal: abortSignal } : {}) });
          outcome = {
            action: type,
            action_id: rec.action_id,
            embodiment,
            state: rec.state,
            reason: rec.reason,
            detail: rec.detail,
          };
        } catch (e) {
          outcome = {
            action: type,
            embodiment,
            state: "rejected",
            reason: e instanceof AwpError ? e.errorName : "error",
            detail: e instanceof AwpError ? e.detail : e instanceof Error ? e.message : String(e),
          };
          entry.rejected = outcome.detail ?? outcome.reason;
        }
        const meanwhile = opts.meanwhile ? opts.meanwhile() : since(ctx, before);
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

/** A params schema with a required `embodiment` property naming one of `ids`. */
function withEmbodiment(schema: Record<string, unknown>, ids: string[]): Record<string, never> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if ("embodiment" in properties) throw new Error("params already have an embodiment property");
  return {
    ...schema,
    type: "object",
    properties: { embodiment: { type: "string", enum: ids, description: "Who acts." }, ...properties },
    required: ["embodiment", ...((schema.required as string[] | undefined) ?? [])],
  } as unknown as Record<string, never>;
}

export function describeHistory(h: HistoryEntry): string {
  const why = [h.reason, h.detail].filter(Boolean).join(": ");
  return `${h.source}: ${h.type} ${summarize(h.params, h.embodiment)} → ${h.state}${why ? ` (${why})` : ""}`;
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
  embodiment?: string | undefined;
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
  return `${a.type} ${summarize(a.params, a.embodiment)} → ${end}`;
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
    hints: credentialHints,
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

/**
 * Streams reasoning and text into upserted activity entries; tool calls appear as their actions do.
 * `onPart` hears every part as it arrives, e.g. to show that the model is still producing.
 */
export async function streamToActivity<C>(
  ctx: ControlContext<C>,
  stream: AsyncIterable<unknown>,
  onPart?: () => void,
): Promise<StreamSummary> {
  let failure: string | undefined;
  let finished = false;
  let endedOnToolCalls = false;
  // Entries are created on the first non-empty delta, so empty reasoning blocks leave no trace.
  const buffers = new Map<string, { entry: string | undefined; text: string; kind: "thought" | "message" }>();
  let step = 0;
  let serial = 0;
  for await (const raw of stream) {
    onPart?.();
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

// ---------------------------------------------------------------------------------------------
// The supervisor: a model on duty in a streaming world

/** Heads every view the model is shown; older views are dropped from what each call sends. */
const VIEW_MARK = "Current view";

export interface SupervisorOptions<C extends LlmConfig> {
  id?: string;
  label?: string;
  description: string;
  config?: z.ZodType<C>;
  enabled?: boolean;
  /** What this world asks of the model; the supervisor adds how working in real time goes. */
  instructions(ctx: ControlContext<C>): string;
  /** The world as the model sees it now, and the frame that view rests on. */
  observe(ctx: ControlContext<C>): { text: string; basis?: ReceivedFrame | undefined };
  /** Which action types become tools, and descriptions better than the manifest's. */
  actions?: { types?: string[]; describe?: Record<string, string> };
  /** Tools besides the actions, `look`, and `cancel`. */
  tools?(ctx: ControlContext<C>): ToolSet;
  /**
   * Lines worth waking the model for in a new frame, given the channel's previous payload. World
   * events and actions ending are news without this, but for the model's own actions completing,
   * which it hears without being woken.
   */
  news?(channel: string, payload: unknown, previous: unknown): string[];
  /** Lines from a new frame the model should hear when it next wakes, but not wake for. */
  notes?(channel: string, payload: unknown, previous: unknown): string[];
  /** The first message when the operator puts the model on duty without one. */
  kickoff?(ctx: ControlContext<C>): string;
  /**
   * Delay added before each model call, to try out a slower model: first `stallMs` with no sign of
   * life, as a hung request gives; then `thinkingMs` alive, as a model reasoning at length is.
   */
  delay?(config: C): { stallMs?: number; thinkingMs?: number };
  /** Turns kept in the conversation (default 8). */
  keepTurns?: number;
  /** How long each intent stays valid once sent (`valid_until_ns`). */
  validForMs?: number;
  /** Overrides model construction (tests, custom providers). */
  model?: (config: C) => LanguageModel;
}

/**
 * A model on duty in a streaming world. Where `createLlmController` runs one turn per operator
 * message in a world that waits, the supervisor stays engaged from the first message until the
 * operator stops it, and the world does not wait:
 *
 * - Its action tools return once the world admits the action, so the model thinks while the world
 *   acts. How an action ends is news, told with the next tool result or in the next turn.
 * - News wakes it: actions ending (but its own completing), world events, operator messages, and
 *   whatever `news` finds in new frames. A turn starts once the news settles, and the model ends it
 *   when nothing is left.
 * - Each submission names as its basis the frame of the view the model was looking at when the
 *   call began, so the world refuses a decision that took too long (AWP-SAF-013).
 * - Its liveness is the model's output: the agent pings only while the model streams, runs a tool,
 *   or waits for news. A model call that produces nothing for the watchdog's span lets the world
 *   stop motion (AWP-SAF-005).
 */
export function createLlmSupervisor<C extends LlmConfig = LlmConfig>(opts: SupervisorOptions<C>): Controller<C> {
  return {
    id: opts.id ?? "llm",
    kind: "llm",
    label: opts.label ?? "LLM",
    description: opts.description,
    config: (opts.config ?? LlmConfig) as z.ZodType<C>,
    enabled: opts.enabled ?? true,
    liveness: "intent",
    unavailable: (config) => (opts.model ? undefined : missingCredentials(config)),
    hints: credentialHints,
    create(ctx): ControllerInstance<C> {
      let onDuty = false;
      let turn: AbortController | undefined;
      let wake: NodeJS.Timeout | undefined;
      let failures = 0;
      // How the last turn ended, when it did not end on its own; told with the next message.
      let ending: string | undefined;
      const news: string[] = [];
      const notes: string[] = [];
      const turns: ModelMessage[][] = [];
      const previous = new Map<string, unknown>();
      let told = lastSeq(ctx);
      // The basis of the newest view the model was shown, and of the model call in progress.
      let shown: ReceivedFrame | undefined;
      let basis: ReceivedFrame | undefined;

      const view = (): string => {
        const v = opts.observe(ctx);
        shown = v.basis;
        return `${VIEW_MARK}:\n${v.text}`;
      };
      /** Everything the model has not heard yet; hearing it marks it told. */
      const catchUp = (): string[] => {
        const lines = [...notes.splice(0), ...news.splice(0), ...happenings(ctx, told)];
        told = lastSeq(ctx);
        return lines;
      };
      const pending = () =>
        news.length > 0 ||
        (ctx.events(1)[0]?.seq ?? 0) > told ||
        ctx
          .history(50)
          .some((h) => h.seq > told && !(h.source === ctx.id && ["completed", "rejected"].includes(h.state)));
      const schedule = (delayMs = 300) => {
        if (!onDuty || turn || wake) return;
        wake = setTimeout(() => {
          wake = undefined;
          void runTurn();
        }, delayMs);
      };

      for (const c of ctx.manifest.observation_channels) {
        ctx.onFrame(c.id, (payload) => {
          const before = previous.get(c.id);
          previous.set(c.id, payload);
          if (!onDuty) return;
          notes.push(...(opts.notes?.(c.id, payload, before) ?? []));
          const lines = opts.news?.(c.id, payload, before) ?? [];
          if (lines.length === 0) return;
          news.push(...lines);
          schedule();
        });
      }

      const maxBasisAgeMs = ctx.manifest.safety_policy.max_basis_age_ms;
      const instructions = () =>
        [
          "You are on duty in a world that runs in real time. It keeps moving while you think, so think briefly and act.",
          "- Each message brings the news since you last heard and the current view. Act on the newest view.",
          "- Your action tools return as soon as the world accepts or refuses the action. You hear how each action ends later, as news.",
          `- The world refuses a decision built on a view that has grown too old (stale_intent${maxBasisAgeMs !== undefined ? `: older than ${maxBasisAgeMs / 1000} s` : ""}). Then decide again, quickly, from the view that comes with the refusal.`,
          "- When nothing needs doing, end your turn with one short line. You are woken when something changes.",
          "",
          opts.instructions(ctx),
        ].join("\n");

      const tools = (): ToolSet => ({
        ...actionTools(ctx, {
          ...opts.actions,
          settle: false,
          basis: () => basis,
          ...(opts.validForMs !== undefined ? { validForMs: opts.validForMs } : {}),
          meanwhile: catchUp,
          observe: view,
          format: formatLive,
        }),
        look: tool({
          description: "See the news and the current view without acting.",
          inputSchema: z.object({}),
          execute: async () => {
            ctx.alive();
            const lines = catchUp();
            return [lines.length > 0 && `News:\n${bullets(lines)}`, view()].filter(Boolean).join("\n\n");
          },
        }),
        cancel: tool({
          description: "Cancel one of the actions in progress by its action_id. What was acting stops where it is.",
          inputSchema: z.object({ action_id: z.string() }),
          execute: async ({ action_id }) => {
            ctx.alive();
            try {
              await ctx.cancel(action_id);
              return `cancel ${action_id}: requested`;
            } catch (e) {
              return `cancel ${action_id}: refused (${e instanceof AwpError ? (e.detail ?? e.errorName) : String(e)})`;
            }
          },
        }),
        ...opts.tools?.(ctx),
      });

      const runTurn = async (operator?: string): Promise<void> => {
        if (!onDuty) return;
        if (turn) {
          // The turn in progress hears it with its next tool result, or the next turn does.
          if (operator) news.push(`Operator: ${operator}`);
          return;
        }
        clearTimeout(wake);
        wake = undefined;
        const config = ctx.config;
        const missing = opts.model ? undefined : missingCredentials(config);
        if (missing) {
          ctx.log({ kind: "error", title: "No API key", detail: missing });
          offDuty();
          return;
        }
        turn = new AbortController();
        const signal = AbortSignal.any([turn.signal, ctx.signal]);
        ctx.alive();
        ctx.status("Thinking");
        const lines = catchUp();
        const content = [
          ending && `(${ending})`,
          operator && `Operator: ${operator}`,
          lines.length > 0 && `News since your last turn:\n${bullets(lines)}`,
          view(),
        ]
          .filter(Boolean)
          .join("\n\n");
        ending = undefined;
        const messages: ModelMessage[] = [{ role: "user", content }];
        turns.push(messages);
        const keep = opts.keepTurns ?? 8;
        if (turns.length > keep) turns.splice(0, turns.length - keep);
        let failed = false;
        try {
          const agent = new ToolLoopAgent({
            model: opts.model ? opts.model(config) : createModel(config),
            instructions: instructions(),
            tools: tools(),
            stopWhen: [isStepCount(config.maxSteps)],
            prepareStep: async ({ messages: sent }) => {
              // The call decides on what it is shown now; its submissions name that view's frame.
              basis = shown;
              const { stallMs = 0, thinkingMs = 0 } = opts.delay?.(ctx.config) ?? {};
              if (stallMs > 0) await sleepFor(stallMs, signal);
              if (thinkingMs > 0) await sleepFor(thinkingMs, signal, () => ctx.alive());
              return { messages: latestViewOnly(sent) };
            },
          });
          const result = await agent.stream({ messages: turns.flat(), abortSignal: signal });
          const summary = await streamToActivity(ctx, result.fullStream, () => ctx.alive());
          messages.push(...(await result.responseMessages));
          if (signal.aborted) ending = "The operator stopped your last turn.";
          else if (summary.failure) {
            failed = true;
            ending = `Your last turn ended with an error: ${summary.failure}`;
          } else if (summary.endedOnToolCalls && summary.steps >= config.maxSteps) {
            ctx.log({ kind: "system", title: "Step limit reached", detail: `${config.maxSteps} steps` });
            ending = `Your last turn reached the step limit of ${config.maxSteps} model calls.`;
          }
        } catch (e) {
          if (signal.aborted) ending = "The operator stopped your last turn.";
          else {
            failed = true;
            const error = e instanceof Error ? e.message : String(e);
            ctx.log({ kind: "error", title: "Model call failed", detail: error });
            ending = `Your last turn ended with an error: ${error}`;
          }
        } finally {
          turn = undefined;
          basis = undefined;
          failures = failed ? failures + 1 : 0;
          ctx.status(onDuty ? "On duty" : undefined);
          // A failure is retried after a pause; news that came during the last call is still unheard.
          if (failed) schedule(Math.min(30000, 1000 * 2 ** failures));
          else if (pending()) schedule();
        }
      };

      const onDutyWith = (text: string | undefined) => {
        if (!onDuty) {
          onDuty = true;
          ctx.engage();
          ctx.status("On duty");
          ctx.log({ kind: "system", title: "On duty" });
          void runTurn(text || (opts.kickoff?.(ctx) ?? "You are on duty."));
        } else if (text) void runTurn(text);
      };
      const offDuty = () => {
        if (!onDuty) return;
        onDuty = false;
        clearTimeout(wake);
        wake = undefined;
        turn?.abort();
        ctx.release();
        ctx.status(undefined);
        ctx.log({ kind: "system", title: "Off duty" });
      };

      // Waiting for news is part of deciding: on duty and between turns, the model is alive.
      const idle = setInterval(() => {
        if (!onDuty || turn) return;
        ctx.alive();
        if (pending()) schedule();
      }, 250);

      return {
        message: (text) => onDutyWith(text.trim() || undefined),
        interrupt: offDuty,
        stop: () => {
          clearInterval(idle);
          offDuty();
        },
      };
    },
  };
}

/** Actions ending (but the model's own refusals, which it heard at once) and world events after `seq`. */
function happenings(ctx: ControlContext<unknown>, seq: number): string[] {
  const lines = [
    ...ctx
      .history(500)
      .filter((h) => h.seq > seq && !(h.source === ctx.id && h.state === "rejected"))
      .map((h) => ({ seq: h.seq, line: h.source === ctx.id ? `you: ${describeOwn(h)}` : describeHistory(h) })),
    ...ctx
      .events(100)
      .filter((e) => e.seq > seq)
      .map((e) => ({ seq: e.seq, line: `world: ${describeEvent(e)}` })),
  ]
    .sort((a, b) => a.seq - b.seq)
    .map((x) => x.line);
  return lines.length > 30 ? [`(${lines.length - 30} earlier omitted)`, ...lines.slice(-30)] : lines;
}

function describeOwn(h: HistoryEntry): string {
  const why = [h.reason, h.detail].filter(Boolean).join(": ");
  return `${h.type} ${summarize(h.params, h.embodiment)} [${h.actionId}] → ${h.state}${why ? ` (${why})` : ""}`;
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/** An outcome as the supervisor's model reads it: the verdict, the news, then the view. */
function formatLive(o: ActionOutcome): string {
  const why = [o.reason, o.detail].filter(Boolean).join(": ");
  const who = o.embodiment ? ` ${o.embodiment}` : "";
  const head = `${o.action}${who}: ${o.state}${why ? ` (${why})` : ""}${o.action_id ? ` [${o.action_id}]` : ""}`;
  return [head, o.meanwhile?.length ? `News:\n${bullets(o.meanwhile)}` : "", String(o.observation ?? "")]
    .filter(Boolean)
    .join("\n\n");
}

type ToolPart = { type: string; output?: { type: string; value?: unknown } };

/** Every view but the newest becomes a stub in what a call sends; the conversation keeps them. */
function latestViewOnly(messages: ModelMessage[]): ModelMessage[] {
  let kept = false;
  const strip = (text: string): string => {
    const at = text.indexOf(VIEW_MARK);
    if (at < 0) return text;
    if (!kept) {
      kept = true;
      return text;
    }
    return `${text.slice(0, at)}(older view omitted)`;
  };
  return [...messages]
    .reverse()
    .map((m) => {
      if (m.role === "user" && typeof m.content === "string") return { ...m, content: strip(m.content) };
      if (m.role !== "tool") return m;
      const parts = [...(m.content as unknown as ToolPart[])].reverse().map((p) => {
        const v = p.output?.value;
        return typeof v === "string" && p.output ? { ...p, output: { ...p.output, value: strip(v) } } : p;
      });
      return { ...m, content: parts.reverse() } as unknown as ModelMessage;
    })
    .reverse();
}

/** Waits `ms`, or until aborted; `beat`, when given, runs every 250 ms meanwhile. */
function sleepFor(ms: number, signal: AbortSignal, beat?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const pulse = beat ? setInterval(beat, 250) : undefined;
    const done = () => {
      clearTimeout(timer);
      clearInterval(pulse);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
