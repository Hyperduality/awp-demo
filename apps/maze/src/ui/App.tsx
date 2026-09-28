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
import { ScanView } from "./ScanView.tsx";
import { WorldView } from "./WorldView.tsx";

const demo: DemoInfo = {
  id: "maze",
  name: "Maze",
  lead: "manual",
  summary:
    "A first-person maze in a streaming world: it runs in real time whether or not anyone acts. You drive with the keyboard; each key becomes a velocity setpoint on a command channel, and if the setpoints stop, the world's watchdogs stop the runner.",
  tryThis: [
    "Click the view and drive with W A S D, looking with the mouse; collect every core, then press F at the exit.",
    "Watch cmd.frame stream on the wire at 30 Hz while you drive, and stop when you let go.",
    "Enable the Autopilot, then take over mid-route; it replans from its own map when you hand back.",
    "Open Agent View to see the range scan the agent actually receives.",
  ],
};

export function App({ world, agent }: { world: InspectorClient; agent: InspectorClient }) {
  const panels = useMemo<PanelDef[]>(
    () => [
      {
        id: "world",
        title: "Runner",
        area: [0, 0, 7, 8],
        flush: true,
        stackedHeight: 420,
        minWidth: 360,
        minHeight: 260,
        actions: <WorldActions />,
        children: <WorldView />,
      },
      { id: "activity", title: "Activity", area: [7, 0, 5, 6], minWidth: 320, children: <ActivityPanel /> },
      {
        id: "observation",
        title: "Agent View",
        area: [7, 6, 2, 6],
        minWidth: 250,
        children: <ObservationPanel renderers={{ ranges: (p) => <ScanView payload={p} /> }} />,
      },
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
                    [["W", "S"], "Forward, back"],
                    [["A", "D"], "Strafe"],
                    [["Mouse"], "Look (click to lock, Esc to release)"],
                    [["←", "→"], "Turn"],
                    [["Shift"], "Run"],
                    [["F"], "Open the exit"],
                    [["M"], "Minimap"],
                  ]}
                />
              ),
            }}
          />
        ),
      },
      { id: "wire", title: "Wire", area: [3, 8, 4, 4], minWidth: 360, children: <WirePanel /> },
      { id: "session", title: "Session", area: [9, 6, 3, 6], minWidth: 260, children: <SessionPanel /> },
      { id: "about", title: "About", area: [3, 2, 5, 7], hidden: true, children: <AboutPanel /> },
    ],
    [],
  );
  return <DemoShell demo={demo} world={world} agent={agent} panels={panels} />;
}
