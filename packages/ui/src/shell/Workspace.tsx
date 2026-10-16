import { Card } from "@heroui/react";
import type { CSSProperties, ReactNode } from "react";

/** A panel's placement on the 12×12 workspace grid: [column, row, columns, rows]. */
export type Area = [number, number, number, number];

export interface PanelDef {
  id: string;
  title: string;
  /** Place on the 12×12 grid; required unless `modal`. */
  area?: Area;
  /** Header actions, right-aligned. */
  actions?: ReactNode;
  /** Content fills the panel edge to edge (e.g. a world view). */
  flush?: boolean;
  /** Height when stacked on small screens. */
  stackedHeight?: number;
  /** Opened as a dialog from the top bar instead of taking a place on the grid. */
  modal?: boolean;
  children: ReactNode;
}

/** The fixed grid of panels; below `md` the panels stack in one scrolling column. */
export function Workspace({ panels }: { panels: PanelDef[] }) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-background p-3 md:grid md:grid-cols-12 md:grid-rows-12 md:overflow-hidden">
      {panels
        .filter((p) => !p.modal && p.area)
        .map((p) => {
          const [c, r, cs, rs] = p.area!;
          const style = {
            "--panel-col": `${c + 1} / span ${cs}`,
            "--panel-row": `${r + 1} / span ${rs}`,
            "--panel-h": `${p.stackedHeight ?? 420}px`,
          } as CSSProperties;
          return (
            <Card
              key={p.id}
              className="flex h-[var(--panel-h)] shrink-0 flex-col gap-0 overflow-hidden p-0 md:h-auto md:[grid-column:var(--panel-col)] md:[grid-row:var(--panel-row)]"
              style={style}
            >
              <PanelHeader title={p.title} actions={p.actions} />
              <div className={`relative min-h-0 flex-1 ${p.flush ? "" : "overflow-hidden"}`}>{p.children}</div>
            </Card>
          );
        })}
    </div>
  );
}

/** A panel's title row; the same in the grid and in a dialog, so contents line up either way. */
export function PanelHeader(props: { title: string; actions?: ReactNode; heading?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-3.5">
      {props.heading ?? <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{props.title}</h2>}
      {props.actions && <div className="flex items-center gap-0.5">{props.actions}</div>}
    </div>
  );
}
