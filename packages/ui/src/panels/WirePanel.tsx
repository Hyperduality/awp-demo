import { type WireEntry, type WorldState, WorldTopic } from "@awp-demo/inspector";
import { useStream, useTopic } from "@awp-demo/inspector/react";
import { ArrowDownToLine, Pause, Play, TrashBin, Xmark } from "@gravity-ui/icons";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useDemo, useFocusAction } from "../context.tsx";
import { bytes, clockTime, decodePayload, stateTone, TONE_CLASS, type Tone } from "../format.ts";
import { IconButton } from "../primitives/IconButton.tsx";
import { JsonView } from "../primitives/JsonView.tsx";
import { Segmented } from "../primitives/Segmented.tsx";

type Filter = "all" | "control" | "actions" | "frames";

interface Row {
  key: string;
  first: WireEntry;
  last: WireEntry;
  count: number;
  method: string;
  kind: "request" | "result" | "error" | "notification" | "frame";
  summary: string;
  tone: Tone;
  actionId?: string | undefined;
  channels?: string[];
}

type Msg = {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { detail?: string } };
};

const ACTION_METHODS = new Set(["action.submit", "action.cancel", "action.status"]);

/** Collapses runs of frames on one channel into a single row and names what each message is. */
function deriveRows(entries: readonly WireEntry[], channelNames: Map<string, string>): Row[] {
  const rows: Row[] = [];
  const methodById = new Map<string, string>();
  for (const e of entries) {
    const m = e.message as Msg;
    if (!m || typeof m !== "object") continue;
    const reqKey = (from: string) => `${e.conn}:${from}:${String(m.id)}`;
    if (m.method === "obs.frame" || m.method === "cmd.frame") {
      const ch = String(m.params?.channel_id ?? "?");
      const name = channelNames.get(`${e.session}:${ch}`) ?? `channel ${ch}`;
      const at = m.params?.tick !== undefined ? ` · tick ${m.params.tick}` : ` · seq ${m.params?.seq}`;
      const prev = rows[rows.length - 1];
      // A run of frames collapses into one row, naming each channel in it.
      if (prev && prev.kind === "frame" && prev.method === m.method && prev.first.session === e.session) {
        prev.count += 1;
        prev.last = e;
        if (!prev.channels!.includes(name)) prev.channels!.push(name);
        prev.summary = `${prev.channels!.join(", ")}${at}`;
        continue;
      }
      rows.push({
        key: `f${e.n}`,
        first: e,
        last: e,
        count: 1,
        method: m.method,
        kind: "frame",
        summary: `${name}${at}`,
        tone: "muted",
        channels: [name],
      });
      continue;
    }
    if (m.method !== undefined && m.id !== undefined) {
      methodById.set(reqKey(e.from), m.method);
      rows.push(requestRow(e, m));
      continue;
    }
    if (m.method !== undefined) {
      rows.push(notificationRow(e, m));
      continue;
    }
    // A response: its method is the request's, sent the other way.
    const method = methodById.get(reqKey(e.from === "agent" ? "world" : "agent")) ?? "result";
    rows.push(responseRow(e, m, method));
  }
  return rows;
}

function requestRow(e: WireEntry, m: Msg): Row {
  const p = m.params ?? {};
  let summary = "";
  if (m.method === "action.submit") summary = `${p.type} · ${p.action_id}`;
  else if (m.method === "action.cancel" || m.method === "action.status") summary = String(p.action_id);
  else if (m.method === "world.tick")
    summary = `from tick ${p.expected_tick}${p.count && p.count !== 1 ? ` × ${p.count}` : ""}`;
  else if (m.method === "session.open")
    summary = `${p.mode} · ${(p.embodiments as string[] | undefined)?.join(", ") ?? p.embodiment ?? "observer"}`;
  else if (m.method === "initialize") summary = String((p.agent as { name?: string } | undefined)?.name ?? "");
  return {
    key: `r${e.n}`,
    first: e,
    last: e,
    count: 1,
    method: m.method!,
    kind: "request",
    summary: summary ? `#${m.id} · ${summary}` : `#${m.id}`,
    tone: "default",
    actionId: typeof p.action_id === "string" ? p.action_id : undefined,
  };
}

function responseRow(e: WireEntry, m: Msg, method: string): Row {
  if (m.error) {
    return {
      key: `x${e.n}`,
      first: e,
      last: e,
      count: 1,
      method,
      kind: "error",
      summary: `#${m.id} · ${m.error.message}${m.error.data?.detail ? ` · ${m.error.data.detail}` : ""}`,
      tone: "danger",
    };
  }
  const r = m.result ?? {};
  let summary = `#${m.id}`;
  let tone: Tone = "muted";
  if (typeof r.state === "string") {
    summary += ` · ${r.state}`;
    tone = stateTone(r.state);
  } else if (typeof r.tick === "number") summary += ` · tick ${r.tick}`;
  else if (typeof r.session_id === "string") summary += ` · ${r.session_id}`;
  else if (method === "initialize" || method === "world.manifest")
    summary += ` · ${(r.world as { name?: string } | undefined)?.name ?? "manifest"}`;
  return {
    key: `s${e.n}`,
    first: e,
    last: e,
    count: 1,
    method,
    kind: "result",
    summary,
    tone,
    actionId: typeof r.action_id === "string" ? r.action_id : undefined,
  };
}

