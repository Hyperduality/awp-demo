import { type DeviceState, deviceState, type Sim } from "@awp-demo/world";
import type { MinecraftView, Scene, Status } from "../shared/minecraft.ts";
import type { Engine, Observation } from "./engine.ts";

/**
 * The world's view of one game: device input waits for the next step, which runs one game tick;
 * observations are what that tick returned, cached until the next.
 */
export class MinecraftSim implements Sim<MinecraftView> {
  private pending: DeviceState = deviceState(undefined, []);
  private applied: DeviceState = deviceState(undefined, []);
  private obs: Observation;
  private frameB64: string;
  private steps = 0;
  private failure: string | undefined;
  private readonly engine: Engine;
  private readonly initialState: string;

  constructor(engine: Engine, initialState: string, first: Observation) {
    this.engine = engine;
    this.initialState = initialState;
    this.obs = first;
    this.frameB64 = Buffer.from(first.jpeg).toString("base64");
  }

  applyInput(_embodiment: string, state: DeviceState): void {
    this.pending = state;
  }

  async step(): Promise<void> {
    if (this.failed()) return;
    const state = this.pending;
    try {
      this.obs = await this.engine.step(state);
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
      return;
    }
    this.applied = state;
    this.frameB64 = Buffer.from(this.obs.jpeg).toString("base64");
    this.steps += 1;
    // Mouse deltas and key edges belong to one tick; what stays held carries into the next.
    this.pending = deviceState({ keys: state.held }, state.held);
  }

  observe(channel: string): unknown {
    if (channel === "pov") return { bytes: this.obs.jpeg };
    if (channel === "status") return status(this.obs);
    if (channel === "scene") return scene(this.obs);
    throw new Error(`no channel ${channel}`);
  }

  start(): never {
    throw new Error("the host runs input_chunk");
  }

  /** Safe state: every input released. Nothing steps until the next tick. */
  safeStop(): void {
    this.pending = deviceState(undefined, this.pending.held);
  }

  failed(): string | undefined {
    return this.failure ?? this.engine.failure;
  }

  view(): MinecraftView {
    const failure = this.failed();
    return {
      frame: this.frameB64,
      status: status(this.obs),
      pose: this.obs.info.pos,
      applied: this.applied,
      steps: this.steps,
      initialState: this.initialState,
      engine: this.engine.name,
      ...(failure ? { failure } : {}),
    };
  }
}

function status({ info }: Observation): Status {
  const { pos: _, ...rest } = info;
  return rest;
}

/** The player as a scene-graph entity (AWP-SCN-001). Minecraft's axes: x east, y up, z south; 1 block is 1 m. */
function scene({ info }: Observation): Scene {
  const { x, y, z, yaw, pitch } = info.pos;
  return {
    entities: [
      {
        id: "player",
        class: "player",
        pose: { frame: "world", p_m: [x, y, z], q: viewQuaternion(yaw, pitch) },
        affordances: [],
        state: { yaw_deg: yaw, pitch_deg: pitch, health: info.health },
        controlled_by: "session",
      },
    ],
    relations: [],
  };
}

/** [x, y, z, w] turning +z (yaw 0, pitch 0) to the view direction: yaw about -y, then pitch about x. */
function viewQuaternion(yawDeg: number, pitchDeg: number): [number, number, number, number] {
  const h = (-yawDeg * Math.PI) / 360;
  const p = (pitchDeg * Math.PI) / 360;
  const [cy, sy, cp, sp] = [Math.cos(h), Math.sin(h), Math.cos(p), Math.sin(p)];
  const q: [number, number, number, number] = [cy * sp, sy * cp, -sy * sp, cy * cp];
  return q.map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number, number];
}
