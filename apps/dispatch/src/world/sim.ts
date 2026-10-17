import { type ActionRun, type AdmitVerdict, mulberry32, type RunStatus, type Sim } from "@awp-demo/world";
import {
  type CallObs,
  type CallsPayload,
  type CallView,
  CITY,
  type ClosedCallObs,
  connected,
  type DispatchLayout,
  type DispatchView,
  KIND_NOUN,
  KINDS,
  type Kind,
  nodeName,
  nodeXY,
  type Phase,
  type ShiftPayload,
  STATIONS,
  UNITS,
  type UnitDecl,
  type UnitObs,
  type UnitStatus,
  type UnitsPayload,
  WORK_S,
} from "../shared/city.ts";
import { CALLS, type CallTemplate, ESCALATE_AT, WINDOW_S } from "./calls.ts";

const STATES: Record<string, { gapS: number; lengthS: number }> = {
  default: { gapS: 16, lengthS: 360 },
  rush: { gapS: 8, lengthS: 300 },
};

export const SPEEDS = [0.5, 1, 2, 3] as const;

const N = CITY.cols * CITY.rows;
const idx = (x: number, y: number) => y * CITY.cols + x;
const xyOf = (i: number): [number, number] => [i % CITY.cols, Math.floor(i / CITY.cols)];

/** Streets as adjacency lists, and every shortest distance between intersections, in blocks. */
const NEIGHBOURS: number[][] = Array.from({ length: N }, (_, i) => {
  const [x, y] = xyOf(i);
  return (
    [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ] as const
  )
    .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < CITY.cols && ny < CITY.rows && connected(x, y, nx, ny))
    .map(([nx, ny]) => idx(nx, ny));
});
const DIST: number[][] = Array.from({ length: N }, (_, from) => {
  const d = new Array<number>(N).fill(Infinity);
  d[from] = 0;
  const queue = [from];
  while (queue.length > 0) {
    const i = queue.shift()!;
    for (const n of NEIGHBOURS[i]!) {
      if (d[n] !== Infinity) continue;
      d[n] = d[i]! + 1;
      queue.push(n);
    }
  }
  return d;
});

/** The intersections after `from` on a shortest route to `to`. */
function route(from: number, to: number): number[] {
  const out: number[] = [];
  let at = from;
  while (at !== to) {
    at = NEIGHBOURS[at]!.find((n) => DIST[n]![to] === DIST[at]![to]! - 1)!;
    out.push(at);
  }
  return out;
}

/** On the block from `from` to `to`, `f` of the way along; at `from` when the two are the same. */
interface Pos {
  from: number;
  to: number;
  f: number;
}

interface Task {
  type: "dispatch" | "stage";
  actionId: string;
  target: number;
  call?: Call;
  phase: "drive" | "work";
  worked: number;
  /** Blocks to drive when it began, for progress. */
  total: number;
}

interface Unit {
  decl: UnitDecl;
  pos: Pos;
  route: number[];
  task: Task | undefined;
}

interface Call {
  id: number;
  at: number;
  template: CallTemplate;
  text: string;
  updates: string[];
  received: number;
  window: number;
  severity: number;
  needs: Partial<Record<Kind, number>>;
  done: Partial<Record<Kind, number>>;
  /** Units on scene doing work it needs. */
  working: Map<string, Kind>;
  /** Units that finished their part. */
  helped: string[];
  /** Kinds already reported missing from the scene. */
  reported: Set<Kind>;
  escalated: boolean;
  firstWork: number | undefined;
  state: "open" | "resolved" | "lost";
  closedAt: number;
  points: number;
  note: string;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A city's emergency services through one shift. Calls arrive on a schedule drawn from the seed, so
 * two runs with the same seed get the same calls whatever the dispatcher does. Time runs at `speed`
 * times the wall clock; every duration here is in shift seconds.
 */
export class DispatchSim implements Sim<DispatchView> {
  private readonly rand: () => number;
  private readonly gapS: number;
  private readonly lengthS: number;
  private phase: Phase = "waiting";
  private speed = 1;
  private clock = 0;
  private nextCallAt = 3;
  private serial = 0;
  private readonly units = new Map<string, Unit>();
  private readonly calls = new Map<number, Call>();
  private readonly closed: Call[] = [];
  private readonly score = { points: 0, resolved: 0, lost: 0, responses: [] as number[] };

