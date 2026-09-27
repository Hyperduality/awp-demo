// Runs the autopilot against a fresh maze and reports progress: tsx test/autopilot.run.ts
import { ControlMux } from "@awp-demo/agent";
import { serveWorld } from "@awp-demo/world";
import { AwpClient } from "@hyperduality/awp";
import { program } from "../src/agent/controllers/program.ts";
import { maze } from "../src/world/definition.ts";

const world = await serveWorld(maze, { port: 0, token: "t-0123456789abcdef", log: () => {} });
const client = new AwpClient({
  url: world.url,
  token: "t-0123456789abcdef",
  agent: { name: "t", version: "0", vendor: "t" },
  consumesModalities: ["proprio/json", "text/event+json"],
});
await client.initialize();
await client.openSession("streaming", { embodiment: "runner_0", subscribe: ["pose", "ranges", "vision", "progress"] });
const mux = new ControlMux([program as never], {
  activity: (e) =>
    console.log(
      `${e.kind} ${e.title} ${e.detail ?? ""} ${e.state ?? ""} ${JSON.stringify(e.data ?? "").slice(0, 120)}`,
    ),
  controllers: (l) => {
    const s = l[0]?.status;
    if (s !== (globalThis as any).__s) {
      (globalThis as any).__s = s;
      console.log("status", s);
    }
  },
  changed: () => {},
});
mux.attach(client);
mux.enable("program", true);
const t0 = Date.now();
const timer = setInterval(() => {
  const v = world.host.sim.view() as { collected: number; escaped: boolean };
  console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s collected=${v.collected} escaped=${v.escaped}`);
  if (v.escaped || Date.now() - t0 > 280000) {
    clearInterval(timer);
    mux.detach();
    void client
      .close()
      .then(() => world.close())
      .then(() => process.exit(0));
  }
}, 10000);
