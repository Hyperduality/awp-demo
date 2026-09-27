import { InspectorClient } from "@awp-demo/inspector/client";
import { applyTheme } from "@awp-demo/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

applyTheme();
const origin = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const world = new InspectorClient(`${origin}/_world`);
const agent = new InspectorClient(`${origin}/_agent`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App world={world} agent={agent} />
  </StrictMode>,
);
