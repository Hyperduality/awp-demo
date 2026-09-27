import type { InspectorClient } from "@awp-demo/inspector/client";
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
  WirePanel,
  WorldActions,
} from "@awp-demo/ui";
import { useMemo } from "react";
import { WorldView } from "./WorldView.tsx";

const demo: DemoInfo = {
  id: "vault",
  name: "Vault",
  lead: "llm",
  summary:
    "A language model explores a dark vault: it sees three tiles around it, finds keys, opens doors, takes the gem, and leaves. The world is lockstep, so it stays perfectly still while the model thinks, and every tool call is an AWP action you can follow on the wire.",
  tryThis: [
    "Add an API key to the LLM and send a message, or leave the box empty and send to start the task.",
    "Switch the world view between Agent View and Truth to see what the model does not know.",
    "Step in manually mid-run with the arrow keys; the model sees what you did in its next tool result.",
    "Enable the Planner to compare a scripted explorer with the model on the same vault.",
  ],
};

export function App({ world, agent }: { world: InspectorClient; agent: InspectorClient }) {
  const panels = useMemo<PanelDef[]>(
    () => [
      {
        id: "world",
        title: "Vault",
        area: [0, 0, 6, 8],
        flush: true,
        stackedHeight: 420,
        minWidth: 360,
        minHeight: 280,
        actions: <WorldActions />,
        children: <WorldView />,
      },
      { id: "activity", title: "Activity", area: [6, 0, 6, 8], minWidth: 340, children: <ActivityPanel /> },
      {
        id: "control",
        title: "Control",
        area: [0, 8, 3, 4],
        minWidth: 280,
        children: (
          <ControlPanel
            extras={{
              manual: (
                <Keymap
                  items={[
                    [["Click"], "Walk to a seen tile"],
                    [["←", "→", "↑", "↓"], "Step"],
                    [["E"], "Use the tile ahead"],
                    [["Space"], "Pick up"],
                  ]}
                />
              ),
            }}
          />
        ),
      },
      { id: "wire", title: "Wire", area: [3, 8, 6, 4], minWidth: 360, children: <WirePanel /> },
      { id: "session", title: "Session", area: [9, 8, 3, 4], minWidth: 260, children: <SessionPanel /> },
      { id: "observation", title: "Agent View", area: [6, 2, 4, 6], hidden: true, children: <ObservationPanel /> },
      { id: "about", title: "About", area: [3, 2, 5, 7], hidden: true, children: <AboutPanel /> },
    ],
    [],
  );
  return <DemoShell demo={demo} world={world} agent={agent} panels={panels} />;
}
