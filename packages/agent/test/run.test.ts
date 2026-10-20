import { AgentCommand } from "@awp-demo/inspector";
import { serveWorld } from "@awp-demo/world";
import { expect, it } from "vitest";
import { gridworld } from "../../world/test/gridworld.ts";
import { runAgent } from "../src/run.ts";

const TOKEN = "run-test-token-0000000";
const INSPECTOR = 18997;

const until = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** An inspector command, as the UI sends it. */
async function command(name: string, args: unknown): Promise<{ ok: boolean; error?: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${INSPECTOR}`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const reply = new Promise<{ ok: boolean; error?: string }>((resolve) =>
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as { t: string; id?: number; ok: boolean; error?: string };
      if (m.t === "res" && m.id === 1) resolve(m);
    }),
  );
  ws.send(JSON.stringify({ t: "cmd", id: 1, name, args }));
  const r = await reply;
  ws.close();
  return r;
}

it("reopens the session in the other time model when the UI asks", async () => {
  const world = await serveWorld(gridworld("both"), { port: 0, token: TOKEN, log: () => {} });
  const agent = await runAgent({
    name: "run-test",
    worldUrl: world.url,
    token: TOKEN,
    inspectorPort: INSPECTOR,
    consumes: ["text/event+json"],
    controllers: [],
    open: () => ({ embodiment: "avatar_0", subscribe: ["grid_view"] }),
    timeModel: "streaming",
    log: () => {},
  });
  try {
    await until(() => agent.mux.client?.mode === "streaming" && agent.mux.client.ready !== undefined);
    expect((await command(AgentCommand.mode, { mode: "lockstep" })).ok).toBe(true);
    await until(() => agent.mux.client?.mode === "lockstep");
    expect((await command(AgentCommand.mode, { mode: "turn-based" })).error).toMatch(/no time model/);
  } finally {
    await agent.stop();
    await world.close();
  }
});
