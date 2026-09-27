import type { InspectorClient } from "@awp-demo/inspector/client";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export interface DemoInfo {
  id: string;
  name: string;
  /** One or two sentences: what this demo shows. */
  summary: string;
  /** The controller the demo leads with. */
  lead: "manual" | "program" | "llm";
  /** Plain-language notes on what to try. */
  tryThis?: string[];
}

interface DemoContextValue {
  demo: DemoInfo;
  world: InspectorClient;
  agent: InspectorClient;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function DemoProvider(props: DemoContextValue & { children: ReactNode }) {
  const { demo, world, agent, children } = props;
  const value = useMemo(() => ({ demo, world, agent }), [demo, world, agent]);
  return (
    <DemoContext.Provider value={value}>
      <FocusProvider>{children}</FocusProvider>
    </DemoContext.Provider>
  );
}

export function useDemo(): DemoContextValue {
  const v = useContext(DemoContext);
  if (!v) throw new Error("useDemo outside DemoProvider");
  return v;
}

/** The action the pointer is over, highlighted across Activity and Wire. */
const FocusContext = createContext<{ actionId: string | null; setActionId: (id: string | null) => void }>({
  actionId: null,
  setActionId: () => {},
});

function FocusProvider({ children }: { children: ReactNode }) {
  const [actionId, setActionId] = useState<string | null>(null);
  const value = useMemo(() => ({ actionId, setActionId }), [actionId]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useFocusAction() {
  return useContext(FocusContext);
}
