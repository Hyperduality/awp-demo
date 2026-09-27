import { AgentCommand, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { mixRgb, type Palette, toRgb, useCanvas, useDemo } from "@awp-demo/ui";
import { useEffect, useRef, useState } from "react";
import { castRay, type Layout, type MazeView, wrapAngle } from "../shared/maze.ts";

const FOV = (72 * Math.PI) / 180;
const KEYS = {
  forward: ["w", "arrowup"],
  back: ["s", "arrowdown"],
  left: ["a"],
  right: ["d"],
  turnLeft: ["arrowleft", "q"],
  turnRight: ["arrowright", "e"],
};

let cached: { key: string; value: ReturnType<typeof computeColors> } | undefined;
function computeColors(p: Palette) {
  const fg = toRgb(p.foreground);
  const bg = toRgb(p.background);
  const mix = (t: number): [number, number, number] => [
    fg[0] + (bg[0] - fg[0]) * t,
    fg[1] + (bg[1] - fg[1]) * t,
    fg[2] + (bg[2] - fg[2]) * t,
  ];
  return { background: bg, wall: mix(0.45), wallDark: mix(0.6), success: toRgb(p.success), warning: toRgb(p.warning) };
}
function colors(p: Palette) {
  const key = `${p.foreground}|${p.background}|${p.success}|${p.warning}`;
  if (cached?.key !== key) cached = { key, value: computeColors(p) };
  return cached.value;
}

function time(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** First-person view of the runner, drawn from the world's own layout; a minimap in the corner. */
export function WorldView() {
  const { world, agent } = useDemo();
  const layout = useTopic<Layout>(world, WorldTopic.layout);
  const view = useTopic<MazeView>(world, WorldTopic.view);
  const state = useRef({ layout, view });
  state.current = { layout, view };
  const [focused, setFocused] = useState(false);
  const [minimap, setMinimap] = useState(true);
  const minimapRef = useRef(minimap);
  minimapRef.current = minimap;

  const canvas = useCanvas((ctx, { w, h }, p) => {
    const { layout: L, view: v } = state.current;
    if (!L || !v) return;
    const { x, y, yaw } = v.pose;
    // Ceiling and floor.
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, w, h / 2);
    ctx.fillStyle = p.surface;
    ctx.fillRect(0, h / 2, w, h / 2);
    const rgb = colors(p);
    const colW = 2;
    const cols = Math.ceil(w / colW);
    const zbuf = new Float32Array(cols);
    const half = Math.tan(FOV / 2);
    for (let i = 0; i < cols; i++) {
      const off = Math.atan(((i + 0.5) / cols - 0.5) * 2 * half);
      const hit = castRay(L.grid, x, y, yaw + off, 24);
      const dist = Math.max(0.05, hit.dist * Math.cos(off));
      zbuf[i] = dist;
      const wallH = Math.min(h * 3, (h * 0.9) / dist);
      const top = Math.round((h - wallH) / 2);
      const base =
        hit.tile === "X" ? (v.exitOpen ? rgb.success : rgb.warning) : hit.side === 1 ? rgb.wallDark : rgb.wall;
      // Nearer walls are brighter; far ones fade into the ceiling colour.
      ctx.fillStyle = mixRgb(base, rgb.background, Math.min(0.9, dist / 12));
      ctx.fillRect(i * colW, top, colW, Math.round(wallH));
    }
    // Cores, nearest last, hidden behind walls.
    const sprites = v.cores
      .map(([cx, cy]) => {
        const dx = cx + 0.5 - x;
        const dy = cy + 0.5 - y;
        const a = wrapAngle(Math.atan2(dy, dx) - yaw);
        return { a, d: Math.hypot(dx, dy) * Math.cos(a) };
      })
      .filter((s) => Math.abs(s.a) < FOV / 2 + 0.2 && s.d > 0.1)
      .sort((a, b) => b.d - a.d);
    for (const s of sprites) {
      const sx = w / 2 + (Math.tan(s.a) / half) * (w / 2);
      const col = Math.floor(sx / colW);
      if (col < 0 || col >= cols || zbuf[col]! < s.d) continue;
      const r = Math.min(h * 0.3, (h * 0.12) / s.d);
      ctx.fillStyle = p.accent;
      ctx.globalAlpha = Math.max(0.35, 1 - s.d / 14);
      ctx.beginPath();
      ctx.moveTo(sx, h / 2 - r);
      ctx.lineTo(sx + r * 0.7, h / 2);
      ctx.lineTo(sx, h / 2 + r);
      ctx.lineTo(sx - r * 0.7, h / 2);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (minimapRef.current) drawMinimap(ctx, L, v, w, p);
  });

  // Keyboard teleop: key state on change, and a keepalive while keys are held (the deadman is 250 ms).
  const held = useRef(new Set<string>());
  const send = (input: unknown) => agent.command(AgentCommand.input, { id: "manual", input }).catch(() => undefined);
  const drive = () => {
    const k = held.current;
    const on = (names: string[]) => names.some((n) => k.has(n));
    void send({
      kind: "drive",
      forward: (on(KEYS.forward) ? 1 : 0) - (on(KEYS.back) ? 1 : 0),
      strafe: (on(KEYS.right) ? 1 : 0) - (on(KEYS.left) ? 1 : 0),
      turn: (on(KEYS.turnRight) ? 1 : 0) - (on(KEYS.turnLeft) ? 1 : 0),
      fast: k.has("shift"),
    });
  };
  useEffect(() => {
    const t = setInterval(() => held.current.size > 0 && drive(), 100);
    return () => clearInterval(t);
  });

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="First-person view of the maze. Click, then drive with W A S D and the arrow keys."
        className="h-full w-full outline-none"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          held.current.clear();
          drive();
        }}
        onPointerDown={(e) => e.currentTarget.focus()}
        onKeyDown={(e) => {
          const key = e.key.toLowerCase();
          if (key === "m") return setMinimap((m) => !m);
          if (key === "f" || key === "enter") return void send({ kind: "interact" });
          if (key === " ") {
            e.preventDefault();
            held.current.clear();
            return void send({ kind: "stop" });
          }
          if (Object.values(KEYS).flat().includes(key) || key === "shift") {
            e.preventDefault();
            if (!held.current.has(key)) {
              held.current.add(key);
              drive();
            }
          }
        }}
        onKeyUp={(e) => {
          held.current.delete(e.key.toLowerCase());
          drive();
        }}
      />
      {view && (
        <div className="tnum pointer-events-none absolute top-3 left-3 flex gap-4 rounded-full bg-overlay/80 px-3 py-1.5 text-xs text-muted backdrop-blur">
          <span>
            Cores <span className="text-foreground">{view.collected}</span> of {view.collected + view.cores.length}
          </span>
          <span className="text-foreground">{time(view.elapsed)}</span>
          {view.safeStopped && <span className="text-warning">Safe stop</span>}
        </div>
      )}
      {view?.escaped && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-overlay px-4 py-2 text-sm text-foreground shadow-overlay">
            Escaped in {time(view.elapsed)}
          </span>
        </div>
      )}
      {!focused && !view?.escaped && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span className="rounded-full bg-overlay/80 px-3 py-1.5 text-xs text-muted backdrop-blur">
            Click to drive
          </span>
        </div>
      )}
    </div>
  );
}

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  v: MazeView,
  w: number,
  p: { border: string; foreground: string; accent: string; success: string; warning: string; surface: string },
) {
  const size = Math.min(160, w * 0.28);
  const cell = size / L.width;
  const ox = w - size - 12;
  const oy = 12;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = p.surface;
  ctx.beginPath();
  ctx.roundRect(ox - 6, oy - 6, size + 12, size + 12, 10);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = p.border;
  L.grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === "#") ctx.fillRect(ox + x * cell, oy + y * cell, cell + 0.3, cell + 0.3);
  });
  const [ex, ey] = L.exit;
  ctx.fillStyle = v.exitOpen ? p.success : p.warning;
  ctx.fillRect(ox + ex * cell, oy + ey * cell, cell, cell);
  ctx.fillStyle = p.accent;
  for (const [cx, cy] of v.cores) {
    ctx.beginPath();
    ctx.arc(ox + (cx + 0.5) * cell, oy + (cy + 0.5) * cell, Math.max(1.5, cell * 0.28), 0, Math.PI * 2);
    ctx.fill();
  }
  const px = ox + v.pose.x * cell;
  const py = oy + v.pose.y * cell;
  const r = Math.max(3, cell * 0.55);
  ctx.fillStyle = p.foreground;
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(v.pose.yaw) * r, py + Math.sin(v.pose.yaw) * r);
  ctx.lineTo(px + Math.cos(v.pose.yaw + 2.5) * r * 0.8, py + Math.sin(v.pose.yaw + 2.5) * r * 0.8);
  ctx.lineTo(px + Math.cos(v.pose.yaw - 2.5) * r * 0.8, py + Math.sin(v.pose.yaw - 2.5) * r * 0.8);
  ctx.closePath();
  ctx.fill();
}
