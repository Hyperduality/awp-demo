import type { ReactNode } from "react";

/** A compact definition list: labels muted, values aligned and tabular. */
export function KeyValue({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="tnum min-w-0 truncate text-foreground">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-xs font-medium text-muted">{children}</div>;
}
