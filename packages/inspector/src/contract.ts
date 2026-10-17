/**
 * The contract between the demo processes and the UI. The UI never speaks AWP; it reads these topics
 * and sends these commands. Everything here is JSON.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Wire protocol of the inspector itself

export type ServerMessage =
  | { t: "hello"; process: "world" | "agent"; topics: TopicInfo[] }
  | { t: "snap"; topic: string; data: unknown }
  | { t: "ev"; topic: string; data: unknown }
  | { t: "res"; id: number; ok: true; data?: unknown }
  | { t: "res"; id: number; ok: false; error: string };

export interface TopicInfo {
  name: string;
  kind: "state" | "stream";
  keyed: boolean;
}

export type ClientMessage = { t: "cmd"; id: number; name: string; args?: unknown };

/** Stream topics deliver arrays; keyed streams replace items with the same `id`. */
export interface StreamEvent<T> {
  items: T[];
  clear?: boolean;
}

// ---------------------------------------------------------------------------------------------
// World process

export const WorldTopic = {
  manifest: "manifest",
  world: "world",
  wire: "wire",
  view: "view",
  layout: "layout",
} as const;

export const WorldCommand = {
  reset: "world.reset",
  estopEngage: "estop.engage",
  estopRelease: "estop.release",
  operator: "world.operator",
} as const;

/** One JSON-RPC message on a control connection, as the world saw it. */
export interface WireEntry {
  n: number;
  /** Wall-clock ms. */
  ts: number;
  conn: number;
  session?: string;
  from: "agent" | "world";
  message: unknown;
  bytes: number;
}

export interface WorldActionView {
  id: string;
  type: string;
  embodiment: string;
  state: string;
  reason?: string | undefined;
  progress: number;
  params: unknown;
}

export interface WorldChannelView {
  channel: string;
  channelId: number;
  rateHz: number | null;
  seq: number;
  command: boolean;
  modality: string;
  lossClass: string;
}

export interface WorldSessionView {
  id: string;
  state: string;
  mode: string;
  observer: boolean;
  embodiments: string[];
  connected: boolean;
  closing: boolean;
  inSafeState: boolean;
  clockNs: number;
  statusSeq: number;
  grantedTypes: string[];
  admin: string[];
  agent: unknown;
  task: unknown;
  channels: WorldChannelView[];
  actions: WorldActionView[];
}

export interface WorldState {
  url: string;
  mode: string;
  tick: number;
  eStop: boolean;
  seed: number;
  initialState: string;
  sessions: WorldSessionView[];
}

// ---------------------------------------------------------------------------------------------
// Agent process

export const AgentTopic = {
  status: "status",
  controllers: "controllers",
  activity: "activity",
} as const;

export const AgentCommand = {
  enable: "controller.enable",
  configure: "controller.configure",
  take: "controller.take",
  release: "controller.release",
  input: "controller.input",
  message: "controller.message",
  stop: "controller.stop",
  clockPause: "clock.pause",
  clockStep: "clock.step",
  clockRate: "clock.rate",
  reconnect: "agent.reconnect",
} as const;

export type ControllerKind = "manual" | "program" | "llm";

export interface ControllerState {
  id: string;
  kind: ControllerKind;
  label: string;
  description: string;
  priority: number;
  time: "continuous" | "on-wait";
  enabled: boolean;
  engaged: boolean;
  authority: boolean;
  pinned: boolean;
  /** Short present-tense status, e.g. "Tracking P-12". */
  status?: string | undefined;
  /** Why the controller cannot run with its current config (e.g. no API key), or undefined. */
  unavailable?: string | undefined;
  /** Placeholders for empty config fields, keyed by field (e.g. the environment variable a key comes from). */
  hints?: Record<string, string> | undefined;
  config: unknown;
  /** JSON Schema of `config`, for a generated form. Secret fields carry `"x-secret": true`. */
  configSchema: unknown;
}

export type ActivityKind =
  | "input"
  | "decision"
  | "action"
  | "thought"
  | "message"
  | "handoff"
  | "event"
  | "error"
  | "system";

export interface ActivityEntry {
  id: string;
  /** Wall-clock ms. */
  ts: number;
  /** A controller id, "operator", "mux", or "world". */
  source: string;
  kind: ActivityKind;
  title: string;
  detail?: string | undefined;
  actionId?: string | undefined;
  /** Action lifecycle state, for `action` entries. */
  state?: string | undefined;
  /** Still being written (LLM text or reasoning). */
  streaming?: boolean | undefined;
  data?: unknown;
}

export interface AgentStatus {
  connection: "connecting" | "connected" | "suspended" | "closed" | "error";
  worldUrl: string;
  sessionId?: string | undefined;
  mode?: string | undefined;
  tick?: number | undefined;
  rttMs?: number | undefined;
  offsetMs?: number | undefined;
  authority: string | null;
  clock: { paused: boolean; rateHz: number; waiting: boolean };
  error?: string | undefined;
  manifest?: unknown;
  /** Streaming: the world's latest `session.telemetry` (AWP-TIM-006). */
  telemetry?: SessionTelemetryView | undefined;
  /** Wall-clock ms of the last completed heartbeat exchange. */
  heartbeatAt?: number | undefined;
  /** `intent`: the agent pings only while the controller in control shows life (AWP-SAF-005). */
  heartbeat?: "auto" | "intent";
  /** What a handoff does to the previous holder's live actions. */
  handoff?: "cancel" | "inherit";
}

/** Percentiles in ns, as `session.telemetry` carries them. */
export interface LatencyView {
  count: number;
  p50: number;
  p95: number;
  max?: number;
}

export interface SessionTelemetryView {
  window_ms: number;
  observation_latency_ns?: LatencyView;
  admission_latency_ns?: LatencyView;
  observation_to_action_ns?: LatencyView;
  command_latency_ns?: LatencyView;
  channels?: Record<string, LatencyView>;
}

// ---------------------------------------------------------------------------------------------
// Shared controller configuration

export const LlmProvider = z.enum(["openai", "anthropic", "google", "openai-compatible"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

export const LlmConfig = z.object({
  provider: LlmProvider.default("anthropic"),
  model: z.string().min(1).default("claude-sonnet-5-5"),
  apiKey: z.string().optional().meta({ "x-secret": true }),
  baseUrl: z.string().optional(),
  maxSteps: z.number().int().min(1).max(200).default(100),
});
export type LlmConfig = z.infer<typeof LlmConfig>;

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "openai-compatible": "OpenAI-compatible",
};

export const MODEL_SUGGESTIONS: Record<LlmProvider, { id: string; label: string }[]> = {
  anthropic: [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  ],
  openai: [
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ],
  google: [
    { id: "gemini-4-argon", label: "Gemini 4 Argon" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  ],
  "openai-compatible": [],
};

export const REDACTED = "••••••••";
