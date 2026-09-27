import { ArrowsExpand, ChevronsCollapseUpRight, Minus } from "@gravity-ui/icons";
import { Card } from "@heroui/react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "../primitives/IconButton.tsx";
import {
  type Area,
  areaToRect,
  clampRect,
  clearLayout,
  GUTTER,
  type LayoutState,
  loadLayout,
  type Rect,
  saveLayout,
  snap,
  toFraction,
  toPx,
} from "./layout.ts";

export interface PanelDef {
  id: string;
  title: string;
  /** Default placement on a 12×12 grid: [column, row, columns, rows]. */
  area: Area;
  minWidth?: number;
  minHeight?: number;
  /** Header actions, right-aligned. */
  actions?: ReactNode;
  /** Content fills the panel edge to edge (e.g. a world view). */
  flush?: boolean;
  /** Height when stacked on small screens. */
  stackedHeight?: number;
  /** Start minimized in the dock. */
  hidden?: boolean;
  children: ReactNode;
}

export interface WorkspaceApi {
  state: LayoutState;
  reset(): void;
  restore(id: string): void;
  minimize(id: string): void;
  toggleMaximize(id: string): void;
  focus(id: string): void;
  setRect(id: string, r: Rect): void;
}

function defaults(panels: PanelDef[]): LayoutState {
  // Fractions need a size; any size works for the grid math, which is proportional up to gutters.
  const W = 1600;
  const H = 900;
  return {
    rects: Object.fromEntries(panels.map((p) => [p.id, areaToRect(p.area, W, H)])),
    z: panels.map((p) => p.id),
    minimized: panels.filter((p) => p.hidden).map((p) => p.id),
    maximized: null,
  };
}

