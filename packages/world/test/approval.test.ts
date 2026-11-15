import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActionRecord, AWP_SUBPROTOCOL, AwpClient } from "@hyperduality/awp";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RunningWorld, type ServeOptions, serveWorld } from "../src/index.ts";
import { gridworld } from "./gridworld.ts";

const TOKEN = "test-token-0123456789";
const APPROVER = "test-approver-0123456789";
const TASK = { content: [{ type: "text" as const, text: "Let the delivery in." }] };

let world: RunningWorld | undefined;
const sockets: WebSocket[] = [];
const problems: string[] = [];

async function start(mode: "lockstep" | "streaming", approvalTimeoutMs = 60000, extra: Partial<ServeOptions> = {}) {
  world = await serveWorld(gridworld(mode, { approvalTimeoutMs }), {
    port: 0,
    token: TOKEN,
    approverToken: APPROVER,
    log: (l) => problems.push(l),
    ...extra,
  });
  return world;
}

async function agent(url: string, mode: "lockstep" | "streaming") {
  const c = new AwpClient({
    url,
    token: TOKEN,
    agent: { name: "test", version: "0.0.0", vendor: "awp-demo" },
    consumesModalities: ["text/event+json"],
  });
  await c.initialize();
  const ready = await c.openSession(mode, { embodiment: "avatar_0", subscribe: ["grid_view"], task: TASK });
  return { c, session: ready.session_id };
}

interface ApprovalRequest {
  approval_id: string;
  action_id: string;
  type: string;
  params: unknown;
  requester: { session: string; embodiment?: string };
  task?: unknown;
  expires_at_ns: number;
}

interface Reply {
  result?: unknown;
  error?: { code: number; message: string };
}

/** A connection holding `token` that initializes, collects approval requests, and answers them. */
async function approver(url: string, token = APPROVER) {
  const ws = new WebSocket(url, [AWP_SUBPROTOCOL], { headers: { authorization: `Bearer ${token}` } });
  sockets.push(ws);
  const requests: ApprovalRequest[] = [];
  const replies = new Map<number, (r: Reply) => void>();
  let arrived: (() => void) | undefined;
  let calls = 0;
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    if (m.method === "safety.approval_requested") {
      requests.push(m.params);
      arrived?.();
    } else replies.get(m.id)?.(m);
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const call = (method: string, params: unknown) =>
    new Promise<Reply>((resolve) => {
      const id = ++calls;
      replies.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  const initialized = await call("initialize", {
    protocol_versions: ["0.1"],
    agent: { name: "approver", version: "0.0.0", vendor: "awp-demo" },
    consumes_modalities: ["text/event+json"],
  });
  expect(initialized.error).toBeUndefined();
  return {
    requests,
    async request(action: ActionRecord): Promise<ApprovalRequest> {
      for (;;) {
        const found = requests.find((r) => r.action_id === action.action_id);
        if (found) return found;
        await new Promise<void>((resolve) => {
          arrived = resolve;
        });
      }
    },
    respond: (approval_id: string, decision: "approve" | "deny", extra: Record<string, unknown> = {}) =>
      call("safety.approval.respond", { approval_id, decision, ...extra }),
  };
}

const states = (rec: ActionRecord) => [...new Set(rec.history.map((h) => h.state))];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await world?.close();
  world = undefined;
  expect(problems.filter((p) => p.includes("failed its sender form"))).toEqual([]);
  problems.length = 0;
});

