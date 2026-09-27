/** Geometry of the sorting cell, shared by the world, the controllers, and the view. Metres, base frame. */

export type Color = "red" | "green" | "blue";
export const COLORS: Color[] = ["red", "green", "blue"];

export const CELL = {
  shoulder: [0, 0.5] as const,
  l1: 0.5,
  l2: 0.45,
  belt: { x0: -1.0, x1: 0.36, z: 0.1 },
  parcel: 0.06,
  /** Where the gripper closes on a parcel resting on the belt. */
  graspZ: 0.165,
  hoverZ: 0.3,
  bins: [
    { color: "red" as Color, x: 0.5, w: 0.13, z: 0.22 },
    { color: "green" as Color, x: 0.66, w: 0.13, z: 0.22 },
    { color: "blue" as Color, x: 0.82, w: 0.13, z: 0.22 },
  ],
  dropZ: 0.36,
  home: [0.1, 0.45] as const,
  gripperOpen: 0.08,
} as const;

export const PORTS = { world: 8712, worldInspector: 8812, agentInspector: 8912, ui: 5172 } as const;

export interface ParcelView {
  id: string;
  color: Color;
  x: number;
  z: number;
  on: "belt" | "gripper" | "air";
}

export interface SorterView {
  tick: number;
  timeS: number;
  arm: { q: [number, number]; ee: [number, number]; target: [number, number] | null };
  gripper: { width: number; holding: string | null };
  parcels: ParcelView[];
  bins: { color: Color; count: number; wrong: number }[];
  belt: { offset: number; speed: number };
  stats: { sorted: number; wrong: number; missed: number; dropped: number };
}

export interface SceneEntity {
  id: string;
  class: "parcel" | "bin" | "conveyor";
  pose: { frame: "base"; p_m: [number, number, number]; q: [0, 0, 0, 1] };
  affordances?: string[];
  state: Record<string, unknown>;
}

export interface ScenePayload {
  entities: SceneEntity[];
  relations: { type: string; subject: string; object: string }[];
  stats: SorterView["stats"];
}

export interface ProprioPayload {
  q_rad: [number, number];
  ee_m: [number, number];
  moving: boolean;
}

export interface GripperPayload {
  width_m: number;
  holding: string | null;
}

/** Two-link inverse kinematics with the elbow up; undefined when out of reach. */
export function ik(x: number, z: number): [number, number] | undefined {
  const [sx, sz] = CELL.shoulder;
  const dx = x - sx;
  const dz = z - sz;
  const d2 = dx * dx + dz * dz;
  const { l1, l2 } = CELL;
  const c = (d2 - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  if (c < -1 || c > 1) return undefined;
  let best: [number, number] | undefined;
  let bestElbowZ = -Infinity;
  for (const s of [1, -1]) {
    const q2 = s * Math.acos(c);
    const q1 = Math.atan2(dz, dx) - Math.atan2(l2 * Math.sin(q2), l1 + l2 * Math.cos(q2));
    const elbowZ = sz + l1 * Math.sin(q1);
    if (elbowZ > bestElbowZ) {
      bestElbowZ = elbowZ;
      best = [q1, q2];
    }
  }
  return best;
}

export function binFor(color: Color) {
  return CELL.bins.find((b) => b.color === color)!;
}
