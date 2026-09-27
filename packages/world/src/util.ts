import { createHash, randomBytes } from "node:crypto";

/** Unpadded base64url, the recommended token alphabet (AWP-SEC-005). */
export function mintToken(prefix: string, bytes = 18): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function jsonPayloadB64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeB64Json(b64: string): unknown {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** JSON value equality: objects member-wise regardless of order, numbers by value (AWP-ACT-009). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => !k.startsWith("x-"));
  const bk = Object.keys(bo).filter((k) => !k.startsWith("x-"));
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k]));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const REDACT_KEYS = new Set(["session_token", "transfer_token", "snapshot_token"]);

/** Replaces credential values with `[redacted:sha256:<8 hex>]` (AWP-AUD-006). Returns a copy. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        REDACT_KEYS.has(k) && typeof v === "string" ? `[redacted:sha256:${sha256Hex(v).slice(0, 8)}]` : redact(v);
    }
    return out as T;
  }
  return value;
}

export interface Stats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export function stats(samples: number[]): Stats | undefined {
  if (samples.length === 0) return undefined;
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => Math.max(0, Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!));
  return { count: s.length, p50: at(0.5), p95: at(0.95), max: Math.max(0, Math.round(s[s.length - 1]!)) };
}

export function monotonicNs(): number {
  return Number(process.hrtime.bigint());
}
