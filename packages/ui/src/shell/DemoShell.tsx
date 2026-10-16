import type { InspectorClient } from "@awp-demo/inspector/client";
import { type DemoInfo, DemoProvider } from "../context.tsx";
import { TopBar } from "./TopBar.tsx";
import { type PanelDef, Workspace } from "./Workspace.tsx";

/** The frame every demo shares: a top bar and a fixed grid of panels. */
export function DemoShell(props: {
  demo: DemoInfo;
  world: InspectorClient;
  agent: InspectorClient;
  panels: PanelDef[];
}) {
  return (
    <DemoProvider demo={props.demo} world={props.world} agent={props.agent}>
      <div className="flex h-full flex-col bg-background">
        <TopBar panels={props.panels.filter((p) => p.modal)} />
        <main className="min-h-0 flex-1">
          <Workspace panels={props.panels} />
        </main>
      </div>
    </DemoProvider>
  );
}
