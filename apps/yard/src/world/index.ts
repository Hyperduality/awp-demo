import { serveWorld } from "@awp-demo/world";
import { PORTS } from "../shared/yard.ts";
import { yard } from "./definition.ts";
import type { YardSim } from "./sim.ts";

await serveWorld(yard, {
  port: Number(process.env.AWP_PORT ?? PORTS.world),
  token: process.env.AWP_TOKEN ?? "awp-demo-local-token",
  inspectorPort: Number(process.env.INSPECTOR_PORT ?? PORTS.worldInspector),
  auditDir: process.env.AWP_AUDIT_DIR ?? "awp-audit",
  operatorSignals: true,
  viewHz: 60,
  topics: [{ name: "sensors", hz: 5, read: (sim) => (sim as YardSim).sensorsView() }],
});