export function useWorkspace(demoId: string, panels: PanelDef[]): WorkspaceApi {
  const key = `awp-demo:layout:${demoId}`;
  const [state, setState] = useState<LayoutState>(() => {
    const d = defaults(panels);
    const saved = loadLayout(key);
    if (!saved) return d;
    return {
      rects: { ...d.rects, ...saved.rects },
      z: [...saved.z.filter((id) => d.rects[id]), ...d.z.filter((id) => !saved.z.includes(id))],
      minimized: saved.minimized.filter((id) => d.rects[id]),
      maximized: null,
    };
  });
  useEffect(() => saveLayout(key, { ...state, maximized: null }), [key, state]);
  const ids = panels.map((p) => p.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute only when the panel set changes
  const api = useMemo<WorkspaceApi>(
    () => ({
      state,
      reset() {
        clearLayout(key);
        setState(defaults(panels));
      },
      restore: (id) =>
        setState((s) => ({
          ...s,
          minimized: s.minimized.filter((m) => m !== id),
          z: [...s.z.filter((z) => z !== id), id],
        })),
      minimize: (id) =>
        setState((s) => ({
          ...s,
          minimized: [...new Set([...s.minimized, id])],
          maximized: s.maximized === id ? null : s.maximized,
        })),
      toggleMaximize: (id) =>
        setState((s) => ({ ...s, maximized: s.maximized === id ? null : id, z: [...s.z.filter((z) => z !== id), id] })),
      focus: (id) =>
        setState((s) => (s.z[s.z.length - 1] === id ? s : { ...s, z: [...s.z.filter((z) => z !== id), id] })),
      setRect: (id, r) => setState((s) => ({ ...s, rects: { ...s.rects, [id]: r } })),
    }),
    [state, key, ids],
  );
  return api;
}

const STACK_BREAKPOINT = 768;

export function Workspace({ panels, api }: { panels: PanelDef[]; api: WorkspaceApi }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stacked = size !== null && size.w < STACK_BREAKPOINT;

  if (stacked) {
    return (
      <div ref={ref} className="workspace-canvas h-full overflow-y-auto">
        <div className="flex flex-col gap-3 p-3">
          {panels.map((p) => (
            <Card
              key={p.id}
              className="flex flex-col gap-0 overflow-hidden p-0"
              style={{ height: p.stackedHeight ?? 420 }}
            >
              <PanelHeader title={p.title} actions={p.actions} />
              <div className={`relative min-h-0 flex-1 ${p.flush ? "" : "overflow-hidden"}`}>{p.children}</div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="workspace-canvas relative h-full overflow-hidden">
      {size &&
        panels.map((p) => {
          if (api.state.minimized.includes(p.id)) return null;
          const maximized = api.state.maximized === p.id;
          const frac = api.state.rects[p.id] ?? areaToRect(p.area, size.w, size.h);
          const rect = maximized
            ? { x: GUTTER, y: GUTTER, w: size.w - 2 * GUTTER, h: size.h - 2 * GUTTER }
            : toPx(frac, size.w, size.h);
          const z = maximized ? 1000 : api.state.z.indexOf(p.id) + 1;
          const others = panels
            .filter((o) => o.id !== p.id && !api.state.minimized.includes(o.id))
            .map((o) => toPx(api.state.rects[o.id] ?? areaToRect(o.area, size.w, size.h), size.w, size.h));
          return (
            <FloatingPanel
              key={p.id}
              def={p}
              rect={rect}
              z={z}
              maximized={maximized}
              others={others}
              bounds={size}
              onFocus={() => api.focus(p.id)}
              onCommit={(r) => api.setRect(p.id, toFraction(r, size.w, size.h))}
              onMinimize={() => api.minimize(p.id)}
              onMaximize={() => api.toggleMaximize(p.id)}
            />
          );
        })}
      <Dock panels={panels} api={api} />
    </div>
  );
}

type Edges = { l: boolean; r: boolean; t: boolean; b: boolean };

function FloatingPanel(props: {
  def: PanelDef;
  rect: Rect;
  z: number;
  maximized: boolean;
  others: Rect[];
  bounds: { w: number; h: number };
  onFocus(): void;
  onCommit(r: Rect): void;
  onMinimize(): void;
  onMaximize(): void;
}) {
  const { def, rect, z, maximized, others, bounds } = props;
  const [live, setLive] = useState<Rect | null>(null);
  const drag = useRef<{ start: Rect; px: number; py: number; edges: Edges } | null>(null);
  const shown = live ?? rect;
  const minW = def.minWidth ?? 240;
  const minH = def.minHeight ?? 140;

  const begin = useCallback(
    (e: ReactPointerEvent, edges: Edges) => {
      if (maximized || e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { start: rect, px: e.clientX, py: e.clientY, edges };
      props.onFocus();
    },
    [rect, maximized, props.onFocus],
  );

  const move = useCallback(
    (e: ReactPointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      const moving = d.edges.l && d.edges.r && d.edges.t && d.edges.b;
      let next: Rect;
      if (moving) next = { ...d.start, x: d.start.x + dx, y: d.start.y + dy };
      else {
        next = { ...d.start };
        if (d.edges.l) {
          next.x = Math.min(d.start.x + dx, d.start.x + d.start.w - minW);
          next.w = d.start.w - (next.x - d.start.x);
        }
        if (d.edges.r) next.w = Math.max(minW, d.start.w + dx);
        if (d.edges.t) {
          next.y = Math.min(d.start.y + dy, d.start.y + d.start.h - minH);
          next.h = d.start.h - (next.y - d.start.y);
        }
        if (d.edges.b) next.h = Math.max(minH, d.start.h + dy);
      }
      const snapped = snap(next, others, bounds.w, bounds.h, d.edges);
      setLive(clampRect(snapped, bounds.w, bounds.h, minW, minH));
    },
    [others, bounds, minW, minH],
  );

  const end = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setLive((l) => {
      if (l) props.onCommit(l);
      return null;
    });
  }, [props.onCommit]);

  const all: Edges = { l: true, r: true, t: true, b: true };
  const onHeaderDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button,a,input,[role=button],[role=tab],[data-no-drag]")) return;
    begin(e, all);
  };

  return (
    <Card
      className="absolute flex flex-col gap-0 overflow-hidden p-0"
      style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h, zIndex: z }}
      onPointerDownCapture={props.onFocus}
    >
      <PanelHeader
        title={def.title}
        actions={def.actions}
        onPointerDown={onHeaderDown}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={props.onMaximize}
        controls={
          <>
            <IconButton label={maximized ? "Restore" : "Maximize"} onPress={props.onMaximize}>
              {maximized ? <ChevronsCollapseUpRight className="size-3.5" /> : <ArrowsExpand className="size-3.5" />}
            </IconButton>
            <IconButton label="Minimize" onPress={props.onMinimize}>
              <Minus className="size-3.5" />
            </IconButton>
          </>
        }
      />
      <div className={`relative min-h-0 flex-1 ${def.flush ? "" : "overflow-hidden"}`}>{def.children}</div>
      {!maximized && <ResizeHandles begin={begin} move={move} end={end} />}
    </Card>
  );
}

function PanelHeader(props: {
  title: string;
  actions?: ReactNode;
  controls?: ReactNode;
  onPointerDown?: (e: ReactPointerEvent) => void;
  onPointerMove?: (e: ReactPointerEvent) => void;
  onPointerUp?: () => void;
  onPointerCancel?: () => void;
  onDoubleClick?: () => void;
}) {
  const draggable = props.onPointerDown !== undefined;
  return (
    <div
      className={`flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-3.5 select-none ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button,[data-no-drag]")) return;
        props.onDoubleClick?.();
      }}
    >
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{props.title}</h2>
      {props.actions && (
        <div className="flex items-center gap-0.5" data-no-drag>
          {props.actions}
        </div>
      )}
      {props.controls && <div className="flex items-center gap-0.5 text-muted">{props.controls}</div>}
    </div>
  );
}

function ResizeHandles(props: {
  begin: (e: ReactPointerEvent, edges: Edges) => void;
  move: (e: ReactPointerEvent) => void;
  end: () => void;
}) {
  const h = (edges: Edges, style: React.CSSProperties, cursor: string) => (
    <div
      className="panel-resize"
      style={{ ...style, cursor }}
      onPointerDown={(e) => props.begin(e, edges)}
      onPointerMove={props.move}
      onPointerUp={props.end}
      onPointerCancel={props.end}
    />
  );
  const E = 6;
  const C = 14;
  const f = false;
  const t = true;
  return (
    <>
      {h({ l: f, r: t, t: f, b: f }, { top: C, bottom: C, right: 0, width: E }, "ew-resize")}
      {h({ l: t, r: f, t: f, b: f }, { top: C, bottom: C, left: 0, width: E }, "ew-resize")}
      {h({ l: f, r: f, t: f, b: t }, { left: C, right: C, bottom: 0, height: E }, "ns-resize")}
      {h({ l: f, r: f, t: t, b: f }, { left: C, right: C, top: 0, height: E / 2 }, "ns-resize")}
      {h({ l: f, r: t, t: f, b: t }, { right: 0, bottom: 0, width: C, height: C }, "nwse-resize")}
      {h({ l: t, r: f, t: f, b: t }, { left: 0, bottom: 0, width: C, height: C }, "nesw-resize")}
    </>
  );
}

function Dock({ panels, api }: { panels: PanelDef[]; api: WorkspaceApi }) {
  const hidden = panels.filter((p) => api.state.minimized.includes(p.id));
  if (hidden.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[1100] flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-overlay p-1 shadow-overlay">
        {hidden.map((p) => (
          <button
            key={p.id}
            type="button"
            className="h-8 cursor-[var(--cursor-interactive)] rounded-full px-3.5 text-sm text-foreground hover:bg-default"
            onClick={() => api.restore(p.id)}
          >
            {p.title}
          </button>
        ))}
      </div>
    </div>
  );
}
