import type { ReactNode } from "react";
import type { RangesPayload } from "../shared/maze.ts";

/** The range scan as the agent receives it: rays from the runner, heading up. */
export function ScanView({ payload }: { payload: unknown }): ReactNode {
  const r = payload as RangesPayload;
  if (!r?.ranges_m) return null;
  const size = 220;
  const c = size / 2;
  const k = (c - 8) / r.max_m;
  const pts = r.ranges_m.map((d, i) => {
    // Heading up: bearing 0 points to -y on screen; positive bearings to the right.
    const b = r.bearings_rad[i]! - Math.PI / 2;
    return [c + Math.cos(b) * d * k, c + Math.sin(b) * d * k] as const;
  });
  return (
    <div className="flex flex-col items-center gap-2 pt-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Range scan">
        <polygon
          points={pts.map(([x, y]) => `${x},${y}`).join(" ")}
          className="fill-accent/10 stroke-accent"
          strokeWidth={1}
        />
        {pts.map(([x, y], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rays are identified by their index
          <line key={i} x1={c} y1={c} x2={x} y2={y} className="stroke-border" strokeWidth={0.75} />
        ))}
        <circle cx={c} cy={c} r={3} className="fill-foreground" />
      </svg>
      <span className="text-xs text-muted">32 rays · up is ahead</span>
    </div>
  );
}
