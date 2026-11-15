import { useTopic } from "@awp-demo/inspector/react";
import { fromBase64, unpackFloats } from "@awp-demo/physics/quant";
import { Segmented, useDemo } from "@awp-demo/ui";
import { useEffect, useRef, useState } from "react";
import { CAMERA, type SensorsView } from "../shared/yard.ts";

type Mode = "rgb" | "depth";

/** Near is bright and warm, far is dark and cold, nothing in range is black. */
function depthColour(d: number, out: Uint8ClampedArray, o: number): void {
  if (d <= 0) {
    out[o] = 8;
    out[o + 1] = 10;
    out[o + 2] = 16;
    return;
  }
  const k = Math.min(1, Math.log1p(d) / Math.log1p(CAMERA.maxRange_m));
  out[o] = 255 * (1 - k) ** 1.5;
  out[o + 1] = 220 * (1 - k) * (0.4 + 0.6 * k) * 2;
  out[o + 2] = 60 + 195 * k * (1 - k * 0.5);
}

/**
 * What the truck's camera sees, as the agent receives it: a low-resolution image made of rays cast
 * through the physics, shown pixel for pixel.
 */
export function SensorPanel() {
  const { world } = useDemo();
  const sensors = useTopic<SensorsView>(world, "sensors");
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("rgb");

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !sensors) return;
    const { width: W, height: H } = CAMERA;
    const image = ctx.createImageData(W, H);
    if (mode === "rgb") {
      const rgb = fromBase64(sensors.rgb);
      for (let i = 0; i < W * H; i++) {
        image.data[i * 4] = rgb[i * 3] as number;
        image.data[i * 4 + 1] = rgb[i * 3 + 1] as number;
        image.data[i * 4 + 2] = rgb[i * 3 + 2] as number;
        image.data[i * 4 + 3] = 255;
      }
    } else {
      const depth = unpackFloats(sensors.depth);
      for (let i = 0; i < W * H; i++) {
        depthColour(depth[i] as number, image.data, i * 4);
        image.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [sensors, mode]);

  const returns = sensors ? Math.floor((sensors.lidar.length * 3) / 4 / 12) : 0;
  return (
    <div className="relative flex h-full flex-col bg-black">
      <canvas
        ref={canvas}
        width={CAMERA.width}
        height={CAMERA.height}
        className="min-h-0 w-full flex-1 object-contain [image-rendering:pixelated]"
      />
      <div className="absolute top-2 left-2">
        <Segmented
          label="Camera channel"
          value={mode}
          onChange={setMode}
          options={[
            { id: "rgb", label: "Camera" },
            { id: "depth", label: "Depth" },
          ]}
        />
      </div>
      <div className="absolute right-2 bottom-2 rounded bg-black/60 px-2 py-1 font-mono text-white/80 text-xs">
        {CAMERA.width}×{CAMERA.height} · lidar {returns} returns · sees {sensors?.seen.length ?? 0} movable things
      </div>
    </div>
  );
}
