import type { ActivityEntry, ControllerKind } from "@awp-demo/inspector";
import type { ActionRecord, TimeModel, WorldManifest } from "@hyperduality/awp";
import type { z } from "zod";

/**
 * A way of driving the world: a person at the keyboard, a program, a language model. Several can be
 * enabled on the one session; the mux gives authority to one at a time.
 */
export interface Controller<C = unknown> {
  id: string;
  kind: ControllerKind;
  label: string;
  /** One sentence for the UI. */
  description: string;
  /** Higher wins while engaged. Defaults: manual 30, llm 20, program 10. */
  priority?: number;
  /**
   * Lockstep only: whether time flows while this controller holds authority (`continuous`), or only
   * while it waits on the world (`on-wait`, e.g. an LLM that should not lose ticks while it thinks).
   */
  time?: "continuous" | "on-wait";
  config: z.ZodType<C>;
  /** Enabled when the agent starts (default true). */
  enabled?: boolean;
  /** Called when enabled with a live session; the instance lives until disabled or the session ends. */
  create(ctx: ControlContext<C>): ControllerInstance<C>;
}

export interface ControllerInstance<C = unknown> {
  stop?(): void;
  /** Operator input from the UI (manual controllers). */
  input?(input: unknown): void;
  /** An operator message (LLM controllers). */
  message?(text: string): void;
  /** The operator pressed Stop: abandon the current work but stay enabled. */
  interrupt?(): void;
  configure?(config: C): void;
  /** Gained or lost authority. */
  authority?(has: boolean): void;
}

export interface SubmitOptions {
  embodiment?: string;
  preempt?: "queue" | "replace" | "blend" | "reject";
  deadlineMs?: number;
}

export interface HistoryEntry {
  actionId: string;
  source: string;
  type: string;
  params: Record<string, unknown>;
  state: string;
  reason?: string | undefined;
  ts: number;
}

export type LogInput = Omit<ActivityEntry, "id" | "ts" | "source"> & { id?: string };

/** A controller's view of the one session, mediated by the mux. */
export interface ControlContext<C = unknown> {
  readonly id: string;
  readonly manifest: WorldManifest;
  readonly mode: TimeModel;
  readonly embodiments: string[];
  /** Aborted when the instance stops. */
  readonly signal: AbortSignal;
  readonly config: C;
  /** Simulated ms per advance in lockstep (learned from the session clock). */
  readonly tickMs: number;

  /** The newest decoded payload on a channel. */
  latest<T = unknown>(channel: string): T | undefined;
  onFrame<T = unknown>(channel: string, fn: (payload: T) => void): () => void;
  /** Resolves on the next frame (streaming) or the next advance (lockstep). Requests no time. */
  nextObservation(): Promise<void>;

  readonly hasAuthority: boolean;
  /** Ask for control; the highest-priority engaged controller holds it. */
  engage(): void;
  release(): void;
  /** Engage and wait until authority is granted. */
  acquire(): Promise<void>;

  /** Submit as this controller. Waits for authority while engaged; throws `NotInControlError` otherwise. */
  submit(type: string, params: Record<string, unknown>, opts?: SubmitOptions): Promise<ActionRecord>;
  cancel(actionId: string): Promise<void>;
  /** One setpoint on a command channel (streaming actions). */
  command(channel: string, payload: unknown): Promise<void>;
  /** Wait for an action to end, letting time pass in lockstep. */
  settle(rec: ActionRecord, opts?: { maxTicks?: number; timeoutMs?: number }): Promise<ActionRecord>;
  /** Let time pass: ticks in lockstep, ms in streaming (either is converted). */
  wait(opts: { ticks?: number; ms?: number }): Promise<void>;

  /** Recent actions by every controller, oldest first. */
  history(limit?: number): HistoryEntry[];
  /** Adds (or, with an id, upserts) an activity entry from this controller; returns its id. */
  log(entry: LogInput): string;
  /** A short present-tense status for the UI, or undefined. */
  status(text?: string): void;
}

export class NotInControlError extends Error {
  constructor(id: string) {
    super(`${id} does not hold control`);
    this.name = "NotInControlError";
  }
}

export const DEFAULT_PRIORITY: Record<ControllerKind, number> = { manual: 30, llm: 20, program: 10 };
