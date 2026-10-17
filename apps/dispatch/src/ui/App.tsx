import { WorldCommand, WorldTopic } from "@awp-demo/inspector";
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
  useDemo,
  WirePanel,
  WorldActions,
} from "@awp-demo/ui";
import { Button } from "@heroui/react";
import { useMemo } from "react";
import type { DispatchView } from "../shared/city.ts";
import { CallsPanel } from "./CallsPanel.tsx";
import { WorldView } from "./WorldView.tsx";

const demo: DemoInfo = {
  id: "dispatch",
  name: "Dispatch",
  lead: "llm",
  summary:
    "A language model runs a city's emergency dispatch desk. Calls arrive as what the caller said, and the model judges what each needs and sends units. The world is streaming: the city keeps moving while the model thinks, the world refuses a decision built on a view more than 10 s old, and if the model goes quiet for 8 s the units stop where they are.",
  tryThis: [
    "Add an API key to the LLM, send an empty message to put it on duty, then start the shift.",
    "Watch Timing: each bar is how old the model's view was when its decision left. Try a slower model, or set Extra Thinking to 12 s and watch decisions come back stale.",
    "Set Stall to 10 s: the model goes quiet past the watchdog, and the world puts every unit in safe state until it acts again.",
    "Take a unit yourself: click it, then a call. The model hears what you did and carries on with the rest.",
    "Reset the world, turn the LLM off and the Rules on, and run the same shift: same seed, same calls. Compare the scores.",
  ],
};

/** Starts the shift while it waits. */
function ShiftButton() {
  const { world } = useDemo();
  const view = useTopic<DispatchView>(world, WorldTopic.view);
  if (view?.shift.phase !== "waiting") return null;
  return (
    <Button size="sm" variant="primary" onPress={() => world.command(WorldCommand.operator, { name: "start" })}>
      Start Shift
    </Button>
  );
}

export function App({ world, agent }: { world: InspectorClient; agent: InspectorClient }) {
  const panels = useMemo<PanelDef[]>(
    () => [
      {
        id: "world",
        title: "City",
        area: [0, 0, 7, 7],
        flush: true,
        stackedHeight: 440,
        actions: (
          <>
            <ShiftButton />
            <WorldActions />
          </>
        ),
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
                    [["Click", "1–6"], "Pick a unit"],
                    [["Click"], "Then a call to send it, or a crossing to stage it"],
                    [["C"], "Cancel the picked unit's job"],
                    [["Esc"], "Drop the pick"],
                  ]}
                />
              ),
            }}
          />
        ),
      },
      { id: "calls", title: "Calls", area: [3, 7, 3, 5], children: <CallsPanel /> },
      { id: "timing", title: "Timing", area: [6, 7, 3, 5], children: <TimingPanel /> },
      { id: "wire", title: "Wire", area: [9, 7, 3, 5], children: <WirePanel /> },
      { id: "session", title: "Session", modal: true, children: <SessionPanel /> },
      { id: "observation", title: "Agent View", modal: true, children: <ObservationPanel /> },
      { id: "about", title: "About", modal: true, children: <AboutPanel /> },
    ],
    [],
  );
  return <DemoShell demo={demo} world={world} agent={agent} panels={panels} />;
}
