import { type AgentStatus, AgentTopic, type WireEntry, type WorldState, WorldTopic } from "@awp-demo/inspector";
import { useStream, useTopic } from "@awp-demo/inspector/react";
import { type ReactNode, useMemo, useState } from "react";
import { useDemo } from "../context.tsx";
import { decodePayload } from "../format.ts";
import { JsonView } from "../primitives/JsonView.tsx";
import { Segmented } from "../primitives/Segmented.tsx";

export type ChannelRenderers = Record<string, (payload: unknown) => ReactNode>;

/** What the agent perceives: the newest frame on each of its channels, decoded. */
export function ObservationPanel({ renderers = {} }: { renderers?: ChannelRenderers }) {
  const { world, agent } = useDemo();
  const wire = useStream<WireEntry>(world, WorldTopic.wire);
  const state = useTopic<WorldState>(world, WorldTopic.world);
  const status = useTopic<AgentStatus>(agent, AgentTopic.status);
  const session = state?.sessions.find((s) => s.id === status?.sessionId) ?? state?.sessions[0];
  const channels = (session?.channels ?? []).filter((c) => !c.command);
  const [picked, setPicked] = useState<string | null>(null);
  const current = channels.find((c) => c.channel === picked) ?? channels[0];

  const latest = useMemo(() => {
    if (!current || !session) return undefined;
    for (let i = wire.length - 1; i >= 0; i--) {
      const e = wire[i]!;
      const m = e.message as { method?: string; params?: { channel_id?: number; payload_b64?: string; seq?: number } };
      if (e.session === session.id && m.method === "obs.frame" && m.params?.channel_id === current.channelId) {
        return { payload: decodePayload(m.params.payload_b64), seq: m.params.seq };
      }
    }
    return undefined;
  }, [wire, current, session]);

  if (!current) return <div className="flex h-full items-center justify-center text-sm text-muted">No channels</div>;
  const render = renderers[current.channel];
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2">
        {channels.length > 1 && (
          <div className="min-w-0 max-w-full overflow-x-auto [scrollbar-width:none]">
            <Segmented
              label="Channel"
              value={current.channel}
              onChange={setPicked}
              options={channels.map((c) => ({ id: c.channel, label: c.channel }))}
            />
          </div>
        )}
        <span className="tnum ml-auto shrink-0 text-xs text-muted">
          {latest?.seq !== undefined ? `#${latest.seq.toLocaleString()}` : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3.5 pb-3">
        {latest === undefined ? (
          <div className="text-sm text-muted">Waiting for a frame</div>
        ) : render ? (
          render(latest.payload)
        ) : (
          <JsonView value={latest.payload} />
        )}
      </div>
    </div>
  );
}
