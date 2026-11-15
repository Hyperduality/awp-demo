import type { Quat, Vec3 } from "./math.ts";

/** A cylinder's or cone's axis is its local y, which suits a wheel on an axle. */
export type Shape =
  | { kind: "box"; half: Vec3 }
  | { kind: "cylinder"; halfHeight: number; radius: number }
  | { kind: "cone"; halfHeight: number; radius: number };

/** One piece of a body: a collider and the mesh drawn for it, or with `visual` only the mesh. */
export interface PartDesc {
  shape: Shape;
  at?: Vec3;
  rot?: Quat;
  /** Names both the sensor albedo and the render material. */
  material: string;
  mass_kg?: number;
  friction?: number;
  /** Drawn but not simulated, and invisible to the raycast sensors. */
  visual?: boolean;
  /** Report contact forces above this, in newtons. */
  contactForce_n?: number;
}

export interface BodyDesc {
  id: string;
  kind: "fixed" | "dynamic";
  /** What the body is, for scene graphs and renderers: `pallet`, `crate`, `ground`... */
  type: string;
  p: Vec3;
  q?: Quat;
  parts: PartDesc[];
  /** Bodies that share a non-zero group never collide with each other (the parts of one machine). */
  group?: number;
  ccd?: boolean;
  canSleep?: boolean;
  extraSolverIterations?: number;
  /** Explicit mass properties, replacing those of the parts (which then need no `mass_kg`). */
  mass?: { mass_kg: number; com: Vec3; inertia: Vec3 };
}

export interface SceneDesc {
  gravity?: Vec3;
  bodies: BodyDesc[];
}

/** What a renderer needs to draw a body: sent once, then only poses move. */
export interface LayoutBody {
  id: string;
  type: string;
  fixed: boolean;
  /** Where it started; a fixed body never leaves it. */
  p: Vec3;
  q: Quat;
  parts: { shape: Shape; at: Vec3; rot: Quat; material: string }[];
}

/** The principal inertia of a solid box about its centre. */
export function boxInertia(mass_kg: number, half: Vec3): Vec3 {
  const [x, y, z] = half;
  return [(mass_kg / 3) * (y * y + z * z), (mass_kg / 3) * (x * x + z * z), (mass_kg / 3) * (x * x + y * y)];
}