  constructor(seed: number, initialState: string) {
    this.rand = mulberry32(seed);
    const s = STATES[initialState] ?? STATES.default!;
    this.gapS = s.gapS;
    this.lengthS = s.lengthS;
    for (const decl of UNITS) {
      const [x, y] = nodeXY(decl.home)!;
      const at = idx(x, y);
      this.units.set(decl.id, { decl, pos: { from: at, to: at, f: 0 }, route: [], task: undefined });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The shift

  step(dtMs: number): void {
    if (this.phase !== "on") return;
    const dt = (dtMs / 1000) * this.speed;
    this.clock += dt;
    while (this.clock >= this.nextCallAt && this.nextCallAt < this.lengthS) {
      this.spawn(this.nextCallAt);
      const gap = -Math.log(1 - this.rand()) * this.gapS;
      this.nextCallAt += Math.min(3 * this.gapS, Math.max(3, gap));
    }
    for (const call of this.calls.values()) {
      if (call.state !== "open") continue;
      const age = this.clock - call.received;
      if (!call.escalated && call.firstWork === undefined && age >= ESCALATE_AT * call.window) this.escalate(call);
      if (age >= call.window) this.close(call, "lost");
    }
    if (this.clock >= this.lengthS) {
      this.clock = this.lengthS;
      this.phase = "over";
    }
  }

  private spawn(at: number): void {
    const template = CALLS[Math.floor(this.rand() * CALLS.length)]!;
    const text = template.texts[Math.floor(this.rand() * template.texts.length)]!;
    const taken = new Set([...this.calls.values()].filter((c) => c.state === "open").map((c) => c.at));
    const places =
      template.where === "bridge"
        ? CITY.bridges.flatMap((x) => [idx(x, CITY.riverAfter), idx(x, CITY.riverAfter + 1)])
        : Array.from({ length: N }, (_, i) => i);
    const free = places.filter((i) => !taken.has(i));
    const node = (free.length > 0 ? free : places)[Math.floor(this.rand() * (free.length || places.length))]!;
    const id = ++this.serial;
    this.calls.set(id, {
      id,
      at: node,
      template,
      text,
      updates: [],
      received: at,
      window: WINDOW_S[template.severity],
      severity: template.severity,
      needs: { ...template.needs },
      done: {},
      working: new Map(),
      helped: [],
      reported: new Set(),
      escalated: false,
      firstWork: undefined,
      state: "open",
      closedAt: 0,
      points: 0,
      note: "",
    });
  }

  private escalate(call: Call): void {
    call.escalated = true;
    call.severity = Math.min(3, call.severity + 1);
    const e = call.template.escalation ?? { text: "Caller: is anyone coming? It's getting worse." };
    call.updates.push(e.text);
    for (const [kind, n] of Object.entries(e.add ?? {}) as [Kind, number][]) {
      const roster = UNITS.filter((u) => u.kind === kind).length;
      call.needs[kind] = Math.min(roster, (call.needs[kind] ?? 0) + n);
    }
  }

  private close(call: Call, outcome: "resolved" | "lost"): void {
    call.state = outcome;
    call.closedAt = this.clock;
    const took = Math.round(this.clock - call.received);
    if (outcome === "resolved") {
      const left = Math.max(0, call.received + call.window - this.clock) / call.window;
      call.points = Math.round(50 * call.severity * (1 + left));
      call.note = `resolved in ${took} s`;
      this.score.resolved += 1;
    } else {
      call.points = -100 * call.severity;
      const missing = KINDS.filter((k) => (call.done[k] ?? 0) < (call.needs[k] ?? 0));
      call.note = `lost after ${took} s: no ${missing.map((k) => KIND_NOUN[k]).join(" or ")} in time`;
      this.score.lost += 1;
    }
    this.score.points += call.points;
    call.working.clear();
    this.calls.delete(call.id);
    this.closed.unshift(call);
    if (this.closed.length > 40) this.closed.length = 40;
  }

  // ---------------------------------------------------------------------------------------------
  // Units

  admit(embodiment: string, type: string, params: Record<string, unknown>): AdmitVerdict {
    if (!this.units.has(embodiment)) return { error: "AWP_PARAMS_INVALID", detail: `no unit ${embodiment}` };
    if (type !== "dispatch") return { ok: true };
    const id = params.call as number;
    if (this.calls.has(id)) return { ok: true };
    const closed = this.closed.find((c) => c.id === id);
    return {
      error: "AWP_PARAMS_INVALID",
      detail: closed ? `call #${id} is closed (${closed.state})` : `there is no call #${id}`,
    };
  }

  start(embodiment: string, type: string, params: Record<string, unknown>, ctx: { actionId: string }): ActionRun {
    const unit = this.units.get(embodiment)!;
    this.release(unit);
    const call = type === "dispatch" ? this.calls.get(params.call as number) : undefined;
    const [tx, ty] = call ? xyOf(call.at) : nodeXY(params.at as string)!;
    const task: Task = {
      type: type as Task["type"],
      actionId: ctx.actionId,
      target: idx(tx, ty),
      ...(call ? { call } : {}),
      phase: "drive",
      worked: 0,
      total: 0,
    };
    unit.task = task;
    task.total = this.plan(unit, task.target);
    return {
      update: (dtMs) => this.drive(unit, task, (dtMs / 1000) * this.speed),
      // Pulling over takes a moment; the unit stays where it stopped.
      abort: () => {
        this.release(unit, task);
        return 300;
      },
    };
  }

  safeStop(embodiment: string): void {
    const unit = this.units.get(embodiment);
    if (unit) this.release(unit);
  }

  /** Ends a unit's task (if it is still `task`): it stops where it is and leaves any scene. */
  private release(unit: Unit, task: Task | undefined = unit.task): void {
    if (!task || unit.task !== task) return;
    unit.task = undefined;
    unit.route = [];
    task.call?.working.delete(unit.decl.id);
  }

  /** Points the unit at `target` by the shortest way, turning back mid-block if that is shorter. */
  private plan(unit: Unit, target: number): number {
    const p = unit.pos;
    if (p.from === p.to) {
      unit.route = route(p.from, target);
      return DIST[p.from]![target]!;
    }
    const ahead = 1 - p.f + DIST[p.to]![target]!;
    const back = p.f + DIST[p.from]![target]!;
    if (ahead <= back) {
      unit.route = route(p.to, target);
      return ahead;
    }
    unit.pos = { from: p.to, to: p.from, f: 1 - p.f };
    unit.route = route(unit.pos.to, target);
    return back;
  }

  private remaining(unit: Unit): number {
    return (unit.pos.from === unit.pos.to ? 0 : 1 - unit.pos.f) + unit.route.length;
  }

  private drive(unit: Unit, task: Task, dt: number): RunStatus {
    const call = task.call;
    const name = unit.decl.label;
    if (unit.task !== task) return { failed: "world_error", detail: `${name} was stopped` };
    if (call && call.state !== "open") {
      this.release(unit, task);
      return { failed: "world_error", detail: `call #${call.id} was ${call.state} before ${name} could finish` };
    }
    if (task.phase === "drive") {
      let d = unit.decl.speed * dt;
      const p = unit.pos;
      while (d > 1e-9) {
        if (p.from === p.to) {
          const next = unit.route.shift();
          if (next === undefined) break;
          p.to = next;
          p.f = 0;
        }
        const left = 1 - p.f;
        if (d < left) {
          p.f += d;
          d = 0;
        } else {
          d -= left;
          p.from = p.to;
          p.f = 0;
        }
      }
      const rest = this.remaining(unit);
      const driven = task.total > 0 ? 1 - rest / task.total : 1;
      if (rest > 1e-9) return { progress: (call ? 0.6 : 1) * driven };
      if (!call) {
        this.release(unit, task);
        return { done: true };
      }
      return this.arrive(unit, task, call);
    }
    task.worked += dt;
    const kind = unit.decl.kind;
    if (task.worked < WORK_S[kind]) return { progress: 0.6 + (0.4 * task.worked) / WORK_S[kind] };
    call!.working.delete(unit.decl.id);
    call!.done[kind] = (call!.done[kind] ?? 0) + 1;
    call!.helped.push(unit.decl.id);
    this.release(unit, task);
    if (KINDS.every((k) => (call!.done[k] ?? 0) >= (call!.needs[k] ?? 0))) this.close(call!, "resolved");
    return { done: true };
  }

  /** On scene: work if the call still needs this kind, and report what else it needs. */
  private arrive(unit: Unit, task: Task, call: Call): RunStatus {
    const kind = unit.decl.kind;
    const busy = [...call.working.values()].filter((k) => k === kind).length;
    const needed = (call.needs[kind] ?? 0) - (call.done[kind] ?? 0) - busy > 0;
    // Who is covering what: units on their way or at work here, this one included if it stays.
    const covering = [...this.units.values()]
      .filter((u) => u.task?.call === call && (u !== unit || needed))
      .map((u) => u.decl.kind);
    for (const k of KINDS) {
      const short = (call.needs[k] ?? 0) - (call.done[k] ?? 0) - covering.filter((c) => c === k).length;
      if (short <= 0 || call.reported.has(k)) continue;
      call.reported.add(k);
      const noun = KIND_NOUN[k];
      call.updates.push(
        `${unit.decl.label} on scene: this needs ${covering.includes(k) ? `another ${noun}` : `${article(noun)} too`}.`,
      );
    }
    if (!needed) {
      call.updates.push(`${unit.decl.label} on scene: no ${KIND_NOUN[kind]} needed here.`);
      this.release(unit, task);
      return { done: true };
    }
    task.phase = "work";
    call.working.set(unit.decl.id, kind);
    if (call.firstWork === undefined) {
      call.firstWork = this.clock;
      this.score.responses.push(this.clock - call.received);
    }
    return { progress: 0.6 };
  }

  // ---------------------------------------------------------------------------------------------
  // Observation

  private xy(unit: Unit): [number, number] {
    const [ax, ay] = xyOf(unit.pos.from);
    const [bx, by] = xyOf(unit.pos.to);
    return [ax + (bx - ax) * unit.pos.f, ay + (by - ay) * unit.pos.f];
  }

  /** Shift seconds for a unit to reach intersection `target` if sent now. */
  private eta(unit: Unit, target: number): number {
    const p = unit.pos;
    const blocks =
      p.from === p.to ? DIST[p.from]![target]! : Math.min(1 - p.f + DIST[p.to]![target]!, p.f + DIST[p.from]![target]!);
    return blocks / unit.decl.speed;
  }

  private status(unit: Unit): UnitStatus {
    const t = unit.task;
    if (!t) return "available";
    if (t.type === "stage") return "staging";
    return t.phase === "drive" ? "en_route" : "on_scene";
  }

  observe(channel: string): unknown {
    if (channel === "units") return this.unitsPayload();
    if (channel === "calls") return this.callsPayload();
    if (channel === "shift") return this.shiftPayload();
    throw new Error(`no channel ${channel}`);
  }

  private unitsPayload(): UnitsPayload {
    return {
      units: [...this.units.values()].map((u): UnitObs => {
        const [x, y] = this.xy(u);
        const t = u.task;
        return {
          id: u.decl.id,
          kind: u.decl.kind,
          label: u.decl.label,
          x: round2(x),
          y: round2(y),
          near: nodeName(Math.round(x), Math.round(y)),
          status: this.status(u),
          ...(t?.call ? { call: t.call.id } : {}),
          ...(t?.type === "stage" ? { to: nodeName(...xyOf(t.target)) } : {}),
          ...(t?.phase === "drive" ? { eta_s: round1(this.remaining(u) / u.decl.speed) } : {}),
          ...(t?.phase === "work" ? { work: round2(t.worked / WORK_S[u.decl.kind]) } : {}),
          ...(t ? { action_id: t.actionId } : {}),
        };
      }),
    };
  }

  private callsPayload(): CallsPayload {
    const open = [...this.calls.values()].map((c): CallObs => {
      const sent = [...this.units.values()].filter((u) => u.task?.call === c);
      return {
        id: c.id,
        at: nodeName(...xyOf(c.at)),
        received_s: round1(c.received),
        age_s: round1(this.clock - c.received),
        text: c.text,
        updates: [...c.updates],
        units: [
          ...sent.map((u) =>
            u.task!.phase === "drive"
              ? { unit: u.decl.id, status: "en_route" as const, eta_s: round1(this.remaining(u) / u.decl.speed) }
              : { unit: u.decl.id, status: "on_scene" as const },
          ),
          ...c.helped.map((id) => ({ unit: id, status: "done" as const })),
        ],
        eta_s: Object.fromEntries([...this.units.values()].map((u) => [u.decl.id, round1(this.eta(u, c.at))])),
      };
    });
    const closed = this.closed.slice(0, 8).map(
      (c): ClosedCallObs => ({
        id: c.id,
        at: nodeName(...xyOf(c.at)),
        outcome: c.state as "resolved" | "lost",
        points: c.points,
        took_s: round1(c.closedAt - c.received),
        note: c.note,
      }),
    );
    return { open, closed };
  }

  private shiftPayload(): ShiftPayload {
    const r = this.score.responses;
    return {
      phase: this.phase,
      clock_s: round1(this.clock),
      left_s: round1(Math.max(0, this.lengthS - this.clock)),
      speed: this.speed,
      score: this.score.points,
      resolved: this.score.resolved,
      lost: this.score.lost,
      open: this.calls.size,
      calls: this.serial,
      avg_response_s: r.length > 0 ? round1(r.reduce((a, b) => a + b, 0) / r.length) : null,
    };
  }

  view(): DispatchView {
    return {
      shift: this.shiftPayload(),
      units: [...this.units.values()].map((u) => ({
        id: u.decl.id,
        kind: u.decl.kind,
        label: u.decl.label,
        x: this.xy(u)[0],
        y: this.xy(u)[1],
        status: this.status(u),
        call: u.task?.call?.id,
        to: u.task?.type === "stage" ? nodeName(...xyOf(u.task.target)) : undefined,
        path: [this.xy(u), ...(u.pos.from === u.pos.to ? [] : [xyOf(u.pos.to)]), ...u.route.map(xyOf)],
      })),
      calls: [...this.calls.values()].map(
        (c): CallView => ({
          id: c.id,
          at: nodeName(...xyOf(c.at)),
          x: xyOf(c.at)[0],
          y: xyOf(c.at)[1],
          text: c.text,
          updates: [...c.updates],
          age_s: this.clock - c.received,
          window_s: c.window,
          severity: c.severity,
          needs: { ...c.needs },
          done: { ...c.done },
        }),
      ),
      closed: this.closed
        .filter((c) => this.clock - c.closedAt < 6)
        .map((c) => ({
          id: c.id,
          x: xyOf(c.at)[0],
          y: xyOf(c.at)[1],
          outcome: c.state as "resolved" | "lost",
          points: c.points,
          ago_s: this.clock - c.closedAt,
        })),
    };
  }

  staticView(): DispatchLayout {
    return {
      cols: CITY.cols,
      rows: CITY.rows,
      riverAfter: CITY.riverAfter,
      bridges: [...CITY.bridges],
      stations: STATIONS.map((s) => {
        const [x, y] = nodeXY(s.at)!;
        return { ...s, x, y };
      }),
    };
  }

  operator(name: string, args: unknown): unknown {
    if (name === "start" && this.phase === "waiting") this.phase = "on";
    if (name === "speed") {
      const v = Number((args as { speed?: unknown } | undefined)?.speed);
      if ((SPEEDS as readonly number[]).includes(v)) this.speed = v;
    }
    return this.shiftPayload();
  }
}

function article(noun: string): string {
  return `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
}
