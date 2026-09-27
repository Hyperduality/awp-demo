/** Formatting shared by every panel. */

export type Tone = "default" | "muted" | "accent" | "success" | "warning" | "danger";

export const TONE_CLASS: Record<Tone, string> = {
  default: "text-foreground",
  muted: "text-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** How an action lifecycle state reads. */
export function stateTone(state: string | undefined): Tone {
  switch (state) {
    case "completed":
      return "success";
    case "failed":
    case "rejected":
      return "danger";
    case "preempted":
    case "cancelled":
    case "cancelling":
      return "muted";
    case "executing":
      return "accent";
    default:
      return "muted";
  }
}

export function stateLabel(state: string | undefined): string {
  if (!state) return "";
  return state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, " ");
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function relativeMs(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function nsToSeconds(ns: number): string {
  return `${(ns / 1e9).toFixed(2)} s`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} kB`;
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function compactJson(value: unknown, max = 120): string {
  const s = JSON.stringify(value);
  if (s === undefined) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function decodePayload(b64: unknown): unknown {
  if (typeof b64 !== "string") return undefined;
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
