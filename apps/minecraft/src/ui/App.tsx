import { type AgentStatus, AgentTopic } from "@awp-demo/inspector";
import type { InspectorClient } from "@awp-demo/inspector/client";
import { useTopic } from "@awp-demo/inspector/react";
import {
  AboutPanel,
  ActivityPanel,
  ControlPanel,
  type DemoInfo,
  DemoShell,
  Keymap,
  ObservationPanel,
  type PanelDef,
  SessionPanel,
  TimingPanel,
  WirePanel,
  WorldActions,
} from "@awp-demo/ui";
import { useMemo } from "react";
import { WorldView } from "./WorldView.tsx";

const demo: DemoInfo = {
  id: "minecraft",
  name: "Minecraft",
  lead: "manual",
  summary:
    "Minecraft as an AWP world, driven by device input: keys, buttons and mouse movement in 50 ms slots. The same world runs in lockstep, where it waits for every decision, and streaming, where it does not. A person, OpenAI's VPT, a vision model and a script take turns at the controls.",
  tryThis: [
    "Click the view and play. The overlay shows the device state the protocol delivered for the last tick.",
    "Switch the session between lockstep and streaming in Session: the same world, manifest and inputs serve both.",
    "Start the VPT policy server, then turn VPT on. In lockstep, pause the clock and step it a tick at a time; the world waits for each decision.",
    "In streaming, raise VPT's inference delay past 100 ms: its decisions arrive stale, the world refuses them, the keys release and the player stops.",
    "Give the LLM a key and a goal. It plays sensibly in lockstep; in streaming its decisions come back refused.",
  ],
};

export function App({ world, agent }: { world: InspectorClient; agent: InspectorClient }) {
  const status = useTopic<AgentStatus>(agent, AgentTopic.status);
  const streaming = status?.mode === "streaming";
  const panels = useMemo<PanelDef[]>(
    () => [
      {
        id: "world",
        title: "Minecraft",
        area: [0, 0, 7, 7],
        flush: true,
        stackedHeight: 420,
        actions: <WorldActions />,
        children: <WorldView />,
      },
      { id: "activity", title: "Activity", area: [7, 0, 5, 7], children: <ActivityPanel /> },
      {
        id: "control",
        title: "Control",
        area: [0, 7, 3, 5],
        children: (
          <ControlPanel
            extras={{
              manual: (
                <Keymap
                  items={[
                    [["Click"], "Capture the mouse"],
                    [["W", "A", "S", "D"], "Move"],
                    [["Space", "Shift", "Ctrl"], "Jump, sneak, sprint"],
                    [["LMB", "RMB"], "Attack or mine, use or place"],
                    [["1–9", "E"], "Hotbar, inventory"],
                    [["Esc"], "Let go"],
                  ]}
                />
              ),
            }}
          />
        ),
      },
      streaming
        ? { id: "timing", title: "Timing", area: [3, 7, 4, 5], children: <TimingPanel /> }
        : { id: "session", title: "Session", area: [3, 7, 4, 5], children: <SessionPanel /> },
      { id: "wire", title: "Wire", area: [7, 7, 5, 5], children: <WirePanel /> },
      ...(streaming ? [{ id: "session", title: "Session", modal: true, children: <SessionPanel /> }] : []),
      { id: "observation", title: "Agent View", modal: true, children: <ObservationPanel /> },
      { id: "about", title: "About", modal: true, children: <AboutPanel /> },
    ],
    [streaming],
  );
  return <DemoShell demo={demo} world={world} agent={agent} panels={panels} />;
}
