import { Fragment, memo, type ReactNode } from "react";

/** Syntax-highlighted JSON, cheap enough for a live inspector. */
export const JsonView = memo(function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={`whitespace-pre-wrap break-all font-mono text-xs leading-5 ${className ?? ""}`}>
      {render(value, 0)}
    </pre>
  );
});

function render(v: unknown, depth: number): ReactNode {
  const pad = "  ".repeat(depth);
  if (v === null) return <span className="text-muted">null</span>;
  if (typeof v === "string") return <span className="text-success">{JSON.stringify(v)}</span>;
  if (typeof v === "number") return <span className="text-accent">{String(v)}</span>;
  if (typeof v === "boolean") return <span className="text-warning">{String(v)}</span>;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => typeof x === "number") && v.length <= 16) {
      return (
        <>
          [
          {v.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static rendering; positions are the identity
            <Fragment key={i}>
              {i > 0 ? ", " : ""}
              <span className="text-accent">{String(x)}</span>
            </Fragment>
          ))}
          ]
        </>
      );
    }
    return (
      <>
        {"[\n"}
        {v.map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static rendering; positions are the identity
          <Fragment key={i}>
            {pad}
            {"  "}
            {render(x, depth + 1)}
            {i < v.length - 1 ? ",\n" : "\n"}
          </Fragment>
        ))}
        {pad}]
      </>
    );
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return (
      <>
        {"{\n"}
        {entries.map(([k, x], i) => (
          <Fragment key={k}>
            {pad}
            {"  "}
            <span className="text-foreground">{JSON.stringify(k)}</span>
            <span className="text-muted">: </span>
            {render(x, depth + 1)}
            {i < entries.length - 1 ? ",\n" : "\n"}
          </Fragment>
        ))}
        {pad}
        {"}"}
      </>
    );
  }
  return String(v);
}
