/** Building input_chunk params, shared by the controllers. */
import { type ControlContext, NotInControlError } from "@awp-demo/agent";
import { AwpError } from "@hyperduality/awp";
import { DEG_PER_COUNT, KEY_NAMES, type Key, MAX_SLOTS, type Scene, TICK_MS } from "../../shared/minecraft.ts";

export interface Slot {
  keys?: string[];
  mouse_dx?: number;
  mouse_dy?: number;
}

const KNOWN = new Set<string>(KEY_NAMES);

/** Keys the world takes, in a stable order. */
export function worldKeys(keys: Iterable<string>): Key[] {
  return KEY_NAMES.filter((k) => new Set(keys).has(k) && KNOWN.has(k));
}

/** Keys held for `holdMs`, with the view turned by `lookDx`/`lookDy` degrees spread evenly over the slots. */
export function hold(keys: string[], holdMs: number, lookDx = 0, lookDy = 0): Slot[] {
  const n = Math.max(1, Math.min(MAX_SLOTS, Math.round(holdMs / TICK_MS)));
  const dx = spread(Math.round(lookDx / DEG_PER_COUNT), n);
  const dy = spread(Math.round(lookDy / DEG_PER_COUNT), n);
  return Array.from({ length: n }, (_, i) => {
    const slot: Slot = { keys: worldKeys(keys) };
    if (dx[i]) slot.mouse_dx = dx[i];
    if (dy[i]) slot.mouse_dy = dy[i];
    return slot;
  });
}

/** `total` counts over `n` slots, whole counts only, summing to `total`. */
function spread(total: number, n: number): number[] {
  const base = Math.trunc(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < Math.abs(rest) ? Math.sign(rest) : 0));
}

export function chunk(slots: Slot[]) {
  return { slot_ms: TICK_MS, slots };
}

/** The player's pose from the scene channel. */
export function pose(ctx: ControlContext<unknown>) {
  const e = ctx.latest<Scene>("scene")?.entities.find((x) => x.id === "player");
  if (!e) return undefined;
  const [x, y, z] = e.pose.p_m;
  return { x, y, z, yaw: e.state.yaw_deg, pitch: e.state.pitch_deg };
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
