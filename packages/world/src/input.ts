/**
 * Device input for game worlds: the reserved action type `input_chunk` (AWP-GAM-001..004).
 * The declaration check mirrors awp-conformance's, so a world that starts here passes AWP-GAM-001.
 */
import { readVendored, type WorldManifest } from "@hyperduality/awp";

export const INPUT_CHUNK = "input_chunk";

/** One slot of an `input_chunk`, as submitted. */
export interface Slot {
  keys?: string[];
  mouse_dx?: number;
  mouse_dy?: number;
  scroll_steps?: number;
  sticks?: { left_x?: number; left_y?: number; right_x?: number; right_y?: number };
  triggers?: { left?: number; right?: number };
}

/**
 * The device state one sim step applies. A slot spans exactly one step, so its mouse and scroll
 * deltas are delivered whole within it, and `pressed`/`released` are the key edges at its start.
 */
export interface DeviceState {
  /** Keys and buttons down for the step. */
  held: string[];
  /** Down now, up in the previous step. */
  pressed: string[];
  /** Up now, down in the previous step. */
  released: string[];
  mouse_dx: number;
  mouse_dy: number;
  scroll_steps: number;
  sticks: { left_x: number; left_y: number; right_x: number; right_y: number };
  triggers: { left: number; right: number };
}

/** The device state a slot holds, given the keys held before it. An absent slot is neutral. */
export function deviceState(slot: Slot | undefined, before: readonly string[]): DeviceState {
  const held = slot?.keys ?? [];
  return {
    held: [...held],
    pressed: held.filter((k) => !before.includes(k)),
    released: before.filter((k) => !held.includes(k)),
    mouse_dx: slot?.mouse_dx ?? 0,
    mouse_dy: slot?.mouse_dy ?? 0,
    scroll_steps: slot?.scroll_steps ?? 0,
    sticks: {
      left_x: slot?.sticks?.left_x ?? 0,
      left_y: slot?.sticks?.left_y ?? 0,
      right_x: slot?.sticks?.right_x ?? 0,
      right_y: slot?.sticks?.right_y ?? 0,
    },
    triggers: { left: slot?.triggers?.left ?? 0, right: slot?.triggers?.right ?? 0 },
  };
}

// ---------------------------------------------------------------------------------------------
// Declaration (AWP-GAM-001)

type Node = Record<string, unknown>;

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "$defs",
  "title",
  "description",
  "default",
  "examples",
]);
const DEVICE_FIELDS = new Set(["mouse_dx", "mouse_dy", "scroll_steps", "sticks", "triggers"]);
const VENDOR_FIELD = "^x-[a-z0-9]+\\.";
const SLOT_MS = "properties/slot_ms";
const SLOTS = "properties/slots";
const SLOT_FIELDS = "properties/slots/items/properties";
const KEY_NAME = "properties/slots/items/properties/keys/items";

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

function pointer(root: unknown, ref: string): unknown {
  let node = root;
  const parts = ref === "#" ? [] : ref.replace(/^#\/?/, "").split("/");
  for (const raw of parts) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node) && /^\d+$/.test(part) && Number(part) < node.length) node = node[Number(part)];
    else if (isNode(node) && Object.hasOwn(node, part)) node = node[part];
    else throw new Error(`${ref} does not resolve`);
  }
  return node;
}

/** `node` with every local `$ref` replaced by its target, siblings merged over it. */
export function resolveRefs(node: unknown, root: unknown, chain: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((v) => resolveRefs(v, root, chain));
  if (!isNode(node)) return node;
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#")) {
    if (chain.includes(ref)) throw new Error(`${ref} refers to itself`);
    const target = resolveRefs(pointer(root, ref), root, [...chain, ref]);
    if (!isNode(target)) throw new Error(`${ref} is not a schema`);
    const siblings = Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => k !== "$ref")
        .map(([k, v]) => [k, resolveRefs(v, root, chain)]),
    );
    return { ...target, ...siblings };
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, root, chain)]));
}

