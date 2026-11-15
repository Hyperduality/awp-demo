import { type ControlContext, NotInControlError } from "@awp-demo/agent";
import { AwpError, type ReceivedFrame } from "@hyperduality/awp";
import type { Proprio, Scene, SceneEntity, TaskObs } from "../../shared/yard.ts";

interface Sighting {
  entity: SceneEntity;
  /** The bay it stood in, when it stood in one. */
  bay: string | undefined;
  /** Wall-clock ms of the scene frame it was last in. */
  at: number;
  visible: boolean;
}

/**
 * The agent's own map of the yard. The scene channel lists a movable thing only while the truck's
 * sensors pick it out, so what is out of sight has to be remembered here: where it was, and how long
 * ago that was. Nothing in it comes from anywhere but the scene frames.
 */
export class YardMemory {
  private readonly sightings = new Map<string, Sighting>();

  update(scene: Scene, now = Date.now()): void {
    const bays = new Map(scene.relations.filter((r) => r.type === "in").map((r) => [r.subject, r.object]));
    for (const s of this.sightings.values()) s.visible = false;
    for (const entity of scene.entities) {
      if (entity.state?.source !== "sensors") continue;
      this.sightings.set(entity.id, { entity, bay: bays.get(entity.id), at: now, visible: true });
    }
  }

  get(id: string): Sighting | undefined {
    return this.sightings.get(id);
  }

  all(): Sighting[] {
    return [...this.sightings.values()];
  }
}

const memories = new WeakMap<object, YardMemory>();

/** The memory that goes with a controller's session, fed from its scene frames from the first call on. */
export function memoryOf(ctx: ControlContext<unknown>): YardMemory {
  let memory = memories.get(ctx);
  if (!memory) {
    memory = new YardMemory();
    memories.set(ctx, memory);
    const mine = memory;
    const seen = ctx.latest<Scene>("scene");
    if (seen) mine.update(seen);
    ctx.onFrame<Scene>("scene", (scene) => mine.update(scene));
  }
  return memory;
}

/** The yard as the agent knows it: what its channels say now, and what it remembers seeing. */
export interface Yard {
  truck: Proprio;
  scene: Scene;
  task: TaskObs | undefined;
  memory: YardMemory;
}

export function readYard(ctx: ControlContext<unknown>): Yard | undefined {
  const memory = memoryOf(ctx);
  const truck = ctx.latest<Proprio>("proprio");
  const scene = ctx.latest<Scene>("scene");
  if (!truck || !scene) return undefined;
  return { truck, scene, task: ctx.latest<TaskObs>("task"), memory };
}

/** The frame a decision about the yard rests on: where the truck is. */
export function basisOf(ctx: ControlContext<unknown>): ReceivedFrame | undefined {
  return ctx.frame("proprio");
}

/** Submits, treating the world's refusals (and losing control) as outcomes rather than crashes. */
export async function attempt<T>(p: Promise<T>): Promise<T | AwpError | undefined> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof AwpError) return e;
    if (e instanceof NotInControlError) return undefined;
    throw e;
  }
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const at = (e: SceneEntity) => `(${n1(e.pose.p_m[0])}, ${n1(e.pose.p_m[1])})`;
const compass = (yaw: number) => {
  const names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
  return names[((Math.round(yaw / (Math.PI / 4)) % 8) + 8) % 8];
};
const ago = (ms: number) =>
  ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : `${Math.round(ms / 60_000)} min ago`;

/**
 * The yard as text for a model: the truck, the orders with what is known of each pallet, what the
 * sensors show now, what was seen before, then the site map.
 */
export function renderYard(y: Yard, now = Date.now()): string {
  const t = y.truck;
  const [x, yy] = t.pose.p_m;
  const where = (id: string) => {
    const s = y.memory.get(id);
    if (!s) return "not seen yet";
    const place = `${at(s.entity)}${s.bay ? ` in ${s.bay}` : ""}`;
    return s.visible ? `in view at ${place}` : `last seen ${ago(now - s.at)} at ${place}`;
  };
  const lines: string[] = [];
  lines.push(
    `Truck at (${n1(x)}, ${n1(yy)}) heading ${compass(t.yaw_rad)} (yaw ${t.yaw_rad.toFixed(2)} rad), ${n1(Math.abs(t.v_mps))} m/s. Forks ${t.fork_height_m.toFixed(2)} m up, ` +
      (t.carrying ? `carrying ${t.carrying} (${t.load_kg} kg on the load cell).` : "empty.") +
      (t.stalled ? " The hoist has stalled." : "") +
      (t.tipped ? " THE TRUCK HAS TIPPED OVER." : ""),
  );
  if (y.task) {
    lines.push("", `Orders (${y.task.phase}):`);
    for (const o of y.task.orders)
      lines.push(
        `- ${o.pallet} (${o.pallet_label}) to ${o.bay} (${o.bay_label}): ${o.status}; ${o.status === "carried" ? "on the forks" : where(o.pallet)}`,
      );
    if (y.task.orders.length === 0) lines.push("- none");
  }

  const sightings = y.memory.all();
  const describe = (s: Sighting) => {
    const e = s.entity;
    const size = e.size_m ? `, ${n1(e.size_m[0])} x ${n1(e.size_m[1])} m` : "";
    const label = typeof e.state?.label === "string" ? ` (${e.state.label})` : "";
    return `- ${e.id}${label}, a ${e.class}, at ${at(e)}${s.bay ? ` in ${s.bay}` : ""}${size}`;
  };
  const visible = sightings.filter((s) => s.visible);
  lines.push(
    "",
    "In view of the sensors now:",
    ...(visible.length ? visible.map(describe) : ["- nothing that can move"]),
  );
  const remembered = sightings.filter((s) => !s.visible);
  if (remembered.length)
    lines.push(
      "",
      "Seen earlier, out of view now (it may have moved since):",
      ...remembered.map((s) => `${describe(s)}, ${ago(now - s.at)}`),
    );

  const map = y.scene.entities.filter((e) => e.state?.source === "site_map");
  lines.push("", "Site map (fixed; centre, then size along its own x and y):");
  for (const e of map) {
    const size = e.size_m ? `${n1(e.size_m[0])} x ${n1(e.size_m[1])} m` : "";
    if (e.class === "bay")
      lines.push(`- ${e.id} (${e.state?.label}), a bay at ${at(e)}, surface ${e.state?.surface_height_m} m up`);
    else if (e.class === "zone") lines.push(`- ${e.id} (${e.state?.label}), a zone at ${at(e)}, ${size}`);
    else if (e.class !== "bollard") lines.push(`- ${e.id}, a ${e.class}, at ${at(e)}, ${size}`);
  }
  if (y.task && y.task.log.length > 0) lines.push("", "Lately:", ...y.task.log.slice(-5).map((l) => `- ${l}`));
  return lines.join("\n");
}
