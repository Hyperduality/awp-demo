import { WorldCommand } from "@awp-demo/inspector";
import type { InspectorClient } from "@awp-demo/inspector/client";
import {
  AboutPanel,
  ActivityPanel,
  ControlPanel,
  type DemoInfo,
  DemoShell,
  IconButton,
  Keymap,
  ObservationPanel,
  type PanelDef,
  SessionPanel,
  WirePanel,
  WorldActions,
} from "@awp-demo/ui";
import { ArrowRight } from "@gravity-ui/icons";
import { useMemo } from "react";
import { WorldView } from "./WorldView.tsx";

const demo: DemoInfo = {
  id: "sorter",
  name: "Sorter",
  lead: "program",
  summary:
    "A two-link arm and a gripper sort parcels off a conveyor into bins by colour. The world is lockstep: it advances only when the agent calls world.tick, so a program can run at any speed and a language model can think without the belt moving.",
  tryThis: [
    "Watch the program intercept parcels, then click in the cell: manual control takes over and the program's action is cancelled.",
    "Stop clicking; after a moment control returns to the program, which replans from what it sees.",
    "Add an API key to the LLM and ask it to sort only blue parcels.",
    "Pause time, then step one tick at a time and read each advance on the wire.",
  ],
};

export function App({ world, agent }: { world: InspectorClient; agent: InspectorClient }) {
  const panels = useMemo<PanelDef[]>(
    () => [
      {
        id: "world",
        title: "Cell",
        area: [0, 0, 7, 7],
        flush: true,
        stackedHeight: 380,
        minWidth: 360,
        minHeight: 240,
        actions: (
          <>
            <IconButton label="Nudge a parcel" onPress={() => world.command(WorldCommand.operator, { name: "nudge" })}>
              <ArrowRight className="size-3.5" />
            </IconButton>
            <WorldActions />
          </>
        ),
        children: <WorldView />,
      },
      { id: "activity", title: "Activity", area: [7, 0, 5, 7], minWidth: 320, children: <ActivityPanel /> },
      {
        id: "control",
        title: "Control",
        area: [0, 7, 3, 5],
        minWidth: 280,
        children: (
          <ControlPanel
            extras={{
              manual: (
                <Keymap
                  items={[
                    [["Click"], "Move the arm there"],
                    [["←", "→", "↑", "↓"], "Jog 2 cm (Shift for 8)"],
                    [["G"], "Grip"],
                    [["R"], "Release"],
                    [["S"], "Stop"],
                  ]}
                />
              ),
            }}
          />
        ),
      },
      { id: "wire", title: "Wire", area: [3, 7, 6, 5], minWidth: 360, children: <WirePanel /> },
      { id: "session", title: "Session", area: [9, 7, 3, 5], minWidth: 260, children: <SessionPanel /> },
      { id: "observation", title: "Agent View", area: [7, 3, 5, 5], hidden: true, children: <ObservationPanel /> },
      { id: "about", title: "About", area: [3, 2, 5, 7], hidden: true, children: <AboutPanel /> },
    ],
    [world],
  );
  return <DemoShell demo={demo} world={world} agent={agent} panels={panels} />;
}
