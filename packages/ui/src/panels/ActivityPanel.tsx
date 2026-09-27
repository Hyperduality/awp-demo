import { type ActivityEntry, AgentCommand, AgentTopic, type ControllerState } from "@awp-demo/inspector";
import { useStream, useTopic } from "@awp-demo/inspector/react";
import { Separator } from "@heroui/react";
import { PromptInput, TextShimmer } from "@heroui-pro/react";
import { StreamMarkdown } from "@heroui-pro/react/markdown";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useDemo, useFocusAction } from "../context.tsx";
import { stateLabel, stateTone, TONE_CLASS } from "../format.ts";

/** One timeline for every controller: what each did, thought, and said, and when control changed hands. */
export function ActivityPanel({ composer = true }: { composer?: boolean }) {
  const { agent } = useDemo();
  const entries = useStream<ActivityEntry>(agent, AgentTopic.activity);
  const controllers = useTopic<ControllerState[]>(agent, AgentTopic.controllers) ?? [];
  const labels = useMemo(() => {
    const m = new Map<string, string>([
      ["world", "World"],
      ["operator", "You"],
      ["mux", ""],
    ]);
    for (const c of controllers) m.set(c.id, c.label);
    return m;
  }, [controllers]);
  const llm = controllers.find((c) => c.kind === "llm");
  const visible = useMemo(() => entries.filter((e) => !(e.kind === "system" && !e.title)), [entries]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 8,
    getItemKey: (i) => visible[i]!.id,
  });
  const last = visible[visible.length - 1];
  // Follow the tail as entries arrive and as the last one streams in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: last?.title re-runs the effect while text streams
  useEffect(() => {
    if (follow.current && visible.length > 0) virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
  }, [visible.length, last?.title, virtualizer]);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
            Nothing yet. Enable a controller to start.
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const entry = visible[v.index]!;
              const prev = visible[v.index - 1];
              const showSource =
                entry.kind === "handoff" ? false : !prev || prev.source !== entry.source || prev.kind === "handoff";
              return (
                <div
                  key={v.key}
                  ref={virtualizer.measureElement}
                  data-index={v.index}
                  className="absolute inset-x-0"
                  style={{ top: v.start }}
                >
                  <Row
                    entry={entry}
                    label={showSource ? (labels.get(entry.source) ?? entry.source) : ""}
                    spaced={showSource && v.index > 0}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {composer && llm && <Composer controller={llm} />}
    </div>
  );
}

const Row = memo(function Row({ entry, label, spaced }: { entry: ActivityEntry; label: string; spaced: boolean }) {
  const { actionId: focused, setActionId } = useFocusAction();
  if (entry.kind === "handoff") {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Separator className="flex-1" />
        <span className="text-xs text-muted">{entry.title}</span>
        <Separator className="flex-1" />
      </div>
    );
  }
  const highlighted = entry.actionId !== undefined && entry.actionId === focused;
  return (
    <div
      className={`flex gap-3 px-4 py-1 ${spaced ? "pt-2.5" : ""} ${highlighted ? "bg-accent/10" : ""}`}
      onMouseEnter={() => entry.actionId && setActionId(entry.actionId)}
      onMouseLeave={() => entry.actionId && setActionId(null)}
    >
      <div className="w-16 shrink-0 truncate pt-px text-xs text-muted">{label}</div>
      <div className="min-w-0 flex-1">
        <Content entry={entry} />
      </div>
    </div>
  );
});

function Content({ entry }: { entry: ActivityEntry }) {
  switch (entry.kind) {
    case "action": {
      const data = entry.data as { reason?: string; error?: string; progress?: number } | undefined;
      const tone = stateTone(entry.state);
      return (
        <div className="text-sm">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs text-foreground">{entry.title}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{entry.detail}</span>
            {entry.state === "executing" ? (
              <TextShimmer className="shrink-0 text-xs">
                {data?.progress !== undefined ? `Executing ${Math.round(data.progress * 100)}%` : "Executing"}
              </TextShimmer>
            ) : (
              <span className={`shrink-0 text-xs ${TONE_CLASS[tone]}`}>{stateLabel(entry.state)}</span>
            )}
          </div>
          {(data?.error || (data?.reason && (entry.state === "failed" || entry.state === "rejected"))) && (
            <div
              className={`mt-0.5 text-xs ${entry.state === "rejected" || entry.state === "failed" ? "text-danger" : "text-muted"}`}
            >
              {data?.error ?? data?.reason?.replace(/_/g, " ")}
            </div>
          )}
        </div>
      );
    }
    case "thought":
      return <Thought entry={entry} />;
    case "message":
      return (
        <StreamMarkdown className="text-sm text-foreground" isStreaming={entry.streaming === true}>
          {entry.title}
        </StreamMarkdown>
      );
    case "event":
      return (
        <div className="text-sm">
          <span
            className={
              entry.title.includes("Safe state entered") || entry.title.includes("E-stop engaged")
                ? "text-warning"
                : "text-foreground"
            }
          >
            {entry.title}
          </span>
          {entry.detail && <span className="ml-2 text-xs text-muted">{entry.detail}</span>}
        </div>
      );
    case "error":
      return (
        <div className="text-sm">
          <div className="text-danger">{entry.title}</div>
          {entry.detail && <div className="mt-0.5 text-xs break-words text-muted">{entry.detail}</div>}
        </div>
      );
    case "system":
    case "input":
      return <div className="text-sm text-muted">{entry.title}</div>;
    default:
      return (
        <div className="text-sm text-foreground">
          {entry.title}
          {entry.detail && <span className="ml-2 text-xs text-muted">{entry.detail}</span>}
        </div>
      );
  }
}

function Thought({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  if (entry.streaming) {
    return (
      <div className="text-sm">
        <TextShimmer>Thinking</TextShimmer>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted">{entry.title.split("\n").filter(Boolean).at(-1)}</p>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="block w-full cursor-[var(--cursor-interactive)] text-left text-sm"
      onClick={() => setOpen(!open)}
    >
      <span className="text-muted">Thought</span>
      {open ? (
        <p className="mt-1 text-xs whitespace-pre-wrap text-muted">{entry.title}</p>
      ) : (
        <span className="ml-2 inline-block max-w-[80%] truncate align-bottom text-xs text-muted">
          {entry.title.split("\n")[0]}
        </span>
      )}
    </button>
  );
}

function Composer({ controller }: { controller: ControllerState }) {
  const { agent } = useDemo();
  const [value, setValue] = useState("");
  const running = controller.engaged;
  return (
    <div className="shrink-0 p-3 pt-2">
      <PromptInput
        value={value}
        onValueChange={setValue}
        status={running ? "streaming" : "ready"}
        onStop={() => agent.command(AgentCommand.stop, { id: controller.id })}
        onSubmit={() => {
          const text = value.trim();
          if (!text) return;
          setValue("");
          void agent.command(AgentCommand.message, { id: controller.id, text });
        }}
        allowSubmitWhileRunning
      >
        <PromptInput.Shell>
          <PromptInput.Content>
            <PromptInput.TextArea placeholder={`Message ${controller.label}`} />
          </PromptInput.Content>
          <PromptInput.Toolbar>
            <PromptInput.ToolbarEnd>
              <PromptInput.Send />
            </PromptInput.ToolbarEnd>
          </PromptInput.Toolbar>
        </PromptInput.Shell>
      </PromptInput>
    </div>
  );
}
