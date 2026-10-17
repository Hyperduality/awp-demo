import {
  type ActivityEntry,
  type AgentStatus,
  AgentTopic,
  type ControllerState,
  type LatencyView,
  type WorldState,
  WorldTopic,
} from "@awp-demo/inspector";
import { useStream, useTopic } from "@awp-demo/inspector/react";
import type { WorldManifest } from "@hyperduality/awp";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDemo } from "../context.tsx";
import { KeyValue, SectionLabel } from "../primitives/KeyValue.tsx";

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const pair = (l: LatencyView | undefined) => (l ? `${seconds(l.p50 / 1e6)} / ${seconds(l.p95 / 1e6)}` : undefined);

interface Decision {
  id: string;
  source: string;
  what: string;
  ageMs: number;
  stale: boolean;
  state: string | undefined;
}

/**
 * Time in a streaming session: how long the agent has been silent against the world's watchdog,
 * how old the view behind each decision was when it left, and the world's latency telemetry.
 */
export function TimingPanel() {
  const { world, agent } = useDemo();
  const status = useTopic<AgentStatus>(agent, AgentTopic.status);
  const state = useTopic<WorldState>(world, WorldTopic.world);
  const manifest = useTopic<WorldManifest>(world, WorldTopic.manifest);
  const controllers = useTopic<ControllerState[]>(agent, AgentTopic.controllers) ?? [];
  const activity = useStream<ActivityEntry>(agent, AgentTopic.activity);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const watchdogMs = manifest?.safety_policy.safe_state?.watchdog_ms;
  const limitMs = manifest?.safety_policy.max_basis_age_ms;
  const session = state?.sessions.find((s) => s.id === status?.sessionId);
  const labels = new Map(controllers.map((c) => [c.id, c.label]));

  const decisions = useMemo(() => {
    const out: Decision[] = [];
    for (let i = activity.length - 1; i >= 0 && out.length < 10; i--) {
      const e = activity[i]!;
      const d = e.data as { basisAgeMs?: number; reason?: string } | undefined;
      if (e.kind !== "action" || typeof d?.basisAgeMs !== "number") continue;
      out.push({
        id: e.id,
        source: e.source,
        what: [e.title, e.detail].filter(Boolean).join(" · "),
        ageMs: d.basisAgeMs,
        stale: e.state === "rejected" && /stale/i.test(d.reason ?? ""),
        state: e.state,
      });
    }
    return out;
  }, [activity]);
  // A window without a submission carries no admission or decision figures; keep the last ones seen.
  const last = useRef<Record<string, LatencyView>>({});
  for (const [k, v] of Object.entries(status?.telemetry ?? {}))
    if (v && typeof v === "object" && "p50" in v) last.current[k] = v as LatencyView;
  const t = last.current;
  const scale = Math.max(limitMs ? limitMs * 1.2 : 1000, ...decisions.map((d) => d.ageMs));

  if (status?.mode !== "streaming")
    return <div className="flex h-full items-center justify-center text-sm text-muted">Streaming sessions only</div>;
  const silentMs = status.heartbeatAt !== undefined ? Math.max(0, now - status.heartbeatAt) : undefined;
  const share = silentMs !== undefined && watchdogMs ? Math.min(1, silentMs / watchdogMs) : 0;

  return (
    <div className="h-full space-y-5 overflow-y-auto px-4 pb-4">
      {watchdogMs !== undefined && (
        <section>
          <SectionLabel>Watchdog</SectionLabel>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-secondary">
            <div
              className={`h-full rounded-full ${share > 0.75 ? "bg-danger" : share > 0.4 ? "bg-warning" : "bg-accent"}`}
              style={{ width: `${share * 100}%` }}
            />
          </div>
          <div className="tnum mt-1.5 flex items-baseline justify-between text-xs">
            <span className="text-foreground">
              {silentMs === undefined ? "No heartbeat yet" : `Last heartbeat ${seconds(silentMs)} ago`}
            </span>
            <span className="text-muted">of {seconds(watchdogMs)}</span>
          </div>
          <p className={`mt-1 text-xs ${session?.inSafeState ? "text-warning" : "text-muted"}`}>
            {session?.inSafeState
              ? "Safe state: everything holds until a new action begins."
              : status.heartbeat === "intent"
                ? "The agent pings only while the controller in control shows life."
                : "The agent pings on a timer."}
          </p>
        </section>
      )}
      <section>
        <SectionLabel>Age of the View Behind Each Decision</SectionLabel>
        {decisions.length === 0 ? (
          <div className="text-sm text-muted">No decisions yet</div>
        ) : (
          <ul className="space-y-2">
            {decisions.map((d) => (
              <li
                key={d.id}
                title={`${labels.get(d.source) ?? d.source}: ${d.what}, on a view ${seconds(d.ageMs)} old`}
              >
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="w-12 shrink-0 truncate text-muted">{labels.get(d.source) ?? d.source}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{d.what}</span>
                  <span className="tnum shrink-0 text-foreground">{seconds(d.ageMs)}</span>
                  {d.stale && <span className="shrink-0 text-danger">Stale</span>}
                </div>
                <div className="relative mt-1 ml-14 h-1.5">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-r ${d.stale ? "bg-danger" : "bg-muted"}`}
                    style={{ width: `max(2px, ${(d.ageMs / scale) * 100}%)` }}
                  />
                  {limitMs !== undefined && (
                    <div
                      className="absolute -inset-y-1 w-px bg-foreground/40"
                      style={{ left: `${(limitMs / scale) * 100}%` }}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {limitMs !== undefined && (
          <p className="mt-2 text-xs text-muted">The line is the world's limit: {seconds(limitMs)}.</p>
        )}
      </section>
      <section>
        <SectionLabel>Latency, p50 / p95</SectionLabel>
        <KeyValue
          items={[
            ["Observation", pair(t?.observation_latency_ns)],
            ["Admission", pair(t?.admission_latency_ns)],
            ["Observation to action", pair(t?.observation_to_action_ns)],
            ["Round trip", status.rttMs !== undefined ? seconds(status.rttMs) : undefined],
          ]}
        />
      </section>
    </div>
  );
}
