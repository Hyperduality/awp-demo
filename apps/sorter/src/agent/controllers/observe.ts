import type { ControlContext } from "@awp-demo/agent";
import { CELL, type GripperPayload, type ProprioPayload, type ScenePayload } from "../../shared/cell.ts";

export interface CellState {
  ee: [number, number];
  moving: boolean;
  holding: string | null;
  beltMps: number;
  parcels: { id: string; color: string; x: number; z: number; on: string }[];
  stats: ScenePayload["stats"] | undefined;
}

export function readCell(ctx: ControlContext<unknown>): CellState | undefined {
  const scene = ctx.latest<ScenePayload>("scene");
  const proprio = ctx.latest<ProprioPayload>("proprio");
  const grip = ctx.latest<GripperPayload>("gripper_state");
  if (!scene || !proprio || !grip) return undefined;
  const belt = scene.entities.find((e) => e.class === "conveyor");
  return {
    ee: proprio.ee_m,
    moving: proprio.moving,
    holding: grip.holding,
    beltMps: Number(belt?.state.speed_mps ?? 0.06),
    parcels: scene.entities
      .filter((e) => e.class === "parcel")
      .map((e) => ({
        id: e.id,
        color: String(e.state.color),
        x: e.pose.p_m[0],
        z: e.pose.p_m[2],
        on: String(e.state.on),
      })),
    stats: scene.stats,
  };
}

/** The cell as a model reads it. */
export function describeCell(ctx: ControlContext<unknown>): string {
  const c = readCell(ctx);
  if (!c) return "No observation yet.";
  const held = c.holding ? c.parcels.find((p) => p.id === c.holding) : undefined;
  const onBelt = c.parcels.filter((p) => p.on === "belt").sort((a, b) => b.x - a.x);
  const lines = [
    `End effector at x=${c.ee[0].toFixed(3)} z=${c.ee[1].toFixed(3)}${c.moving ? " (moving)" : ""}.`,
    held ? `Gripper holding ${held.id} (${held.color}).` : "Gripper empty.",
    `Belt moves +x at ${c.beltMps.toFixed(3)} m/s, only while time advances. Parcels are reachable for x between -0.88 and ${CELL.belt.x1}; past ${CELL.belt.x1} they are lost.`,
    onBelt.length > 0
      ? `Parcels on the belt (furthest along first): ${onBelt.map((p) => `${p.id} ${p.color} at x=${p.x.toFixed(3)}`).join("; ")}.`
      : "No parcels on the belt.",
    `Bins (release from z=${CELL.dropZ}): ${CELL.bins.map((b) => `${b.color} at x=${b.x}`).join(", ")}.`,
    c.stats
      ? `Score: sorted ${c.stats.sorted}, wrong bin ${c.stats.wrong}, missed ${c.stats.missed}, dropped ${c.stats.dropped}.`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}
