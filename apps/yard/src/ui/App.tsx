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
  TimingPanel,
  WirePanel,
  WorldActions,
} from "@awp-demo/ui";
import { useMemo } from "react";
import { OrdersPanel } from "./OrdersPanel.tsx";
import { SensorPanel } from "./SensorPanel.tsx";
import { WorldView } from "./WorldView.tsx";

const demo: DemoInfo = {
  id: "yard",
  name: "Yard",
  lead: "manual",
  summary:
    "A freight yard simulated as rigid bodies, and a forklift in it as an AWP embodiment. The truck has real suspension, a hoist that stalls at its limit and forks that go into a pallet's pockets; loads stay on only if they are carried well. What the agent knows of the yard is what the truck's camera and lidar have picked out, plus a site map: it has to go and look for the pallets it is asked to move. A person and a language model drive it through the same protocol, at two levels: pallet skills as actions, and speed and steering as setpoints on a command channel.",
  tryThis: [
    "Click the view and drive: W and S, A and D, R and F for the forks. Your keys go out as servo setpoints thirty times a second; the Wire panel shows them.",
    "Turn Sensors on. The dots are the lidar's returns and the frame is the camera's view; the Sensors panel counts what they pick out. Parked where it starts, the truck cannot see the receiving pad.",
    "Give the LLM a key and tell it to deliver the orders. It has not seen the ordered pallets, so it drives to look first. Or tell it where they are.",
    "Open Agent View and pick the scene channel: movable things are in it only while the sensors see them.",
    "Ask for the concrete block in the middle of the yard. The hoist stalls at 25 kN: the action fails with reason x-yard.overload, and the truck does not tip.",
    "Drive fast with the forks high and turn hard. The truck narrows its own steering with speed; ask for more than 3 m/s and the world drops the setpoint and counts it.",
  ],
};

export function App({ world, agent }: { world: InspectorClient; agent: InspectorClient }) {
  const panels = useMemo<PanelDef[]>(
    () => [
      {
        id: "world",
        title: "Yard",
        area: [0, 0, 8, 8],
        flush: true,
        stackedHeight: 460,
        actions: <WorldActions />,
        children: <WorldView />,
      },
      { id: "activity", title: "Activity", area: [8, 0, 4, 8], children: <ActivityPanel /> },
      {
        id: "control",
        title: "Control",
        area: [0, 8, 3, 4],
        children: (
          <ControlPanel
            extras={{
              manual: (
                <Keymap
                  items={[
                    [["Click"], "Take the controls"],
                    [["W", "S"], "Forward, reverse"],
                    [["A", "D"], "Steer"],
                    [["R", "F"], "Forks up, down"],
                    [["T", "G"], "Tilt back, forward"],
                    [["Esc"], "Let go"],
                  ]}
                />
              ),
            }}
          />
        ),
      },
      { id: "orders", title: "Orders", area: [3, 8, 3, 4], children: <OrdersPanel /> },
      { id: "sensors", title: "Sensors", area: [6, 8, 3, 4], flush: true, children: <SensorPanel /> },
      { id: "timing", title: "Timing", area: [9, 8, 3, 4], children: <TimingPanel /> },
      { id: "wire", title: "Wire", modal: true, children: <WirePanel /> },
      { id: "session", title: "Session", modal: true, children: <SessionPanel /> },
      { id: "observation", title: "Agent View", modal: true, children: <ObservationPanel /> },
      { id: "about", title: "About", modal: true, children: <AboutPanel /> },
    ],
    [],
  );
  return <DemoShell demo={demo} world={world} agent={agent} panels={panels} />;
}
