import { AgentCommand, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { useDemo } from "@awp-demo/ui";
import { useEffect, useRef, useState } from "react";
import { KEY_NAMES, type MinecraftView } from "../shared/minecraft.ts";

const TAKEN = new Set<string>(KEY_NAMES);
const BUTTONS: Record<number, string> = { 0: "MouseLeft", 2: "MouseRight" };
const SHORT: Record<string, string> = {
  KeyW: "W",
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  Space: "Space",
  ShiftLeft: "Shift",
  ControlLeft: "Ctrl",
  KeyE: "E",
  MouseLeft: "LMB",
  MouseRight: "RMB",
};

/**
 * The player's view, as the world renders it, with what the protocol delivered: the device state the
 * last tick applied. Click to capture the keyboard and mouse for the manual controller; Esc lets go.
 */
export function WorldView() {
  const { world, agent } = useDemo();
  const view = useTopic<MinecraftView>(world, WorldTopic.view);
  const surface = useRef<HTMLDivElement>(null);
  const [captured, setCaptured] = useState(false);

  useEffect(() => {
    const keys = new Set<string>();
    let dx = 0;
    let dy = 0;
    let timer: number | undefined;
    const send = () => {
      void agent
        .command(AgentCommand.input, { id: "manual", input: { keys: [...keys], dx, dy } })
        .catch(() => undefined);
      dx = 0;
      dy = 0;
    };
    const down = (code: string) => {
      if (!TAKEN.has(code) || keys.has(code)) return;
      keys.add(code);
      send();
    };
    const up = (code: string) => {
      if (keys.delete(code)) send();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!captured || !TAKEN.has(e.code)) return;
      e.preventDefault();
      if (e.type === "keydown") down(e.code);
      else up(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      if (!captured) return;
      const b = BUTTONS[e.button];
      if (b) (e.type === "mousedown" ? down : up)(b);
    };
    const onMove = (e: MouseEvent) => {
      if (!captured) return;
      dx += e.movementX;
      dy += e.movementY;
    };
    const onLock = () => {
      const locked = document.pointerLockElement === surface.current;
      setCaptured(locked);
      if (!locked) {
        keys.clear();
        send();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLock);
    if (captured) timer = window.setInterval(send, 33);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("mousedown", onMouse);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerlockchange", onLock);
      window.clearInterval(timer);
    };
  }, [agent, captured]);

  if (!view) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">Starting Minecraft…</div>;
  }
  const applied = view.applied;
  const keys = applied.held.map((k) => SHORT[k] ?? k.replace(/^Digit/, ""));
  return (
    <div
      ref={surface}
      className="relative flex h-full cursor-crosshair select-none items-center justify-center bg-black"
      onClick={() => surface.current?.requestPointerLock()}
    >
      {view.frame && (
        <img
          alt="The player's view"
          src={`data:image/jpeg;base64,${view.frame}`}
          className="h-full w-full object-contain"
          draggable={false}
        />
      )}
      <div className="absolute top-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-white text-xs">
        <div>
          Health {view.status.health} · Food {view.status.food} · Slot {view.status.selected_slot} (
          {view.status.mainhand})
        </div>
        <div className="text-white/70">
          {view.pose.x.toFixed(1)}, {view.pose.y.toFixed(1)}, {view.pose.z.toFixed(1)} · yaw {view.pose.yaw.toFixed(0)}°
        </div>
      </div>
      <div className="absolute right-2 bottom-2 rounded bg-black/60 px-2 py-1 text-right font-mono text-white text-xs">
        <div className="text-white/70">Applied this tick</div>
        <div>{keys.length > 0 ? keys.join(" ") : "Nothing held"}</div>
        {(applied.mouse_dx !== 0 || applied.mouse_dy !== 0) && (
          <div>
            Mouse {applied.mouse_dx > 0 ? "+" : ""}
            {applied.mouse_dx}, {applied.mouse_dy > 0 ? "+" : ""}
            {applied.mouse_dy}
          </div>
        )}
      </div>
      {view.failure ? (
        <div className="absolute inset-x-0 top-1/2 text-center text-danger text-sm">{view.failure}</div>
      ) : (
        !captured && (
          <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-white text-xs">
            Click to play · Esc to let go
          </div>
        )
      )}
    </div>
  );
}
