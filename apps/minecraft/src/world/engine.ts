/**
 * The game behind the world. The real engine is MineStudio in a Python sidecar (`sim/`), spoken to as
 * NDJSON over stdio; the fake one moves a pose by the same keys and shows a fixed picture, for tests and CI.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { DeviceState } from "@awp-demo/world";
import { DEG_PER_COUNT, type Info, type Pose } from "../shared/minecraft.ts";

export interface Observation {
  jpeg: Uint8Array;
  info: Info;
}

export interface Engine {
  readonly name: string;
  reset(initialState: string): Promise<Observation>;
  /** One game tick under a device state. */
  step(state: DeviceState): Promise<Observation>;
  close(): Promise<void>;
  /** Why the engine stopped, once it has. */
  readonly failure: string | undefined;
}

interface Reply {
  id: number;
  ok: boolean;
  error?: string;
  frame_b64?: string;
  info?: Info;
  [k: string]: unknown;
}

export class SidecarEngine implements Engine {
  readonly name = "minestudio";
  failure: string | undefined;
  private readonly proc: ChildProcess;
  private readonly waiting = new Map<number, { resolve(r: Reply): void; reject(e: Error): void }>();
  private next = 0;
  /** The sidecar's last lines of stderr, for the failure message. */
  private readonly tail: string[] = [];

  private constructor(command: string, cwd: string, log: (line: string) => void) {
    this.proc = spawn(command, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        return;
      }
      const w = this.waiting.get(reply.id);
      this.waiting.delete(reply.id);
      if (reply.ok) w?.resolve(reply);
      else w?.reject(new Error(reply.error ?? "the sidecar failed"));
    });
    createInterface({ input: this.proc.stderr! }).on("line", (line) => {
      this.tail.push(line);
      if (this.tail.length > 20) this.tail.shift();
      if (process.env.AWP_MINECRAFT_VERBOSE) log(`[minecraft] ${line}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.failure ??= `the Minecraft sidecar exited (${signal ?? `code ${code}`}): ${this.tail.at(-1) ?? ""}`;
      for (const w of this.waiting.values()) w.reject(new Error(this.failure));
      this.waiting.clear();
    });
    this.proc.on("error", (e) => {
      this.failure ??= `the Minecraft sidecar did not start: ${e.message}`;
    });
  }

  static async start(command: string, cwd: string, log: (line: string) => void): Promise<SidecarEngine> {
    const engine = new SidecarEngine(command, cwd, log);
    const hello = await engine.request({ op: "hello" });
    log(`Minecraft sidecar ${hello.version}, rendering with ${hello.render}`);
    return engine;
  }

  private request(message: Record<string, unknown>): Promise<Reply> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.proc.stdin!.write(`${JSON.stringify({ id, ...message })}\n`);
    });
  }

  private static observation(r: Reply): Observation {
    return { jpeg: Buffer.from(r.frame_b64 ?? "", "base64"), info: r.info! };
  }

  async reset(initialState: string): Promise<Observation> {
    return SidecarEngine.observation(await this.request({ op: "reset", initial_state: initialState }));
  }

  async step(state: DeviceState): Promise<Observation> {
    return SidecarEngine.observation(await this.request({ op: "step", device_state: state }));
  }

  async close(): Promise<void> {
    if (this.failure) return;
    await this.request({ op: "close" }).catch(() => undefined);
    this.failure = "closed";
    this.proc.kill();
  }
}

/** A 64×36 JPEG: sky over grass. */
const PICTURE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDsKKKK9U8EKKKKACiiigAooooA5T+2tR/5+P8Axxf8KP7a1H/n4/8AHF/wqhRXy3t6v8z+9ndyR7F/+2tR/wCfj/xxf8KP7a1H/n4/8cX/AAqhRR7er/M/vYckexf/ALa1H/n4/wDHF/wo/trUf+fj/wAcX/CqFFHt6v8AM/vYckexf/trUf8An4/8cX/Cj+2tR/5+P/HF/wAKoUUe3q/zP72HJHsFFFFYlBRRRQAUUUUAFFFFAH//2Q==",
  "base64",
);

/** Walks on a flat plane at 4.3 blocks a second (one tick is 50 ms) and turns by the mouse, like Minecraft. */
export class FakeEngine implements Engine {
  readonly name = "fake";
  failure: string | undefined;
  private pose: Pose = { x: 0.5, y: 200, z: 0.5, pitch: 0, yaw: 0 };
  private selected = 1;

  async reset(): Promise<Observation> {
    this.pose = { x: 0.5, y: 200, z: 0.5, pitch: 0, yaw: 0 };
    this.selected = 1;
    return this.observation();
  }

  async step(state: DeviceState): Promise<Observation> {
    const p = this.pose;
    p.yaw = wrap(p.yaw + state.mouse_dx * DEG_PER_COUNT);
    p.pitch = Math.max(-90, Math.min(90, p.pitch + state.mouse_dy * DEG_PER_COUNT));
    const held = new Set(state.held);
    const fwd = (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0);
    const side = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);
    const speed = held.has("ControlLeft") ? 0.28 : held.has("ShiftLeft") ? 0.065 : 0.216;
    const r = (p.yaw * Math.PI) / 180;
    // Minecraft: yaw 0 faces +z, and positive yaw turns toward -x.
    p.x += speed * (-Math.sin(r) * fwd - Math.cos(r) * side);
    p.z += speed * (Math.cos(r) * fwd - Math.sin(r) * side);
    p.x = round4(p.x);
    p.z = round4(p.z);
    for (const k of state.pressed) if (/^Digit[1-9]$/.test(k)) this.selected = Number(k.slice(5));
    return this.observation();
  }

  async close(): Promise<void> {}

  private observation(): Observation {
    return {
      jpeg: PICTURE,
      info: {
        health: 20,
        food: 20,
        pos: { ...this.pose },
        selected_slot: this.selected,
        inventory: [],
        mainhand: "air",
        light: 15,
        sky: true,
        gui_open: false,
        mined: {},
        picked_up: {},
        crafted: {},
        killed: {},
      },
    };
  }
}

function wrap(deg: number): number {
  return round4(((((deg + 180) % 360) + 360) % 360) - 180);
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

let shared: Engine | undefined;

/**
 * The engine for the next sim: started on first use and again after it fails. `AWP_MINECRAFT_SIM` picks
 * it: `fake`, or the command that starts the sidecar (default: the uv package in this app).
 */
export async function engine(log: (line: string) => void): Promise<Engine> {
  if (shared && !shared.failure) return shared;
  const choice = process.env.AWP_MINECRAFT_SIM;
  if (choice === "fake") shared = new FakeEngine();
  else {
    const command = choice || "uv run --package awp-minecraft-sim awp-minecraft-sim";
    log(`starting Minecraft: ${command}`);
    shared = await SidecarEngine.start(command, fileURLToPath(new URL("../..", import.meta.url)), log);
  }
  return shared;
}
