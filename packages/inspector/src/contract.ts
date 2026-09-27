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
}

// ---------------------------------------------------------------------------------------------
// Shared controller configuration

export const LlmProvider = z.enum(["openai", "anthropic", "google", "openai-compatible"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

export const LlmConfig = z.object({
  provider: LlmProvider.default("anthropic"),
  model: z.string().min(1).default("claude-sonnet-5"),
  apiKey: z.string().optional().meta({ "x-secret": true }),
  baseUrl: z.string().optional(),
  maxSteps: z.number().int().min(1).max(200).default(40),
});
export type LlmConfig = z.infer<typeof LlmConfig>;

export const MODEL_SUGGESTIONS: Record<LlmProvider, string[]> = {
  anthropic: ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5"],
  openai: ["gpt-5.4", "gpt-5-mini"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash"],
  "openai-compatible": [],
};

export const REDACTED = "••••••••";
