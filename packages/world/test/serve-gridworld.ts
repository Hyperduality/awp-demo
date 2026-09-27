// Serves the test gridworld for awp-conformance: tsx test/serve-gridworld.ts <mode> <port>
import { serveWorld } from "../src/index.ts";
import { gridworld } from "./gridworld.ts";

const mode = (process.argv[2] ?? "lockstep") as "lockstep" | "streaming";
const port = Number(process.argv[3] ?? 8799);
await serveWorld(gridworld(mode), { port, token: "conformance-token-0123", auditDir: "awp-audit", operatorSignals: true });
