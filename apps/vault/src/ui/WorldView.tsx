import { AgentCommand, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { mixRgb, type Palette, Segmented, toRgb, useCanvas, useDemo } from "@awp-demo/ui";
import { useRef, useState } from "react";
import type { VaultView } from "../shared/vault.ts";

type Mode = "truth" | "agent";

function geometry(w: number, h: number, cols: number, rows: number) {
  const size = Math.floor(Math.min((w - 32) / cols, (h - 72) / rows));
  const ox = Math.round((w - size * cols) / 2);
  const oy = Math.round((h - size * rows) / 2 + 12);
  return { size, ox, oy };
}

function tint(c: string, p: Palette): string {
  const lower = c.toLowerCase();
  return lower === "r" ? p.danger : lower === "b" ? p.accent : lower === "y" ? p.warning : p.foreground;
}

/** The vault from above. Agent View shows only what the explorer has seen. Click a tile to walk there. */
export function WorldView() {
  const { world, agent } = useDemo();
  const view = useTopic<VaultView>(world, WorldTopic.view);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [mode, setMode] = useState<Mode>("agent");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const sizeRef = useRef({ w: 1, h: 1 });

  const canvas = useCanvas((ctx, size, p) => {
    sizeRef.current = size;
    const v = viewRef.current;
    if (!v) return;
    const rows = v.truth.length;
    const cols = v.truth[0]!.length;
    const { size: s, ox, oy } = geometry(size.w, size.h, cols, rows);
    const r = Math.max(2, s * 0.18);
    const wall = mixRgb(toRgb(p.foreground), toRgb(p.background), 0.72);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const seen = v.seen[y]![x] === "1";
        if (modeRef.current === "agent" && !seen) continue;
        const c = v.truth[y]![x]!;
        const px = ox + x * s;
        const py = oy + y * s;
        ctx.globalAlpha = seen ? 1 : 0.35;
        if (c === "#") {
          ctx.fillStyle = wall;
          ctx.fillRect(px, py, s, s);
        } else {
          ctx.fillStyle = p.surfaceSecondary;
          ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
          if ("RBY".includes(c)) {
            ctx.fillStyle = tint(c, p);
            ctx.beginPath();
            ctx.roundRect(px + s * 0.12, py + s * 0.12, s * 0.76, s * 0.76, r);
            ctx.fill();
          } else if (c === "+") {
            ctx.strokeStyle = p.muted;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(px + s * 0.18, py + s * 0.18, s * 0.64, s * 0.64);
          } else if ("rby".includes(c)) {
            ctx.fillStyle = tint(c, p);
            ctx.beginPath();
            ctx.arc(px + s * 0.42, py + s * 0.5, s * 0.16, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(px + s * 0.5, py + s * 0.46, s * 0.28, s * 0.08);
          } else if (c === "*") {
            ctx.fillStyle = p.success;
            ctx.beginPath();
            ctx.moveTo(px + s / 2, py + s * 0.18);
            ctx.lineTo(px + s * 0.8, py + s / 2);
            ctx.lineTo(px + s / 2, py + s * 0.82);
            ctx.lineTo(px + s * 0.2, py + s / 2);
            ctx.closePath();
            ctx.fill();
          } else if (c === "E") {
            ctx.strokeStyle = p.success;
            ctx.lineWidth = 2;
            ctx.strokeRect(px + s * 0.15, py + s * 0.15, s * 0.7, s * 0.7);
          }
        }
        ctx.globalAlpha = 1;
      }
    // The path of the current walk.
    if (v.path.length > 0) {
      ctx.fillStyle = p.accent;
      for (const [x, y] of v.path) {
        ctx.beginPath();
        ctx.arc(ox + (x + 0.5) * s, oy + (y + 0.5) * s, Math.max(1.5, s * 0.07), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // The explorer, with a tick for facing.
    const [ax, ay] = v.avatar;
    const cx = ox + (ax + 0.5) * s;
    const cy = oy + (ay + 0.5) * s;
    ctx.fillStyle = p.foreground;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2);
    ctx.fill();
    const f = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[v.facing];
    ctx.strokeStyle = p.background;
    ctx.lineWidth = Math.max(2, s * 0.08);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + f[0]! * s * 0.22, cy + f[1]! * s * 0.22);
    ctx.stroke();
    ctx.lineCap = "butt";
  });

  const send = (input: unknown) => agent.command(AgentCommand.input, { id: "manual", input }).catch(() => undefined);
  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="The vault from above. Click a tile to walk there; arrows step, E uses the tile ahead, Space picks up."
        className="h-full w-full cursor-pointer outline-none"
        onPointerDown={(e) => {
          e.currentTarget.focus();
          const v = viewRef.current;
          if (!v) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const {
            size: s,
            ox,
            oy,
          } = geometry(sizeRef.current.w, sizeRef.current.h, v.truth[0]!.length, v.truth.length);
          const x = Math.floor((e.clientX - rect.left - ox) / s);
          const y = Math.floor((e.clientY - rect.top - oy) / s);
          if (x >= 0 && y >= 0 && x < v.truth[0]!.length && y < v.truth.length)
            void send({ kind: "walk", cell: [x, y] });
        }}
        onKeyDown={(e) => {
          const dir = { ArrowUp: "north", ArrowDown: "south", ArrowLeft: "west", ArrowRight: "east" }[e.key];
          if (dir) {
            e.preventDefault();
            void send({ kind: "move", direction: dir });
          } else if (e.key === "e") void send({ kind: "use", ahead: true });
          else if (e.key === " ") {
            e.preventDefault();
            void send({ kind: "use", ahead: false });
          }
        }}
      />
      {view && (
        <div className="tnum pointer-events-none absolute top-3 left-4 flex gap-4 text-xs text-muted">
          <span>
            Carrying{" "}
            <span className="text-foreground">{view.inventory.length ? view.inventory.join(", ") : "nothing"}</span>
          </span>
          <span>
            Steps <span className="text-foreground">{view.steps}</span>
          </span>
        </div>
      )}
      <div className="absolute top-2 right-3">
        <Segmented
          label="View"
          value={mode}
          onChange={setMode}
          options={[
            { id: "agent", label: "Agent View" },
            { id: "truth", label: "Truth" },
          ]}
        />
      </div>
      {view && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
          <span className={`truncate text-xs ${view.escaped ? "text-success" : "text-muted"}`}>{view.message}</span>
        </div>
      )}
    </div>
  );
}
