import { AgentCommand, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { type Palette, useCanvas, useDemo } from "@awp-demo/ui";
import { useRef, useState } from "react";
import { CELL, type Color, type SorterView } from "../shared/cell.ts";

const X0 = -1.06;
const X1 = 0.96;
const Z0 = -0.03;
const Z1 = 1.02;

function project(w: number, h: number) {
  const pad = 16;
  const s = Math.min((w - 2 * pad) / (X1 - X0), (h - 2 * pad - 24) / (Z1 - Z0));
  const ox = (w - s * (X1 - X0)) / 2 - X0 * s;
  const oy = h - (h - s * (Z1 - Z0)) / 2 - 8 + Z0 * s;
  return {
    s,
    toPx: (x: number, z: number) => [ox + x * s, oy - z * s] as const,
    toWorld: (px: number, py: number) => [(px - ox) / s, (oy - py) / s] as const,
  };
}

function colorOf(c: Color, p: Palette): string {
  return c === "red" ? p.danger : c === "green" ? p.success : p.accent;
}

/** The cell, side on. Click to send the manual controller there; arrows jog, G grips, R releases. */
export function WorldView() {
  const { world, agent } = useDemo();
  const view = useTopic<SorterView>(world, WorldTopic.view);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [pointer, setPointer] = useState<[number, number] | null>(null);
  const sizeRef = useRef({ w: 1, h: 1 });

  const canvas = useCanvas((ctx, size, p) => {
    sizeRef.current = size;
    const v = viewRef.current;
    const { s, toPx } = project(size.w, size.h);
    const line = (a: readonly [number, number], b: readonly [number, number]) => {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    };

    // Floor and reach.
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    line(toPx(X0 + 0.02, 0), toPx(X1 - 0.02, 0));
    const [sx, sz] = CELL.shoulder;
    const [cx, cy] = toPx(sx, sz);
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.arc(cx, cy, (CELL.l1 + CELL.l2) * s, Math.PI * 0.95, Math.PI * 2.05);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pedestal.
    ctx.fillStyle = p.surfaceSecondary;
    const [px0, py0] = toPx(sx - 0.035, sz);
    ctx.beginPath();
    ctx.roundRect(px0, py0, 0.07 * s, sz * s, 4);
    ctx.fill();

    // Belt, with ticks that move with it.
    const { x0, x1, z } = CELL.belt;
    const [bx0, by0] = toPx(x0, z);
    const [bx1, by1] = toPx(x1, z - 0.04);
    ctx.fillStyle = p.surfaceSecondary;
    ctx.beginPath();
    ctx.roundRect(bx0, by0, bx1 - bx0, by1 - by0, (by1 - by0) / 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(bx0, by0, bx1 - bx0, by1 - by0, (by1 - by0) / 2);
    ctx.clip();
    ctx.strokeStyle = p.border;
    const offset = v?.belt.offset ?? 0;
    for (let x = x0 - 0.1 + offset; x < x1; x += 0.1) line(toPx(x, z), toPx(x - 0.02, z - 0.04));
    ctx.restore();

    // Bins.
    for (const b of CELL.bins) {
      const col = colorOf(b.color, p);
      const [lx, ty] = toPx(b.x - b.w / 2, b.z);
      const [rx, bot] = toPx(b.x + b.w / 2, b.z - 0.12);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = col;
      ctx.fillRect(lx, ty, rx - lx, bot - ty);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx, ty);
      ctx.lineTo(lx, bot);
      ctx.lineTo(rx, bot);
      ctx.lineTo(rx, ty);
      ctx.stroke();
      const counts = v?.bins.find((x) => x.color === b.color);
      ctx.fillStyle = p.muted;
      ctx.font = "500 11px 'Geist Variable', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(counts?.count ?? 0), (lx + rx) / 2, bot + 16);
    }

    if (!v) return;

    // Parcels.
    for (const parcel of v.parcels) {
      const half = CELL.parcel / 2;
      const [x, y] = toPx(parcel.x - half, parcel.z + half);
      ctx.fillStyle = colorOf(parcel.color, p);
      ctx.beginPath();
      ctx.roundRect(x, y, CELL.parcel * s, CELL.parcel * s, 3);
      ctx.fill();
    }

    // Target.
    if (v.arm.target) {
      const [tx, ty] = toPx(v.arm.target[0], v.arm.target[1]);
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.25;
      line([tx - 6, ty], [tx + 6, ty]);
      line([tx, ty - 6], [tx, ty + 6]);
    }

    // Arm.
    const [q1, q2] = v.arm.q;
    const elbow = [sx + CELL.l1 * Math.cos(q1), sz + CELL.l1 * Math.sin(q1)] as const;
    const [ex, ez] = v.arm.ee;
    ctx.lineCap = "round";
    ctx.strokeStyle = p.foreground;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = Math.max(6, 0.028 * s);
    line(toPx(sx, sz), toPx(elbow[0], elbow[1]));
    ctx.lineWidth = Math.max(5, 0.022 * s);
    line(toPx(elbow[0], elbow[1]), toPx(ex, ez + 0.012));
    ctx.globalAlpha = 1;
    for (const [jx, jz] of [[sx, sz], elbow] as const) {
      const [x, y] = toPx(jx, jz);
      ctx.fillStyle = p.surface;
      ctx.strokeStyle = p.foreground;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(4, 0.016 * s), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Gripper fingers.
    const half = v.gripper.width / 2;
    ctx.strokeStyle = p.foreground;
    ctx.lineWidth = Math.max(2.5, 0.008 * s);
    line(toPx(ex - half - 0.006, ez + 0.012), toPx(ex + half + 0.006, ez + 0.012));
    line(toPx(ex - half - 0.006, ez + 0.012), toPx(ex - half - 0.006, ez - 0.035));
    line(toPx(ex + half + 0.006, ez + 0.012), toPx(ex + half + 0.006, ez - 0.035));
    ctx.lineCap = "butt";
  });

  const send = (input: unknown) => agent.command(AgentCommand.input, { id: "manual", input }).catch(() => undefined);
  const toWorld = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return project(sizeRef.current.w, sizeRef.current.h).toWorld(e.clientX - r.left, e.clientY - r.top);
  };

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="Sorting cell. Click to move the arm; arrows jog, G grips, R releases."
        className="h-full w-full cursor-crosshair outline-none"
        onPointerMove={(e) => setPointer(toWorld(e) as [number, number])}
        onPointerLeave={() => setPointer(null)}
        onPointerDown={(e) => {
          e.currentTarget.focus();
          const [x, z] = toWorld(e);
          void send({ kind: "target", x, z });
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.08 : 0.02;
          const jog: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, step],
            ArrowDown: [0, -step],
          };
          if (jog[e.key]) {
            e.preventDefault();
            void send({ kind: "jog", dx: jog[e.key]![0], dz: jog[e.key]![1] });
          } else if (e.key === "g") void send({ kind: "grip" });
          else if (e.key === "r") void send({ kind: "release" });
          else if (e.key === " " || e.key === "s") {
            e.preventDefault();
            void send({ kind: "stop" });
          }
        }}
      />
      {view && (
        <div className="tnum pointer-events-none absolute top-3 left-4 flex gap-4 text-xs text-muted">
          <span>
            Sorted <span className="text-foreground">{view.stats.sorted}</span>
          </span>
          <span>
            Wrong <span className={view.stats.wrong ? "text-danger" : "text-foreground"}>{view.stats.wrong}</span>
          </span>
          <span>
            Missed <span className="text-foreground">{view.stats.missed + view.stats.dropped}</span>
          </span>
        </div>
      )}
      {pointer && (
        <div className="tnum pointer-events-none absolute bottom-3 left-4 font-mono text-xs text-muted">
          x {pointer[0].toFixed(2)} · z {pointer[1].toFixed(2)}
        </div>
      )}
    </div>
  );
}
