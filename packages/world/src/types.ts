import type { FrameTree, WorldManifest } from "@hyperduality/awp";

/** What an action run reports after each update. */
export type RunStatus =
  | { progress?: number; clamped?: boolean }
  | { done: true; clamped?: boolean }
  | { failed: string; detail?: string };

/**
 * One executing action inside the sim. The host owns the lifecycle; the run owns the motion.
 * `update` is called once per sim step while the action executes, before `Sim.step`.
 */
export interface ActionRun {
  update(dtMs: number): RunStatus;
  /** Begin a safe abort. Returns how long it takes in ms (streaming only; lockstep aborts complete at once). */
  abort?(): number | undefined;
  /** Apply one command-channel setpoint (streaming actions). Returns whether the envelope clamped it. */
  command?(payload: unknown): { clamped?: boolean } | undefined;
}

/** A world-specific admission verdict, after schema validation and before preemption. */
export type AdmitVerdict =
  | { ok: true }
  | { error: "AWP_ENVELOPE_EXCEEDED" | "AWP_PARAMS_INVALID" | "AWP_BUSY"; detail: string; retryable?: boolean };

export interface StartContext {
  /** The action's id, for sims that tag entities with the action moving them. */
  actionId: string;
  /** The session that owns the action. */
  sessionId: string;
}

/** The simulation behind a world. Pure state; the host decides when things happen. */
export interface Sim<View = unknown> {
  /** Advance world dynamics (everything not driven by an action run). */
  step(dtMs: number): void;
  /** The JSON payload for one observation channel, as of now. */
  observe(channel: string): unknown;
  /** World-specific admission checks (reach, envelopes, preconditions). */
  admit?(embodiment: string, type: string, params: Record<string, unknown>): AdmitVerdict;
  /** Start executing an admitted action. */
  start(embodiment: string, type: string, params: Record<string, unknown>, ctx: StartContext): ActionRun;
  /** Put an embodiment into its declared safe state. */
  safeStop(embodiment: string): void;
  /** Render state for the UI (not part of AWP). */
  view(): View;
  /** Static render data sent once per inspector connection (e.g. the maze layout). */
  staticView?(): unknown;
  /** Operator-level commands from the UI (not part of AWP), e.g. changing a spawn rate. */
  operator?(name: string, args: unknown): unknown;
}

export interface CreateSimOptions {
  seed: number;
  initialState: string;
}

export interface WorldDefinition<View = unknown> {
  manifest: WorldManifest;
  createSim(opts: CreateSimOptions): Sim<View>;
  /** Lockstep: simulated time per advance (default 50 ms). */
  tickMs?: number;
  /** Streaming: fixed sim step (default 1000/60 ms). */
  stepMs?: number;
  frameTree?: FrameTree;
  /** Default 5000 ms. */
  heartbeatIntervalMs?: number;
  /** Default 30000 ms. */
  reconnectWindowMs?: number;
  /** Seed used when a session or reset does not name one. */
  defaultSeed?: number;
}
