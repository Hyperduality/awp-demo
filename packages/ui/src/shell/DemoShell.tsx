import type { InspectorClient } from "@awp-demo/inspector/client";
import { type DemoInfo, DemoProvider } from "../context.tsx";
import { TopBar } from "./TopBar.tsx";
import { type PanelDef, useWorkspace, Workspace } from "./Workspace.tsx";

/** The frame every demo shares: a top bar and a workspace of floating panels. */
export function DemoShell(props: {
  demo: DemoInfo;
  world: InspectorClient;
  agent: InspectorClient;
  panels: PanelDef[];
}) {
  return (
    <DemoProvider demo={props.demo} world={props.world} agent={props.agent}>
      <Frame demoId={props.demo.id} panels={props.panels} />
    </DemoProvider>
  );
}

function Frame({ demoId, panels }: { demoId: string; panels: PanelDef[] }) {
  const api = useWorkspace(demoId, panels);
  return (
    <div className="flex h-full flex-col bg-background">
      <TopBar panels={panels} api={api} />
      <main className="min-h-0 flex-1">
        <Workspace panels={panels} api={api} />
      </main>
    </div>
  );
}
