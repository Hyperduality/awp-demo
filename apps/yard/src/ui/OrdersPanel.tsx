import { WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { useDemo } from "@awp-demo/ui";
import type { YardView } from "../shared/yard.ts";

const STATUS: Record<string, string> = { waiting: "Waiting", carried: "On the forks", delivered: "Delivered" };
const PHASE: Record<string, string> = { working: "In progress", done: "All delivered", failed: "Truck tipped" };

/** The work the yard has set, and what has happened lately: the `task` channel, as the agent gets it. */
export function OrdersPanel() {
  const { world } = useDemo();
  const task = useTopic<YardView>(world, WorldTopic.view)?.task;
  if (!task) return <div className="flex h-full items-center justify-center text-sm text-muted">No world yet</div>;
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-3 pb-3 text-sm">
      <div className="flex items-baseline justify-between">
        <span
          className={task.phase === "failed" ? "text-danger" : task.phase === "done" ? "text-success" : "text-muted"}
        >
          {PHASE[task.phase]}
        </span>
        <span className="font-mono tabular-nums">
          {task.score} pts · {Math.floor(task.elapsed_s / 60)}:
          {String(Math.floor(task.elapsed_s % 60)).padStart(2, "0")}
        </span>
      </div>
      {task.orders.length === 0 ? (
        <div className="text-muted">This yard has no orders.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {task.orders.map((o) => (
            <li key={o.pallet} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate">{o.pallet_label}</div>
                <div className="text-muted text-xs">to {o.bay_label}</div>
              </div>
              <div
                className={`shrink-0 text-right text-xs ${o.status === "delivered" ? "text-success" : o.status === "carried" ? "text-accent" : "text-muted"}`}
              >
                {STATUS[o.status]}
                {o.intact < 1 && <div className="text-warning">{Math.round(o.intact * 100)}% of load</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {task.log.length > 0 && (
        <ul className="flex flex-col gap-1 border-border border-t pt-2 text-muted text-xs">
          {task.log
            .slice(-6)
            .reverse()
            .map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: log lines repeat and have no identity
              <li key={i}>{line}</li>
            ))}
        </ul>
      )}
    </div>
  );
}
