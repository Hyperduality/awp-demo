import { AgentCommand, WorldCommand, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { type Palette, Segmented, useCanvas, useDemo } from "@awp-demo/ui";
import { useRef, useState } from "react";
import { type DispatchLayout, type DispatchView, type Kind, nodeName } from "../shared/city.ts";

// Bands kept clear of the map: the shift figures above, the hint below; and room for the rulers.
const TOP = 56;
const BOTTOM = 40;
const SIDE = 48;

function geometry(w: number, h: number, l: DispatchLayout) {
  const s = Math.min((w - 2 * SIDE) / (l.cols - 1), (h - TOP - BOTTOM - 32) / (l.rows - 1));
  const ox = (w - s * (l.cols - 1)) / 2;
  const oy = TOP + 28 + (h - TOP - BOTTOM - 32 - s * (l.rows - 1)) / 2;
  return { s, px: (x: number) => ox + x * s, py: (y: number) => oy + y * s };
}

const tone = (kind: Kind, p: Palette) => (kind === "fire" ? p.danger : kind === "medical" ? p.success : p.accent);
const SHORT: Record<Kind, string> = { fire: "E", medical: "M", police: "P" };
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * The city from above. Units carry their kind's letter and number; calls are rings that close as
 * their time runs out. Click a unit, then a call to dispatch it or an intersection to stage it.
 */
export function WorldView() {
  const { world, agent } = useDemo();
  const view = useTopic<DispatchView>(world, WorldTopic.view);
  const layout = useTopic<DispatchLayout>(world, WorldTopic.layout);
  const ref = useRef({ view, layout, size: { w: 1, h: 1 } });
  ref.current.view = view;
  ref.current.layout = layout;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const canvas = useCanvas((ctx, size, p, t) => {
    ref.current.size = size;
    const { view: v, layout: l } = ref.current;
    if (!v || !l) return;
    const { s, px, py } = geometry(size.w, size.h, l);

    // The river, with the bridges drawn over it as streets.
    const ry = py(l.riverAfter + 0.5);
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(px(0) - s * 0.6, ry - s * 0.22, s * (l.cols - 1) + s * 1.2, s * 0.44);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = p.border;
    ctx.lineWidth = Math.max(2, s * 0.08);
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let y = 0; y < l.rows; y++) {
      ctx.moveTo(px(0), py(y));
      ctx.lineTo(px(l.cols - 1), py(y));
    }
    for (let x = 0; x < l.cols; x++) {
      const bridge = l.bridges.includes(x);
      ctx.moveTo(px(x), py(0));
      ctx.lineTo(px(x), py(bridge ? l.rows - 1 : l.riverAfter));
      if (!bridge) {
        ctx.moveTo(px(x), py(l.riverAfter + 1));
        ctx.lineTo(px(x), py(l.rows - 1));
      }
    }
    ctx.stroke();

    // Rulers: avenues above, streets to the left.
    ctx.fillStyle = p.muted;
    ctx.font = "500 11px 'Geist Variable', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Clear of a call ring on the outermost streets.
    const gap = Math.max(9, s * 0.26) + 10;
    for (let x = 0; x < l.cols; x++) ctx.fillText(String.fromCharCode(65 + x), px(x), py(0) - gap);
    for (let y = 0; y < l.rows; y++) ctx.fillText(String(y + 1), px(0) - gap, py(y));

    for (const st of l.stations) {
      ctx.strokeStyle = tone(st.kind, p);
      ctx.lineWidth = 1.5;
      const r = s * 0.2;
      ctx.strokeRect(px(st.x) - r, py(st.y) - r, 2 * r, 2 * r);
    }

    // Routes, under everything that moves.
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    for (const u of v.units) {
      if (u.path.length < 2) continue;
      ctx.strokeStyle = tone(u.kind, p);
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      const [first, ...rest] = u.path;
      ctx.moveTo(px(first![0]), py(first![1]));
      for (const [x, y] of rest) ctx.lineTo(px(x), py(y));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Calls: the ring is the share of the call's time still left.
    for (const c of v.calls) {
      const left = Math.max(0, 1 - c.age_s / c.window_s);
      const r = Math.max(9, s * 0.26);
      const cx = px(c.x);
      const cy = py(c.y);
      ctx.fillStyle = p.surface;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.border;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = left < 0.3 ? p.danger : p.warning;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = p.foreground;
      ctx.font = "600 11px 'Geist Variable', sans-serif";
      ctx.fillText(`${c.id}`, cx, cy);
    }

    // Outcomes rise and fade where calls closed.
    for (const c of v.closed) {
      const k = Math.min(1, c.ago_s / 6);
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = c.outcome === "resolved" ? p.success : p.danger;
      ctx.font = "600 12px 'Geist Variable', sans-serif";
      ctx.fillText(`${c.points > 0 ? "+" : ""}${c.points}`, px(c.x), py(c.y) - 14 - k * 16);
    }
    ctx.globalAlpha = 1;

    // Units, offset a little when several share a spot.
    const seen = new Map<string, number>();
    for (const u of v.units) {
      const key = `${Math.round(u.x * 4)},${Math.round(u.y * 4)}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const ux = px(u.x) + (n % 2) * 13 - (n > 0 ? 6 : 0);
      const uy = py(u.y) - Math.floor(n / 2) * 13 + (n > 0 ? 6 : 0);
      const w = 22;
      const h = 16;
      if (u.id === selectedRef.current) {
        ctx.strokeStyle = p.foreground;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(ux - w / 2 - 3, uy - h / 2 - 3, w + 6, h + 6, 6);
        ctx.stroke();
      }
      ctx.fillStyle = tone(u.kind, p);
      ctx.globalAlpha = u.status === "on_scene" ? 0.6 + 0.4 * Math.abs(Math.sin(t / 300)) : 1;
      ctx.beginPath();
      ctx.roundRect(ux - w / 2, uy - h / 2, w, h, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = p.background;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = p.background;
      ctx.font = "600 10px 'Geist Variable', sans-serif";
      ctx.fillText(`${SHORT[u.kind]}${u.label.slice(-1)}`, ux, uy + 0.5);
    }
  });

  const send = (input: unknown) => agent.command(AgentCommand.input, { id: "manual", input }).catch(() => undefined);
  const hit = (cx: number, cy: number) => {
    const { view: v, layout: l, size } = ref.current;
    if (!v || !l) return undefined;
    const { s, px, py } = geometry(size.w, size.h, l);
    const near = (x: number, y: number, r: number) => Math.hypot(px(x) - cx, py(y) - cy) <= r;
    const unit = v.units.find((u) => near(u.x, u.y, 14));
    const call = v.calls.find((c) => near(c.x, c.y, Math.max(12, s * 0.3)));
    const gx = Math.round((cx - px(0)) / s);
    const gy = Math.round((cy - py(0)) / s);
    const node =
      gx >= 0 && gy >= 0 && gx < l.cols && gy < l.rows && near(gx, gy, s * 0.35) ? nodeName(gx, gy) : undefined;
    return { unit, call, node };
  };
  const units = view?.units ?? [];
  const chosen = units.find((u) => u.id === selected);
  const shift = view?.shift;

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="The city from above. Click a unit, then a call to dispatch it there or an intersection to stage it."
        className="h-full w-full cursor-pointer outline-none"
        onPointerDown={(e) => {
          e.currentTarget.focus();
          const rect = e.currentTarget.getBoundingClientRect();
          const h = hit(e.clientX - rect.left, e.clientY - rect.top);
          if (!h) return;
          if (h.unit && (!selected || !h.call)) setSelected(h.unit.id === selected ? null : h.unit.id);
          else if (selected && h.call) {
            void send({ kind: "dispatch", unit: selected, call: h.call.id });
            setSelected(null);
          } else if (selected && h.node) {
            void send({ kind: "stage", unit: selected, at: h.node });
            setSelected(null);
          } else setSelected(null);
        }}
        onKeyDown={(e) => {
          const n = Number(e.key);
          if (n >= 1 && n <= units.length) setSelected(units[n - 1]!.id);
          else if (e.key === "Escape") setSelected(null);
          else if (e.key === "c" && selected) void send({ kind: "cancel", unit: selected });
        }}
      />
      {shift && (
        <div className="tnum pointer-events-none absolute top-3 left-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            Shift{" "}
            <span className="text-foreground">
              {clock(shift.clock_s)} / {clock(shift.clock_s + shift.left_s)}
            </span>
          </span>
          <span>
            Score <span className="text-foreground">{shift.score}</span>
          </span>
          <span>
            Resolved <span className="text-foreground">{shift.resolved}</span>
          </span>
          <span>
            Lost <span className={shift.lost > 0 ? "text-danger" : "text-foreground"}>{shift.lost}</span>
          </span>
          <span>
            Response{" "}
            <span className="text-foreground">
              {shift.avg_response_s === null ? "—" : `${Math.round(shift.avg_response_s)} s`}
            </span>
          </span>
        </div>
      )}
      <div className="absolute top-2 right-3">
        <Segmented
          label="City speed"
          value={String(shift?.speed ?? 1)}
          onChange={(k) => world.command(WorldCommand.operator, { name: "speed", args: { speed: Number(k) } })}
          options={[
            { id: "0.5", label: "0.5×" },
            { id: "1", label: "1×" },
            { id: "2", label: "2×" },
            { id: "3", label: "3×" },
          ]}
        />
      </div>
      {shift && shift.phase !== "on" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl bg-surface/90 px-5 py-3 text-center text-sm shadow-sm">
            {shift.phase === "waiting" ? (
              <span className="text-muted">The shift has not started. Start it from the header.</span>
            ) : (
              <span className="text-foreground">
                Shift over · score {shift.score} · {shift.resolved} resolved · {shift.lost} lost · {shift.open} open
              </span>
            )}
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
        <span className="truncate text-xs text-muted">
          {chosen
            ? `${chosen.label} selected: click a call to send it, or an intersection to stage it. C cancels its job.`
            : "Click a unit to dispatch it yourself."}
        </span>
      </div>
    </div>
  );
}
