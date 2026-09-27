import { AgentTopic, type ControllerState, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { Tabs } from "@heroui/react";
import type { WorldManifest } from "@hyperduality/awp";
import { useState } from "react";
import { useDemo } from "../context.tsx";
import { JsonView } from "../primitives/JsonView.tsx";
import { SectionLabel } from "../primitives/KeyValue.tsx";

/** What this demo is, what the world offers, and how the agent drives it. */
export function AboutPanel() {
  const { demo, world, agent } = useDemo();
  const manifest = useTopic<WorldManifest>(world, WorldTopic.manifest);
  const controllers = useTopic<ControllerState[]>(agent, AgentTopic.controllers) ?? [];
  const [raw, setRaw] = useState(false);
  return (
    <Tabs className="flex h-full flex-col px-3 pb-3">
      <Tabs.ListContainer>
        <Tabs.List aria-label="About">
          <Tabs.Tab id="demo">
            Demo
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="world">
            World
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="agent">
            Agent
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id="demo" className="min-h-0 flex-1 overflow-y-auto px-1 pt-4">
        <p className="text-sm text-foreground">{demo.summary}</p>
        {demo.tryThis && (
          <section className="mt-5">
            <SectionLabel>Try This</SectionLabel>
            <ul className="space-y-1.5 text-sm text-foreground">
              {demo.tryThis.map((t) => (
                <li key={t} className="flex gap-2">
                  <span className="text-muted">–</span>
                  {t}
                </li>
              ))}
            </ul>
          </section>
        )}
      </Tabs.Panel>
      <Tabs.Panel id="world" className="min-h-0 flex-1 overflow-y-auto px-1 pt-4">
        {!manifest ? (
          <div className="text-sm text-muted">Waiting for the world</div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-foreground">
                {manifest.world.name} <span className="text-muted">{manifest.world.version}</span>
              </span>
              <button
                type="button"
                className="cursor-[var(--cursor-interactive)] text-xs text-muted hover:text-foreground"
                onClick={() => setRaw(!raw)}
              >
                {raw ? "Summary" : "Raw manifest"}
              </button>
            </div>
            {raw ? (
              <JsonView value={manifest} />
            ) : (
              <>
                <section>
                  <SectionLabel>Embodiments</SectionLabel>
                  {manifest.embodiments.map((e) => (
                    <div key={e.id} className="flex items-baseline gap-2 text-sm">
                      <span className="font-mono text-xs text-foreground">{e.id}</span>
                      <span className="text-muted">{e.kind}</span>
                      {e.multi_bind_group && <span className="text-xs text-muted">group {e.multi_bind_group}</span>}
                    </div>
                  ))}
                </section>
                <section>
                  <SectionLabel>Actions</SectionLabel>
                  <table className="w-full text-xs">
                    <tbody>
                      {manifest.action_schemas.map((a) => (
                        <tr key={a.type} className="h-6 align-baseline">
                          <td className="font-mono text-foreground">{a.type}</td>
                          <td className="text-muted">{a.duration}</td>
                          <td className="text-right text-muted">
                            {(Array.isArray(a.preemption) ? a.preemption : [a.preemption]).join(", ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section>
                  <SectionLabel>Channels</SectionLabel>
                  <table className="w-full text-xs">
                    <tbody>
                      {[...manifest.observation_channels, ...(manifest.command_channels ?? [])].map((c) => (
                        <tr key={c.id} className="h-6 align-baseline">
                          <td className="font-mono text-foreground">{c.id}</td>
                          <td className="text-muted">{c.modality}</td>
                          <td className="tnum text-right text-muted">
                            {c.rate_hz === null ? "per tick" : `${c.rate_hz} Hz`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section>
                  <SectionLabel>Time</SectionLabel>
                  <div className="text-sm text-foreground">
                    {manifest.time_models.join(", ")}
                    {manifest.safety_policy.safe_state && (
                      <span className="text-muted">
                        {" "}
                        · {manifest.safety_policy.safe_state.behavior.replace("_", " ")} after{" "}
                        {manifest.safety_policy.safe_state.watchdog_ms} ms of silence
                      </span>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </Tabs.Panel>
      <Tabs.Panel id="agent" className="min-h-0 flex-1 overflow-y-auto px-1 pt-4">
        <div className="space-y-4">
          <p className="text-sm text-foreground">
            One AWP session. Controllers share it; the highest-priority engaged controller holds control, and a handoff
            cancels what the previous one was doing.
          </p>
          {controllers.map((c) => (
            <div key={c.id}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-foreground">{c.label}</span>
                <span className="tnum text-xs text-muted">Priority {c.priority}</span>
              </div>
              <p className="text-sm text-muted">{c.description}</p>
            </div>
          ))}
        </div>
      </Tabs.Panel>
    </Tabs>
  );
}
