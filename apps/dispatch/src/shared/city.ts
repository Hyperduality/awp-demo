/** The city, its units, and the payloads, shared by the world, the controllers, and the view. */

export const PORTS = { world: 8714, worldInspector: 8814, agentInspector: 8914, ui: 5174 } as const;

/**
 * A grid of intersections: avenues A–I run north–south (x 0–8), streets 1–7 run east–west (y 0–6,
 * street 1 at the north). Blocks are one unit long. A river runs between streets 4 and 5, crossed
 * only by the bridges on avenues B, E and H.
 */
export const CITY = {
  cols: 9,
  rows: 7,
  /** The river lies between y = riverAfter and y = riverAfter + 1. */
  riverAfter: 3,
  bridges: [1, 4, 7],
} as const;

export type Kind = "fire" | "medical" | "police";
export const KINDS: Kind[] = ["fire", "medical", "police"];
export const KIND_NOUN: Record<Kind, string> = { fire: "fire engine", medical: "ambulance", police: "police car" };

export interface UnitDecl {
  id: string;
  kind: Kind;
  label: string;
  /** Blocks per second of shift time. */
  speed: number;
  home: string;
}

export const UNITS: UnitDecl[] = [
  { id: "engine_1", kind: "fire", label: "Engine 1", speed: 0.9, home: "B2" },
  { id: "engine_2", kind: "fire", label: "Engine 2", speed: 0.9, home: "B2" },
  { id: "medic_1", kind: "medical", label: "Medic 1", speed: 1.1, home: "G2" },
  { id: "medic_2", kind: "medical", label: "Medic 2", speed: 1.1, home: "G2" },
  { id: "police_1", kind: "police", label: "Patrol 1", speed: 1.3, home: "E6" },
  { id: "police_2", kind: "police", label: "Patrol 2", speed: 1.3, home: "E6" },
];

export const STATIONS = [
  { id: "fire", label: "Fire station", at: "B2", kind: "fire" as Kind },
  { id: "hospital", label: "Hospital", at: "G2", kind: "medical" as Kind },
  { id: "police", label: "Police HQ", at: "E6", kind: "police" as Kind },
];

/** Seconds a unit works a scene where its kind is needed. */
export const WORK_S: Record<Kind, number> = { fire: 8, medical: 6, police: 5 };

export const NODE_PATTERN = "^[A-I][1-7]$";

export function nodeName(x: number, y: number): string {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
}

export function nodeXY(name: string): [number, number] | undefined {
  const m = /^([A-I])([1-7])$/.exec(name);
  return m ? [m[1]!.charCodeAt(0) - 65, Number(m[2]) - 1] : undefined;
}

/** Whether the block between two neighbouring intersections is a street (the river cuts some). */
export function connected(ax: number, ay: number, bx: number, by: number): boolean {
  if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1) return false;
  if (ax === bx && Math.min(ay, by) === CITY.riverAfter) return (CITY.bridges as readonly number[]).includes(ax);
  return true;
}

export type Phase = "waiting" | "on" | "over";
export type UnitStatus = "available" | "en_route" | "on_scene" | "staging";

// ---------------------------------------------------------------------------------------------
// Observation payloads

export interface UnitObs {
  id: string;
  kind: Kind;
  label: string;
  /** Position in blocks: x east from avenue A, y south from street 1. */
  x: number;
  y: number;
  /** The nearest intersection. */
  near: string;
  status: UnitStatus;
  /** The call it is going to or working. */
  call?: number;
  /** Where it is staging. */
  to?: string;
  /** Seconds of driving left. */
  eta_s?: number;
  /** Share of its work on scene done, 0–1. */
  work?: number;
  /** The action moving it. */
  action_id?: string;
}

export interface UnitsPayload {
  units: UnitObs[];
}

export interface CallObs {
  id: number;
  at: string;
  /** Shift clock when the call came in. */
  received_s: number;
  age_s: number;
  /** What the caller said. */
  text: string;
  /** Later news: the caller again, or a unit's report from the scene. */
  updates: string[];
  /** Units sent to it, and how they are doing. */
  units: { unit: string; status: "en_route" | "on_scene" | "done"; eta_s?: number }[];
  /** Seconds each unit would take to get there if sent now. */
  eta_s: Record<string, number>;
}

export interface ClosedCallObs {
  id: number;
  at: string;
  outcome: "resolved" | "lost";
  points: number;
  /** Seconds from the call to its close. */
  took_s: number;
  /** What happened, in a line. */
  note: string;
}

export interface CallsPayload {
  open: CallObs[];
  /** The latest closed calls, newest first. */
  closed: ClosedCallObs[];
}

export interface ShiftPayload {
  phase: Phase;
  /** Shift clock, seconds since the shift started. */
  clock_s: number;
  left_s: number;
  /** How fast the city runs, against the wall clock. */
  speed: number;
  score: number;
  resolved: number;
  lost: number;
  open: number;
  calls: number;
  /** Mean seconds from a call to the first unit it needed working the scene. */
  avg_response_s: number | null;
}

// ---------------------------------------------------------------------------------------------
// The render view (not AWP)

export interface UnitView {
  id: string;
  kind: Kind;
  label: string;
  x: number;
  y: number;
  status: UnitStatus;
  call?: number | undefined;
  to?: string | undefined;
  /** Points still to drive through, current position first. */
  path: [number, number][];
}

export interface CallView {
  id: number;
  at: string;
  x: number;
  y: number;
  text: string;
  updates: string[];
  age_s: number;
  /** Shift seconds the call has in all, and its truth: what it needs and how bad it is. */
  window_s: number;
  severity: number;
  needs: Partial<Record<Kind, number>>;
  done: Partial<Record<Kind, number>>;
}

export interface ClosedView {
  id: number;
  x: number;
  y: number;
  outcome: "resolved" | "lost";
  points: number;
  /** Shift seconds since it closed. */
  ago_s: number;
}

export interface DispatchView {
  shift: ShiftPayload;
  units: UnitView[];
  calls: CallView[];
  closed: ClosedView[];
}

export interface DispatchLayout {
  cols: number;
  rows: number;
  riverAfter: number;
  bridges: number[];
  stations: { id: string; label: string; at: string; x: number; y: number; kind: Kind }[];
}
