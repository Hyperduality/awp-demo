import { WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { SectionLabel, useDemo } from "@awp-demo/ui";
import { type DispatchView, KIND_NOUN, KINDS } from "../shared/city.ts";

const STATUS: Record<string, string> = { en_route: "en route", on_scene: "on scene", staging: "staging" };

/**
 * Open calls as the callers put them, with who is on the way, and what each call truly needs:
 * the agent never sees that last line, which is what to judge its triage by.
 */
export function CallsPanel() {
  const { world } = useDemo();
  const view = useTopic<DispatchView>(world, WorldTopic.view);
  if (!view) return <div className="flex h-full items-center justify-center text-sm text-muted">No world</div>;
  const calls = [...view.calls].sort((a, b) => a.id - b.id);
  return (
    <div className="h-full space-y-4 overflow-y-auto px-4 pb-4">
      {calls.length === 0 ? (
        <div className="pt-2 text-sm text-muted">
          {view.shift.phase === "waiting" ? "Calls arrive once the shift starts." : "No open calls."}
        </div>
      ) : (
        <ul className="space-y-3">
          {calls.map((c) => {
            const left = Math.max(0, c.window_s - c.age_s);
            const sent = view.units.filter((u) => u.call === c.id);
            const needs = KINDS.filter((k) => c.needs[k])
              .map((k) => `${KIND_NOUN[k]}${(c.needs[k] ?? 0) > 1 ? ` ×${c.needs[k]}` : ""}`)
              .join(", ");
            return (
              <li key={c.id} className="text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-foreground">#{c.id}</span>
                  <span className="text-xs text-muted">{c.at}</span>
                  <span className={`tnum ml-auto text-xs ${left < c.window_s * 0.3 ? "text-danger" : "text-muted"}`}>
                    {Math.ceil(left)} s left
                  </span>
                </div>
                <p className="mt-0.5 text-foreground">{c.text}</p>
                {c.updates.map((u) => (
                  <p key={u} className="mt-0.5 text-xs text-muted">
                    {u}
                  </p>
                ))}
                <p className="mt-1 text-xs text-muted">
                  {sent.length > 0
                    ? sent.map((u) => `${u.label} ${STATUS[u.status] ?? u.status}`).join(" · ")
                    : "Nobody sent"}
                </p>
                <p className="mt-0.5 text-xs text-muted">Truly needs {needs}</p>
              </li>
            );
          })}
        </ul>
      )}
      {view.closed.length > 0 && (
        <section>
          <SectionLabel>Just Closed</SectionLabel>
          <ul className="space-y-1">
            {view.closed.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2 text-xs">
                <span className="text-foreground">#{c.id}</span>
                <span className={c.outcome === "resolved" ? "text-success" : "text-danger"}>
                  {c.outcome === "resolved" ? "Resolved" : "Lost"}
                </span>
                <span className="tnum ml-auto text-muted">
                  {c.points > 0 ? "+" : ""}
                  {c.points}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
