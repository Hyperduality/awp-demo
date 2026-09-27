import { type AgentStatus, AgentTopic, type WorldSessionView, type WorldState, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { useDemo } from "../context.tsx";
import { nsToSeconds, stateLabel, stateTone, TONE_CLASS } from "../format.ts";
import { KeyValue, SectionLabel } from "../primitives/KeyValue.tsx";

const LIFECYCLE = ["ready", "active", "suspended", "closed"] as const;

/** The session as the world holds it: state, clock, grants, channels, live actions. */
export function SessionPanel() {
  const { world, agent } = useDemo();
  const state = useTopic<WorldState>(world, WorldTopic.world);
  const status = useTopic<AgentStatus>(agent, AgentTopic.status);
  const sessions = state?.sessions ?? [];
  const s: WorldSessionView | undefined =
    sessions.find((x) => x.id === status?.sessionId) ?? sessions.find((x) => !x.observer) ?? sessions[0];

  if (!s) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">No session</div>;
  }
  const live = s.actions.filter(
    (a) => !["completed", "failed", "rejected", "cancelled", "preempted"].includes(a.state),
  );
  const recent = s.actions.slice(-6).reverse();
  return (
    <div className="h-full space-y-5 overflow-y-auto px-4 pb-4">
      <div className="flex items-center gap-1.5 text-xs">
        {LIFECYCLE.map((step, i) => (
          <span key={step} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-separator">—</span>}
            <span className={s.state === step ? "font-medium text-foreground" : "text-muted"}>{stateLabel(step)}</span>
          </span>
        ))}
        {s.inSafeState && <span className="ml-auto text-warning">Safe state</span>}
      </div>
      <KeyValue
        items={[
          [
            "Session",
            <span key="session" className="font-mono text-xs">
              {s.id}
            </span>,
          ],
          ["Mode", stateLabel(s.mode)],
          ["Clock", nsToSeconds(s.clockNs)],
          ...(s.mode === "lockstep"
            ? ([["Tick", state?.tick.toLocaleString()]] as [string, string | undefined][])
            : []),
          ["Status seq", s.statusSeq.toLocaleString()],
          ["Embodiments", s.embodiments.join(", ") || "Observer"],
          ...(s.mode === "streaming"
            ? ([["Round trip", status?.rttMs !== undefined ? `${status.rttMs.toFixed(2)} ms` : undefined]] as [
                string,
                string | undefined,
              ][])
            : []),
          ["Other sessions", sessions.length > 1 ? String(sessions.length - 1) : "None"],
        ]}
      />
      <section>
        <SectionLabel>Channels</SectionLabel>
        <table className="w-full text-sm">
          <tbody>
            {s.channels.map((c) => (
              <tr key={c.channelId} className="h-7">
                <td className="font-mono text-xs text-foreground">{c.channel}</td>
                <td className="text-xs text-muted">{c.command ? "command" : c.lossClass}</td>
                <td className="tnum text-right text-xs text-muted">
                  {c.rateHz === null ? "per tick" : `${c.rateHz} Hz`}
                </td>
                <td className="tnum w-20 text-right text-xs text-muted">#{c.seq.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <SectionLabel>{live.length > 0 ? `Actions · ${live.length} live` : "Actions"}</SectionLabel>
        {recent.length === 0 ? (
          <div className="text-sm text-muted">None yet</div>
        ) : (
          <ul className="space-y-1">
            {recent.map((a) => (
              <li key={a.id} className="flex items-baseline gap-2 text-xs">
                <span className="font-mono text-foreground">{a.type}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted">{a.id}</span>
                <span className={TONE_CLASS[stateTone(a.state)]}>{stateLabel(a.state)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
