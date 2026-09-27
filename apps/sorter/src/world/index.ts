import { serveWorld } from "@awp-demo/world";
import { PORTS } from "../shared/cell.ts";
import { sorter } from "./definition.ts";

await serveWorld(sorter, {
  port: Number(process.env.AWP_PORT ?? PORTS.world),
  token: process.env.AWP_TOKEN ?? "awp-demo-local-token",
  inspectorPort: Number(process.env.INSPECTOR_PORT ?? PORTS.worldInspector),
  auditDir: process.env.AWP_AUDIT_DIR ?? "awp-audit",
  operatorSignals: true,
});