/** Annotations dropped, and `x-awp-closed` read as `additionalProperties: false`. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!isNode(node)) return node;
  const out: Node = {};
  for (const [k, v] of Object.entries(node)) if (!ANNOTATIONS.has(k) && k !== "x-awp-closed") out[k] = normalize(v);
  if (node["x-awp-closed"] === true) out.additionalProperties = false;
  const pp = out.patternProperties;
  if (out.additionalProperties === false && isNode(pp) && Object.keys(pp).join() === VENDOR_FIELD) {
    const only = pp[VENDOR_FIELD];
    if (isNode(only) && Object.keys(only).length === 0) delete out.patternProperties;
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (isNode(a) && isNode(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.join() === kb.join() && ka.every((k) => same(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return a === b;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function diff(w: unknown, n: unknown, path: string[], out: string[]): void {
  const where = `/${path.join("/")}`;
  const at = path.join("/");
  if (!isNode(w) || !isNode(n)) {
    if (!same(w, n)) out.push(`${where} is ${JSON.stringify(w)}, not ${JSON.stringify(n)}`);
    return;
  }
  for (const k of [...new Set([...Object.keys(w), ...Object.keys(n)])].sort()) {
    const sub = [...path, k];
    if (!(k in n)) {
      if (at === SLOT_MS && k === "const") {
        const v = w[k];
        if (!(isInt(v) && (n.minimum as number) <= v && v <= (n.maximum as number)))
          out.push(`slot_ms is fixed to ${JSON.stringify(v)}, not an integer from ${n.minimum} to ${n.maximum}`);
      } else out.push(`/${sub.join("/")} is added`);
    } else if (!(k in w)) {
      const fixed = at === SLOT_MS && "const" in w && ["type", "minimum", "maximum"].includes(k);
      if (!(fixed || (at === SLOT_FIELDS && DEVICE_FIELDS.has(k)))) out.push(`/${sub.join("/")} is removed`);
    } else if (at === SLOTS && k === "maxItems") {
      const v = w[k];
      const low = (n.minItems as number | undefined) ?? 0;
      if (!(isInt(v) && low <= v && v <= (n[k] as number)))
        out.push(`slots.maxItems is ${JSON.stringify(v)}, not an integer from ${low} to ${n[k]}`);
    } else if (at === KEY_NAME && k === "enum") {
      const v = w[k];
      const names = Array.isArray(v) ? v : [];
      const allowed = n[k] as unknown[];
      const extra = names.filter((x) => !allowed.includes(x));
      if (!Array.isArray(v) || extra.length > 0 || new Set(names).size !== names.length)
        out.push(`the key-name enum is not a subset of the normative one: ${JSON.stringify(extra.length ? extra : v)}`);
    } else diff(w[k], n[k], sub, out);
  }
}

let normative: unknown;

/** How a manifest's `input_chunk` declaration departs from AWP-GAM-001; empty when it does not. */
export function inputChunkProblems(manifest: WorldManifest): string[] {
  const decl = manifest.action_schemas.find((a) => a.type === INPUT_CHUNK);
  if (!decl) return [];
  const problems: string[] = [];
  if (decl.duration !== "extended") problems.push(`duration is ${JSON.stringify(decl.duration)}, not "extended"`);
  const policies = Array.isArray(decl.preemption) ? decl.preemption : [decl.preemption];
  if (!policies.includes("replace"))
    problems.push(`preemption ${JSON.stringify(decl.preemption)} does not offer "replace"`);
  if (decl.concurrency_group !== "input")
    problems.push(`concurrency_group is ${JSON.stringify(decl.concurrency_group)}, not "input"`);
  normative ??= readVendored("v0.1/profiles/input-chunk.schema.json");
  let declared: unknown;
  try {
    declared = normalize(resolveRefs(decl.params_schema, manifest));
  } catch (e) {
    return [...problems, `params_schema: ${(e as Error).message}`];
  }
  diff(declared, normalize(resolveRefs(normative, normative)), [], problems);
  return problems;
}

/** The `slot_ms` an `input_chunk` declaration fixes, if it fixes one. */
export function fixedSlotMs(manifest: WorldManifest): number | undefined {
  const decl = manifest.action_schemas.find((a) => a.type === INPUT_CHUNK);
  if (!decl) return undefined;
  const schema = resolveRefs(decl.params_schema, manifest) as { properties?: { slot_ms?: { const?: unknown } } };
  const v = schema.properties?.slot_ms?.const;
  return isInt(v) ? v : undefined;
}
