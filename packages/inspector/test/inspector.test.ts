import { afterEach, describe, expect, it } from "vitest";
import { InspectorClient } from "../src/client.ts";
import { createInspectorServer, type InspectorServer } from "../src/server.ts";

let server: InspectorServer | undefined;
let client: InspectorClient | undefined;
afterEach(async () => {
  client?.close();
  await server?.close();
});

const until = async (pred: () => boolean) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > 3000) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("inspector", () => {
  it("delivers snapshots, keyed stream upserts, state, and commands", async () => {
    server = await createInspectorServer({ port: 0, process: "agent" });
    const log = server.stream<{ id: string; text: string }>("log", { key: (e) => e.id, flushMs: 5 });
    const state = server.state("status", { n: 0 });
    log.push({ id: "a", text: "one" });
    server.handle("add", (args) => (args as { x: number }).x + 1);
    client = new InspectorClient(`ws://127.0.0.1:${server.port}`);
    await until(() => client!.get<unknown[]>("log")?.length === 1);
    log.upsert({ id: "a", text: "one, revised" });
    log.push({ id: "b", text: "two" });
    state.set({ n: 2 });
    await until(() => client!.get<unknown[]>("log")?.length === 2 && client!.get<{ n: number }>("status")?.n === 2);
    expect(client.get<{ text: string }[]>("log")![0]!.text).toBe("one, revised");
    expect(await client.command("add", { x: 41 })).toBe(42);
    await expect(client.command("nope")).rejects.toThrow(/unknown command/);
  });
});
