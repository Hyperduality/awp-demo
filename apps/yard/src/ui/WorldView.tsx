import { AgentCommand, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { compose, type Pose, transform } from "@awp-demo/physics/math";
import { unpackFloats } from "@awp-demo/physics/quant";
import {
  type CameraMode,
  type Mark,
  type Overlay,
  type Quality,
  type SceneFrame,
  type SceneLayout,
  Viewport,
} from "@awp-demo/scene3d";
import { Segmented, useDemo } from "@awp-demo/ui";
import { Switch } from "@heroui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MATERIALS } from "../shared/materials.ts";
import { CAMERA, EMBODIMENT, type SensorsView, type YardLayout, type YardView } from "../shared/yard.ts";

const KEYS: Record<string, [axis: "throttle" | "steer" | "lift" | "tilt", sign: number]> = {
  KeyW: ["throttle", 1],
  ArrowUp: ["throttle", 1],
  KeyS: ["throttle", -1],
  ArrowDown: ["throttle", -1],
  KeyA: ["steer", 1],
  ArrowLeft: ["steer", 1],
  KeyD: ["steer", -1],
  ArrowRight: ["steer", -1],
  KeyR: ["lift", 1],
  KeyF: ["lift", -1],
  KeyT: ["tilt", 1],
  KeyG: ["tilt", -1],
};

/** In development the scene is on `window.__scene`, for poking at from the console. */
const debugScene = import.meta.env.DEV ? (scene: unknown) => Object.assign(window, { __scene: scene }) : undefined;

const OPTIONS = {
  materials: MATERIALS,
  assets: "/assets",
  follow: EMBODIMENT,
  seat: [-0.25, 0, 1.25] as [number, number, number],
};

/**
 * The yard in three dimensions, drawn from the poses the world publishes. Click it to take the
 * controls: the keys and a gamepad's sticks go to the manual controller, which sends them to the world
 * as command-channel setpoints. This view never talks to the world's protocol itself.
 */
export function WorldView() {
  const { world, agent } = useDemo();
  const layout = useTopic<YardLayout>(world, WorldTopic.layout);
  const sensors = useTopic<SensorsView>(world, "sensors");
  const [camera, setCamera] = useState<CameraMode>("orbit");
  const [quality, setQuality] = useState<Quality>("high");
  const [showSensors, setShowSensors] = useState(false);
  const [driving, setDriving] = useState(false);
  const [hud, setHud] = useState<YardView | undefined>(() => world.get<YardView>(WorldTopic.view));
  const surface = useRef<HTMLDivElement>(null);

  const scene = useMemo<SceneLayout | null>(() => {
    if (!layout) return null;
    const marks: Mark[] = layout.bays.map((b) => ({
      id: b.id,
      p: b.p_m,
      yaw: b.yaw_rad,
      size: b.size_m,
      label: b.label.replace(/^Bay /, "").replace(/^Trailer slot /, "T"),
    }));
    return { key: layout.key, bodies: layout.bodies, marks };
  }, [layout]);

  // Pose frames go straight from the socket to the scene; React only hears a few times a second, for the readouts.
  const frames = useCallback(
    (push: (frame: SceneFrame) => void) => {
      let last = 0;
      const deliver = () => {
        const v = world.get<YardView>(WorldTopic.view);
        if (!v) return;
        push({ key: v.key, t_ms: v.t_ms, poses: unpackFloats(v.poses) });
        const now = performance.now();
        if (now - last > 120) {
          last = now;
          setHud(v);
        }
      };
      deliver();
      return world.subscribe(WorldTopic.view, deliver);
    },
    [world],
  );

  const overlay = useMemo<Overlay>(() => {
    const path = hud?.path ?? null;
    if (!showSensors || !sensors || !layout) return { points: null, frustum: null, path };
    const chassis: Pose = { p: sensors.chassis.p_m, q: sensors.chassis.q };
    const lidar = compose(chassis, { p: layout.sensors.lidar.p_m, q: layout.sensors.lidar.q });
    const local = unpackFloats(sensors.lidar);
    const points = new Float32Array(local.length);
    for (let i = 0; i < local.length; i += 3) {
      const p = transform(lidar, [local[i] as number, local[i + 1] as number, local[i + 2] as number]);
      points.set(p, i);
    }
    const cam = compose(chassis, { p: layout.sensors.camera.p_m, q: layout.sensors.camera.q });
    const far = 6;
    const ty = Math.tan(CAMERA.fovY_rad / 2) * far;
    const tx = (ty * CAMERA.width) / CAMERA.height;
    const frustum = [
      cam.p,
      ...(
        [
          [tx, ty],
          [-tx, ty],
          [-tx, -ty],
          [tx, -ty],
        ] as const
      ).map(([y, z]) => transform(cam, [far, y, z])),
    ];
    return { points, frustum, path };
  }, [showSensors, sensors, layout, hud?.path]);

  // Keys while the view has the controls, and a gamepad whenever one is moved.
  useEffect(() => {
    const down = new Set<string>();
    let sent = "";
    const send = (pad?: { throttle: number; steer: number; lift: number; tilt: number }) => {
      const input = pad ?? { throttle: 0, steer: 0, lift: 0, tilt: 0 };
      if (!pad)
        for (const code of down) {
          const [axis, sign] = KEYS[code] as [keyof typeof input, number];
          input[axis] = Math.max(-1, Math.min(1, input[axis] + sign));
        }
      const text = JSON.stringify(input);
      const moving = text !== '{"throttle":0,"steer":0,"lift":0,"tilt":0}';
      if (text === sent && !moving) return;
      sent = text;
      void agent.command(AgentCommand.input, { id: "manual", input }).catch(() => undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!driving) return;
      if (e.code === "Escape") {
        setDriving(false);
        return;
      }
      if (!KEYS[e.code]) return;
      e.preventDefault();
      if (e.type === "keydown") down.add(e.code);
      else down.delete(e.code);
      send();
    };
    const dead = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
    const timer = window.setInterval(() => {
      const pad = navigator.getGamepads?.().find((g) => g?.connected);
      if (pad) {
        const input = {
          throttle: (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0),
          steer: -dead(pad.axes[0] ?? 0),
          lift: -dead(pad.axes[3] ?? 0),
          tilt: (pad.buttons[12]?.pressed ? 1 : 0) - (pad.buttons[13]?.pressed ? 1 : 0),
        };
        if (input.throttle || input.steer || input.lift || input.tilt || sent.includes("pad")) {
          send(input);
          sent = `pad${sent}`;
          return;
        }
      }
      if (driving && down.size > 0) send();
    }, 50);
    const blur = () => {
      down.clear();
      send();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", blur);
      window.clearInterval(timer);
      down.clear();
      send();
    };
  }, [agent, driving]);

  const t = hud?.truck;
  return (
    <div
      ref={surface}
      className="relative h-full select-none overflow-hidden bg-black"
      onPointerDown={() => setDriving(true)}
    >
      <Viewport
        className="absolute inset-0"
        options={OPTIONS}
        layout={scene}
        frames={frames}
        camera={camera}
        quality={quality}
        overlay={overlay}
        onScene={debugScene}
      />
      {!layout && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
          Waiting for the world…
        </div>
      )}

      <div className="absolute top-2 left-2 flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
        <Segmented
          label="Camera"
          value={camera}
          onChange={setCamera}
          options={[
            { id: "orbit", label: "Orbit" },
            { id: "chase", label: "Chase" },
            { id: "seat", label: "Seat" },
            { id: "top", label: "Top" },
          ]}
        />
      </div>
      <div
        className="absolute top-2 right-2 flex items-center gap-4 rounded-lg bg-black/55 px-3 py-1.5 text-white text-xs"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Switch aria-label="Show what the sensors see" isSelected={showSensors} onChange={setShowSensors}>
          <Switch.Content className="flex items-center gap-2">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Sensors
          </Switch.Content>
        </Switch>
        <Switch
          aria-label="Lighting effects"
          isSelected={quality === "high"}
          onChange={(on) => setQuality(on ? "high" : "low")}
        >
          <Switch.Content className="flex items-center gap-2">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Effects
          </Switch.Content>
        </Switch>
      </div>

      {t && (
        <div className="absolute bottom-2 left-2 rounded-lg bg-black/55 px-3 py-2 font-mono text-white text-xs tabular-nums">
          <div>
            {Math.abs(t.v_mps).toFixed(1)} m/s {t.v_mps < -0.05 ? "reverse" : ""} · steer{" "}
            {((t.steer_rad * 180) / Math.PI).toFixed(0)}°
          </div>
          <div>
            Forks {t.fork_height_m.toFixed(2)} m · tilt {((t.tilt_rad * 180) / Math.PI).toFixed(1)}°
          </div>
          <div className={t.stalled ? "text-warning" : "text-white/70"}>
            {t.tipped
              ? "Tipped over"
              : t.stalled
                ? "Hoist stalled"
                : t.carrying
                  ? `Carrying ${t.carrying}, ${t.load_kg} kg`
                  : "Forks empty"}
          </div>
        </div>
      )}
      <div className="absolute right-2 bottom-2 rounded-lg bg-black/55 px-3 py-1.5 text-white/80 text-xs">
        {driving ? "You have the controls · Esc to let go" : "Click to drive"}
      </div>
    </div>
  );
}
