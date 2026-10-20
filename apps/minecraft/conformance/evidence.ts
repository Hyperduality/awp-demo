/**
 * Scripted scenarios whose device-level log is the manual evidence for AWP-GAM-002..004. Start the
 * world with AWP_AUDIT_DIR set (it writes every applied device state to `*-input.jsonl` there), run
 * this, and keep the log with the scenario map it prints:
 *
 *   tsx conformance/evidence.ts [ws://127.0.0.1:8715] > conformance/evidence/scenarios.json
 */
import { type ActionRecord, AwpClient } from "@hyperduality/awp";

const url = process.argv[2] ?? "ws://127.0.0.1:8715";
const token = process.env.AWP_TOKEN ?? "awp-demo-local-token";
const rows: { scenario: string; mode: string; action_id: string; state: string; reason?: string | undefined }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slots = (keys: string[], n: number) => Array.from({ length: n }, () => ({ keys }));
const chunk = (s: Record<string, unknown>[]) => ({ slot_ms: 50, slots: s });

async function open(mode: "lockstep" | "streaming", quiet = false) {
  const c = new AwpClient({
    url,
    token,
    agent: { name: "gam-evidence", version: "0.1.0", vendor: "awp-demo" },
    consumesModalities: ["text/event+json"],
    ...(quiet ? { heartbeat: "manual" as const, obsReport: false } : {}),
  });
  await c.initialize();
  await c.openSession(mode, { embodiment: "player", subscribe: ["status"] });
  return c;
}

function note(scenario: string, mode: string, rec: ActionRecord) {
  rows.push({ scenario, mode, action_id: rec.action_id, state: rec.state, reason: rec.reason });
}

// Streaming
{
  const c = await open("streaming");
  // AWP-GAM-002: press at a slot's start, hold across slots, release where a key is no longer listed.
  const a = await c.submit(
    "input_chunk",
    chunk([{ keys: ["KeyW"] }, { keys: ["KeyW", "ShiftLeft"], mouse_dx: 40 }, { keys: ["ShiftLeft"] }, {}]),
  );
  await a.settled();
  note("slots", "streaming", a);
  // AWP-GAM-003: ShiftLeft stays down across a replacement; KeyW is released at the boundary.
  const held = await c.submit("input_chunk", chunk(slots(["KeyW", "ShiftLeft"], 20)), { preempt: "replace" });
  await sleep(220);
  const next = await c.submit("input_chunk", chunk(slots(["ShiftLeft", "KeyD"], 4)), { preempt: "replace" });
  await next.settled();
  note("replace (replaced)", "streaming", held);
  note("replace (replacement)", "streaming", next);
  // AWP-GAM-004: a cancel releases everything before the terminal status.
  const cancelled = await c.submit("input_chunk", chunk(slots(["KeyW"], 20)));
  await sleep(300);
  await c.cancel(cancelled.action_id);
  await cancelled.settled();
  note("cancel", "streaming", cancelled);
  await c.close();
}
{
  // AWP-GAM-004: a quiet agent; the watchdog enters safe state, which releases everything.
  const c = await open("streaming", true);
  const left = await c.submit("input_chunk", chunk(slots(["KeyS", "MouseLeft"], 20)));
  await left.settled();
  note("safe state", "streaming", left);
  await c.close();
}

// Lockstep
{
  const c = await open("lockstep");
  const a = await c.submit(
    "input_chunk",
    chunk([{ keys: ["KeyW"] }, { keys: ["KeyW", "ShiftLeft"], mouse_dx: 40 }, { keys: ["ShiftLeft"] }, {}]),
  );
  await c.advance(4);
  note("slots", "lockstep", a);
  const held = await c.submit("input_chunk", chunk(slots(["KeyW", "ShiftLeft"], 10)), { preempt: "replace" });
  await c.advance(3);
  const next = await c.submit("input_chunk", chunk(slots(["ShiftLeft", "KeyD"], 2)), { preempt: "replace" });
  await c.advance(2);
  note("replace (replaced)", "lockstep", held);
  note("replace (replacement)", "lockstep", next);
  const cancelled = await c.submit("input_chunk", chunk(slots(["KeyW"], 10)));
  await c.advance(3);
  await c.cancel(cancelled.action_id);
  await c.advance(1);
  note("cancel", "lockstep", cancelled);
  await c.close();
}

console.log(JSON.stringify(rows, null, 2));
process.exit(0);
