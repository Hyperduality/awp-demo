/** Floating-panel geometry: fractions of the workspace, snapping, persistence. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A panel's default placement on a 12×12 grid: [column, row, columns, rows]. */
export type Area = [number, number, number, number];

export const GUTTER = 12;
const SNAP = 10;
const GRID = 8;

export interface LayoutState {
  rects: Record<string, Rect>;
  z: string[];
  minimized: string[];
  maximized: string | null;
}

export function areaToRect(area: Area, width: number, height: number): Rect {
  const [c, r, cs, rs] = area;
  const cw = (width - GUTTER * 13) / 12;
  const rh = (height - GUTTER * 13) / 12;
  const px = {
    x: GUTTER + c * (cw + GUTTER),
    y: GUTTER + r * (rh + GUTTER),
    w: cs * cw + (cs - 1) * GUTTER,
    h: rs * rh + (rs - 1) * GUTTER,
  };
  return toFraction(px, width, height);
}

export function toPx(r: Rect, width: number, height: number): Rect {
  return { x: r.x * width, y: r.y * height, w: r.w * width, h: r.h * height };
}

export function toFraction(r: Rect, width: number, height: number): Rect {
  return { x: r.x / width, y: r.y / height, w: r.w / width, h: r.h / height };
}

/** Snaps a moving or resizing rect to the workspace edges, its neighbours, and an 8 px grid. */
export function snap(
  r: Rect,
  others: Rect[],
  width: number,
  height: number,
  edges: { l: boolean; r: boolean; t: boolean; b: boolean },
): Rect {
  const xs = [GUTTER, width - GUTTER];
  const ys = [GUTTER, height - GUTTER];
  for (const o of others) {
    xs.push(o.x, o.x + o.w, o.x - GUTTER, o.x + o.w + GUTTER);
    ys.push(o.y, o.y + o.h, o.y - GUTTER, o.y + o.h + GUTTER);
  }
  const nearest = (v: number, cands: number[]) => {
    let best: number | undefined;
    for (const c of cands)
      if (Math.abs(c - v) <= SNAP && (best === undefined || Math.abs(c - v) < Math.abs(best - v))) best = c;
    return best ?? Math.round(v / GRID) * GRID;
  };
  let { x, y, w, h } = r;
  const moving = edges.l && edges.r;
  if (moving) {
    const left = nearest(x, xs);
    const right = nearest(x + w, xs);
    x = Math.abs(left - x) <= Math.abs(right - (x + w)) ? left : right - w;
  } else {
    if (edges.l) {
      const nx = nearest(x, xs);
      w += x - nx;
      x = nx;
    }
    if (edges.r) w = nearest(x + w, xs) - x;
  }
  const movingY = edges.t && edges.b;
  if (movingY) {
    const top = nearest(y, ys);
    const bottom = nearest(y + h, ys);
    y = Math.abs(top - y) <= Math.abs(bottom - (y + h)) ? top : bottom - h;
  } else {
    if (edges.t) {
      const ny = nearest(y, ys);
      h += y - ny;
      y = ny;
    }
    if (edges.b) h = nearest(y + h, ys) - y;
  }
  return { x, y, w, h };
}

export function clampRect(r: Rect, width: number, height: number, minW: number, minH: number): Rect {
  const w = Math.max(minW, Math.min(r.w, width));
  const h = Math.max(minH, Math.min(r.h, height));
  const x = Math.min(Math.max(0, r.x), Math.max(0, width - w));
  const y = Math.min(Math.max(0, r.y), Math.max(0, height - h));
  return { x, y, w, h };
}

const VERSION = 2;

export function loadLayout(key: string): LayoutState | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as LayoutState & { version?: number };
    return v.version === VERSION ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveLayout(key: string, state: LayoutState): void {
  try {
    localStorage.setItem(key, JSON.stringify({ ...state, version: VERSION }));
  } catch {
    /* storage unavailable */
  }
}

export function clearLayout(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