describe("approval in a streaming world", () => {
  it("holds an action that needs approval until an approver approves it (AWP-APR-001, AWP-APR-002)", async () => {
    const w = await start("streaming");
    const a = await approver(w.url);
    const { c, session } = await agent(w.url, "streaming");
    const gate = await c.submit("open_gate", {});
    expect(gate.state).toBe("pending_approval");
    const req = await a.request(gate);
    expect(req).toMatchObject({
      type: "open_gate",
      params: {},
      requester: { session, embodiment: "avatar_0" },
      task: TASK,
    });
    // The gate would have opened by now had it been allowed to.
    await sleep(200);
    expect(gate.state).toBe("pending_approval");
    expect((await a.respond(req.approval_id, "approve")).result).toEqual({});
    await gate.settled();
    expect(states(gate)).toEqual(["pending_approval", "accepted", "executing", "completed"]);
    expect(gate.violations).toEqual([]);
    await c.close();
  });

  it("rejects on a denial and at approval_timeout_ms, executing nothing (AWP-APR-002, AWP-APR-003)", async () => {
    const w = await start("streaming", 300);
    const a = await approver(w.url);
    const { c } = await agent(w.url, "streaming");
    const denied = await c.submit("open_gate", {});
    await a.respond((await a.request(denied)).approval_id, "deny");
    await denied.settled();
    expect([denied.state, denied.reason]).toEqual(["rejected", "approval_denied"]);

    const lapsed = await c.submit("open_gate", {});
    const req = await a.request(lapsed);
    expect(req.expires_at_ns - lapsed.received_ts_mono_ns!).toBe(300e6);
    await lapsed.settled();
    expect([lapsed.state, lapsed.reason]).toEqual(["rejected", "approval_timeout"]);
    expect(states(lapsed)).toEqual(["pending_approval", "rejected"]);
    expect(lapsed.history.at(-1)!.ts_mono_ns).toBeGreaterThanOrEqual(req.expires_at_ns);
    await c.close();
  });

  it("rejects with deadline_exceeded when the submission's deadline passes first (AWP-APR-003)", async () => {
    const w = await start("streaming", 2000);
    const a = await approver(w.url);
    const { c } = await agent(w.url, "streaming");
    const gate = await c.submit("open_gate", {}, { deadlineMs: 150 });
    const req = await a.request(gate);
    await gate.settled();
    expect([gate.state, gate.reason]).toEqual(["rejected", "deadline_exceeded"]);
    expect((await a.respond(req.approval_id, "approve")).error?.code).toBe(3001);
    await c.close();
  });

  it("refuses a decision that is unauthorized, repeated, or carries a standing grant (AWP-APR-004, AWP-APR-007)", async () => {
    const w = await start("streaming");
    const a = await approver(w.url);
    const notApprover = await approver(w.url, TOKEN);
    const { c } = await agent(w.url, "streaming");
    const gate = await c.submit("open_gate", {});
    const req = await a.request(gate);
    expect(notApprover.requests).toEqual([]);
    expect((await notApprover.respond(req.approval_id, "approve")).error?.code).toBe(4001);
    const standing = { scope: { type: "open_gate" }, expires_at_ns: req.expires_at_ns };
    expect((await a.respond(req.approval_id, "approve", { standing })).error?.code).toBe(3001);
    expect((await a.respond("apr_unknown", "approve")).error?.code).toBe(3001);
    await sleep(50);
    expect(gate.state).toBe("pending_approval");
    expect((await a.respond(req.approval_id, "approve")).result).toEqual({});
    expect((await a.respond(req.approval_id, "deny")).error?.code).toBe(3001);
    await gate.settled();
    expect(gate.state).toBe("completed");
    await c.close();
  });

  it("forgets the request of a pending action the agent cancels (AWP-LIF-005)", async () => {
    const w = await start("streaming");
    const a = await approver(w.url);
    const { c } = await agent(w.url, "streaming");
    const gate = await c.submit("open_gate", {});
    const req = await a.request(gate);
    await c.cancel(gate.action_id);
    expect(states(gate)).toEqual(["pending_approval", "cancelled"]);
    expect((await a.respond(req.approval_id, "approve")).error?.code).toBe(3001);
    await c.close();
  });

  it("records the request and the decision in the requesting session's audit log (AWP-AUD-001)", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "awp-audit-"));
    const w = await start("streaming", 60000, { auditDir });
    const a = await approver(w.url);
    const { c, session } = await agent(w.url, "streaming");
    const gate = await c.submit("open_gate", {});
    const req = await a.request(gate);
    await a.respond(req.approval_id, "approve", { note: "Expected." });
    await gate.settled();
    await c.close();
    const file = readdirSync(auditDir).find((f) => f.includes(session))!;
    const control = readFileSync(join(auditDir, file), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { direction: string; body: { method?: string; params?: Record<string, unknown> } })
      .filter((r) => r.body.method?.startsWith("safety."));
    expect(control.map((r) => [r.direction, r.body.method])).toEqual([
      ["out", "safety.approval_requested"],
      ["in", "safety.approval.respond"],
    ]);
    expect(control[0]!.body.params).toMatchObject({ approval_id: req.approval_id, action_id: gate.action_id });
    expect(control[1]!.body.params).toEqual({ approval_id: req.approval_id, decision: "approve", note: "Expected." });
  });
});

describe("approval in a lockstep world", () => {
  it("times an approval out on simulated time (AWP-TIM-013)", async () => {
    // One advance is 1 ms of simulated time.
    const w = await start("lockstep", 20);
    await approver(w.url);
    const { c } = await agent(w.url, "lockstep");
    const gate = await c.submit("open_gate", {});
    await sleep(100);
    await c.advance(19);
    expect(gate.state).toBe("pending_approval");
    await c.advance(1);
    expect([gate.state, gate.reason]).toEqual(["rejected", "approval_timeout"]);
    await c.close();
  });

  it("takes the group on approval as the submission chose: queue, or replace (AWP-PRE-002, AWP-PRE-003)", async () => {
    const w = await start("lockstep");
    const a = await approver(w.url);
    const { c } = await agent(w.url, "lockstep");
    const approve = async (rec: ActionRecord) => a.respond((await a.request(rec)).approval_id, "approve");

    const first = await c.submit("open_gate", {}, { preempt: "queue" });
    await approve(first);
    await first.until((r) => r.state === "accepted");
    await c.advance(1);
    expect(first.state).toBe("executing");

    const queued = await c.submit("open_gate", {}, { preempt: "queue" });
    await approve(queued);
    await queued.until((r) => r.state === "queued");

    const replacement = await c.submit("open_gate", {}, { preempt: "replace" });
    expect(replacement.state).toBe("pending_approval");
    expect([first.state, queued.state]).toEqual(["executing", "queued"]);
    await approve(replacement);
    await replacement.until((r) => r.state === "accepted");
    expect([queued.state, queued.reason]).toEqual(["cancelled", "superseded"]);
    await c.advance(1);
    expect([first.state, replacement.state]).toEqual(["preempted", "executing"]);
    await c.close();
  });
});
