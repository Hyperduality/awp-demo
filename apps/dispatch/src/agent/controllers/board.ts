import type { ControlContext } from "@awp-demo/agent";
import type { ReceivedFrame } from "@hyperduality/awp";
import {
  type CallObs,
  type CallsPayload,
  KIND_NOUN,
  KINDS,
  type Kind,
  type ShiftPayload,
  type UnitObs,
  type UnitsPayload,
} from "../../shared/city.ts";

/** The dispatch board as the agent last observed it. */
export interface Board {
  units: UnitObs[];
  calls: CallsPayload;
  shift: ShiftPayload | undefined;
}

export function readBoard(ctx: ControlContext<unknown>): Board | undefined {
  const units = ctx.latest<UnitsPayload>("units");
  const calls = ctx.latest<CallsPayload>("calls");
  if (!units || !calls) return undefined;
  return { units: units.units, calls, shift: ctx.latest<ShiftPayload>("shift") };
}

/** The frame a decision on the board rests on: the newer of the units and calls frames. */
export function basisOf(ctx: ControlContext<unknown>): ReceivedFrame | undefined {
  const a = ctx.frame("units");
  const b = ctx.frame("calls");
  if (!a || !b) return a ?? b;
  return a.frame.ts_mono_ns >= b.frame.ts_mono_ns ? a : b;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const seconds = (s: number) => `${Math.round(s)} s`;

function where(u: UnitObs): string {
  return Number.isInteger(u.x) && Number.isInteger(u.y) ? `at ${u.near}` : `near ${u.near}`;
}

function doing(u: UnitObs): string {
  switch (u.status) {
    case "available":
      return "available";
    case "en_route":
      return `en route to #${u.call}, ETA ${seconds(u.eta_s ?? 0)}`;
    case "on_scene":
      return `on scene at #${u.call}, ${Math.round((u.work ?? 0) * 100)}% done`;
    case "staging":
      return `staging to ${u.to}, ETA ${seconds(u.eta_s ?? 0)}`;
  }
}

function describeCall(c: CallObs): string {
  const sent = c.units.map((s) =>
    s.status === "en_route"
      ? `${s.unit} en route (ETA ${seconds(s.eta_s ?? 0)})`
      : `${s.unit} ${s.status.replace("_", " ")}`,
  );
  const etas = Object.entries(c.eta_s)
    .sort((a, b) => a[1] - b[1])
    .map(([u, s]) => `${u} ${seconds(s)}`);
  return [
    `#${c.id} at ${c.at}, ${seconds(c.age_s)} ago: "${c.text}"`,
    ...c.updates.map((u) => `  update: ${u}`),
    `  sent: ${sent.length > 0 ? sent.join(", ") : "nobody"}`,
    `  ETA if sent now: ${etas.join(", ")}`,
  ].join("\n");
}

/** The board as text for a model: the shift, open calls oldest first, units, recent outcomes. */
export function renderBoard(b: Board): string {
  const s = b.shift;
  const head = s
    ? s.phase === "waiting"
      ? "The shift has not started yet."
      : `Shift ${clock(s.clock_s)} of ${clock(s.clock_s + s.left_s)}${s.phase === "over" ? " (over)" : ""} · speed ${s.speed}× · score ${s.score} · resolved ${s.resolved} · lost ${s.lost}${s.avg_response_s !== null ? ` · average response ${seconds(s.avg_response_s)}` : ""}`
    : "No shift information yet.";
  const open = b.calls.open.length > 0 ? b.calls.open.map(describeCall).join("\n") : "(none)";
  const units = b.units.map((u) => `${u.id} (${KIND_NOUN[u.kind]}) ${where(u)}: ${doing(u)}`).join("\n");
  const closed = b.calls.closed
    .slice(0, 5)
    .map((c) => `#${c.id} ${c.outcome} ${c.points > 0 ? "+" : ""}${c.points} (${c.note})`)
    .join("; ");
  return [
    head,
    `Open calls, oldest first:\n${open}`,
    `Units:\n${units}`,
    closed && `Recently closed: ${closed}`,
    "Times are shift seconds.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What changed between two frames of a channel that a dispatcher should act on: new calls and updates. */
export function boardNews(channel: string, payload: unknown, previous: unknown): string[] {
  if (previous === undefined) return [];
  if (channel === "calls") {
    const now = payload as CallsPayload;
    const before = previous as CallsPayload;
    const lines: string[] = [];
    for (const c of now.open) {
      const old = before.open.find((o) => o.id === c.id);
      if (!old) lines.push(`New call #${c.id} at ${c.at}: "${c.text}"`);
      else for (const u of c.updates.slice(old.updates.length)) lines.push(`Call #${c.id}: ${u}`);
    }
    return lines;
  }
  if (channel === "shift") {
    const now = payload as ShiftPayload;
    const before = previous as ShiftPayload;
    if (now.phase === before.phase) return [];
    if (now.phase === "on") return ["The shift has started."];
    if (now.phase === "over")
      return [`The shift is over: score ${now.score}, ${now.resolved} resolved, ${now.lost} lost, ${now.open} open.`];
    return ["The world was reset; a new shift is waiting to start."];
  }
  return [];
}

/** What changed that a dispatcher should know but need not act on: calls closing. */
export function boardNotes(channel: string, payload: unknown, previous: unknown): string[] {
  if (channel !== "calls" || previous === undefined) return [];
  const before = previous as CallsPayload;
  return (payload as CallsPayload).closed
    .filter((c) => !before.closed.some((o) => o.id === c.id))
    .map((c) => `Call #${c.id} ${c.outcome} (${c.points > 0 ? "+" : ""}${c.points}): ${c.note}`);
}

// ---------------------------------------------------------------------------------------------
// Keyword triage, for the scripted dispatcher

const KEYWORDS: Record<Kind, RegExp> = {
  fire: /\b(fire|flames?|smoke|burning|gas|rotten eggs|spark\w*)\b/i,
  medical:
    /\b(breath\w*|collapsed|bleed\w*|hurt|pain|unconscious|injur\w*|fell|fallen|broken|overdose|allerg\w*|pulse|pale|faint|dizzy|passed out|swelling|blue)\b/i,
  police:
    /\b(knife|gun|fight\w*|punch\w*|break\w*|smash\w*|steal\w*|shoplift\w*|suspicious|threat\w*|followed|alarm|parked|jump|hit|drove off|wandering|flooding|fireworks)\b/i,
};

/** How many units of each kind a call seems to need, from its words and the reports from the scene. */
export function triage(c: CallObs): Record<Kind, number> {
  const words = [c.text, ...c.updates.filter((u) => u.startsWith("Caller"))].join(" ");
  const want = Object.fromEntries(KINDS.map((k) => [k, KEYWORDS[k].test(words) ? 1 : 0])) as Record<Kind, number>;
  if (KINDS.every((k) => want[k] === 0)) want.police = 1;
  for (const u of c.updates) {
    for (const k of KINDS) {
      const noun = KIND_NOUN[k];
      if (u.includes(`needs another ${noun}`)) want[k] += 1;
      else if (u.includes(`needs a ${noun} too`) || u.includes(`needs an ${noun} too`)) want[k] = Math.max(want[k], 1);
      else if (u.includes(`no ${noun} needed`)) want[k] = 0;
    }
  }
  return want;
}