function notificationRow(e: WireEntry, m: Msg): Row {
  const p = m.params ?? {};
  let summary = "";
  let tone: Tone = "muted";
  if (m.method === "action.status") {
    summary = `${p.action_id} · ${p.state}${p.reason ? ` (${p.reason})` : ""}${typeof p.progress === "number" ? ` · ${Math.round(p.progress * 100)}%` : ""}`;
    tone = stateTone(p.state as string);
  } else if (m.method === "session.state") summary = `${p.state}${p.reason ? ` · ${p.reason}` : ""}`;
  else if (m.method === "world.event") {
    summary = String(p.event);
    tone =
      String(p.event).includes("safe_state_entered") || String(p.event).startsWith("e_stop_engaged")
        ? "warning"
        : "default";
  } else if (m.method === "session.telemetry") summary = `${p.window_ms} ms window`;
  return {
    key: `n${e.n}`,
    first: e,
    last: e,
    count: 1,
    method: m.method!,
    kind: "notification",
    summary: p.status_seq !== undefined ? `${summary} · seq ${p.status_seq}` : summary,
    tone,
    actionId: typeof p.action_id === "string" ? p.action_id : undefined,
  };
}

function matches(row: Row, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "frames") return row.kind === "frame";
  if (f === "actions") return ACTION_METHODS.has(row.method);
  return row.kind !== "frame";
}

export function WirePanel() {
  const { world } = useDemo();
  const entries = useStream<WireEntry>(world, WorldTopic.wire);
  const worldState = useTopic<WorldState>(world, WorldTopic.world);
  const [filter, setFilter] = useState<Filter>("all");
  const [paused, setPaused] = useState<readonly WireEntry[] | null>(null);
  const [clearedAt, setClearedAt] = useState(0);
  const [selected, setSelected] = useState<Row | null>(null);
  const { actionId: focused, setActionId } = useFocusAction();

  const channelNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of worldState?.sessions ?? []) for (const c of s.channels) m.set(`${s.id}:${c.channelId}`, c.channel);
    return m;
  }, [worldState]);

  const source = paused ?? entries;
  const rows = useMemo(() => {
    const visible = clearedAt ? source.filter((e) => e.n > clearedAt) : source;
    return deriveRows(visible, channelNames).filter((r) => matches(r, filter));
  }, [source, channelNames, filter, clearedAt]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });
  useEffect(() => {
    if (follow.current && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, virtualizer]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2">
        <Segmented
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "All" },
            { id: "control", label: "Control" },
            { id: "actions", label: "Actions" },
            { id: "frames", label: "Frames" },
          ]}
        />
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 text-muted">
          <IconButton label={paused ? "Resume" : "Pause"} onPress={() => setPaused(paused ? null : entries)}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </IconButton>
          <IconButton
            label="Follow"
            onPress={() => {
              follow.current = true;
              virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
            }}
          >
            <ArrowDownToLine className="size-3.5" />
          </IconButton>
          <IconButton label="Clear" onPress={() => setClearedAt(entries[entries.length - 1]?.n ?? 0)}>
            <TrashBin className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-1.5"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">No messages yet</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]!;
              return (
                <div key={row.key} className="absolute inset-x-0" style={{ top: v.start, height: v.size }}>
                  <WireRow
                    row={row}
                    selected={selected?.key === row.key}
                    highlighted={focused !== null && row.actionId === focused}
                    onSelect={() => setSelected(row)}
                    onHover={(h) => row.actionId && setActionId(h ? row.actionId : null)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {selected && <WireDetail row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

const WireRow = memo(function WireRow(props: {
  row: Row;
  selected: boolean;
  highlighted: boolean;
  onSelect(): void;
  onHover(h: boolean): void;
}) {
  const { row } = props;
  const toWorld = row.first.from === "agent";
  return (
    <button
      type="button"
      onClick={props.onSelect}
      onMouseEnter={() => props.onHover(true)}
      onMouseLeave={() => props.onHover(false)}
      className={`flex h-7 w-full cursor-[var(--cursor-interactive)] items-center gap-3 rounded-lg px-2 text-left font-mono text-xs ${
        props.selected ? "bg-surface-secondary" : props.highlighted ? "bg-accent/10" : "hover:bg-surface-secondary"
      }`}
    >
      <span className="tnum w-[5.5rem] shrink-0 text-muted">{clockTime(row.last.ts).slice(3)}</span>
      <span className={`w-[4.5rem] shrink-0 ${toWorld ? "text-foreground" : "text-muted"}`}>
        {toWorld ? "agent →" : "← world"}
      </span>
      <span className={`w-[8.5rem] shrink-0 truncate ${row.kind === "frame" ? "text-muted" : "text-foreground"}`}>
        {row.method}
      </span>
      <span className={`min-w-0 flex-1 truncate ${TONE_CLASS[row.tone]}`}>{row.summary}</span>
      {row.count > 1 && <span className="tnum shrink-0 text-muted">×{row.count}</span>}
    </button>
  );
});

function WireDetail({ row, onClose }: { row: Row; onClose(): void }) {
  const m = row.last.message as Msg;
  const payload = m.params && "payload_b64" in m.params ? decodePayload(m.params.payload_b64) : undefined;
  return (
    <div className="flex max-h-[45%] min-h-[9rem] flex-col border-t border-separator">
      <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3.5">
        <span className="font-mono text-xs text-foreground">{row.method}</span>
        <span className="tnum text-xs text-muted">
          {clockTime(row.last.ts)} · {bytes(row.last.bytes)}
          {row.count > 1 ? ` · latest of ${row.count}` : ""}
        </span>
        <div className="flex-1" />
        <IconButton label="Close" onPress={onClose}>
          <Xmark className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 pb-3">
        {payload !== undefined && (
          <section>
            <div className="mb-1 text-xs text-muted">Payload</div>
            <JsonView value={payload} />
          </section>
        )}
        <section>
          {payload !== undefined && <div className="mb-1 text-xs text-muted">Message</div>}
          <JsonView value={m} />
        </section>
      </div>
    </div>
  );
}
