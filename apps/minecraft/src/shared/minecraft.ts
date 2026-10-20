/** The Minecraft world's ports, inputs, and payloads, shared by the world, the controllers, and the view. */
import type { DeviceState } from "@awp-demo/world";

export const PORTS = { world: 8715, worldInspector: 8815, agentInspector: 8915, ui: 5175, policy: 8716 } as const;

/** One game tick: a sim step, a lockstep advance, and an input slot. */
export const TICK_MS = 50;
export const MAX_SLOTS = 20;
/** Camera degrees per mouse count; `shared/keymap.json` holds the same value for the Python side. */
export const DEG_PER_COUNT = 0.15;

/** The keys and buttons the world takes, as W3C KeyboardEvent.code names, and the MineRL action each drives. */
export const KEYS = {
  KeyW: "forward",
  KeyA: "left",
  KeyS: "back",
  KeyD: "right",
  Space: "jump",
  ShiftLeft: "sneak",
  ControlLeft: "sprint",
  KeyE: "inventory",
  MouseLeft: "attack",
  MouseRight: "use",
  Digit1: "hotbar.1",
  Digit2: "hotbar.2",
  Digit3: "hotbar.3",
  Digit4: "hotbar.4",
  Digit5: "hotbar.5",
  Digit6: "hotbar.6",
  Digit7: "hotbar.7",
  Digit8: "hotbar.8",
  Digit9: "hotbar.9",
} as const;
export type Key = keyof typeof KEYS;
export const KEY_NAMES = Object.keys(KEYS) as Key[];

export const INITIAL_STATES = ["plains_day", "forest_wood", "conformance_room"] as const;
export type InitialState = (typeof INITIAL_STATES)[number];

export interface Pose {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
}

/** What the sidecar reports after each tick. */
export interface Info {
  health: number;
  food: number;
  pos: Pose;
  selected_slot: number;
  inventory: { slot: number; type: string; quantity: number }[];
  mainhand: string;
  light: number;
  sky: boolean;
  gui_open: boolean;
  mined: Record<string, number>;
  picked_up: Record<string, number>;
  crafted: Record<string, number>;
  killed: Record<string, number>;
}

/** The `status` channel. */
export type Status = Omit<Info, "pos">;

/** The `scene` channel: the player as a scene-graph entity. */
export interface Scene {
  entities: {
    id: string;
    class: string;
    pose: { frame: "world"; p_m: [number, number, number]; q: [number, number, number, number] };
    affordances: string[];
    state: { yaw_deg: number; pitch_deg: number; health: number };
    controlled_by: "session" | null;
  }[];
  relations: never[];
}

/** The UI's view of the world (not part of AWP). */
export interface MinecraftView {
  /** The newest frame, as JPEG base64. */
  frame: string;
  status: Status;
  pose: Pose;
  /** The device state the newest step applied. */
  applied: DeviceState;
  steps: number;
  initialState: string;
  engine: string;
  failure?: string;
}
