import {
  AgentCommand,
  type AgentStatus,
  AgentTopic,
  type ControllerState,
  type LlmProvider,
  MODEL_SUGGESTIONS,
  REDACTED,
} from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { ArrowChevronRight, Pause, Play } from "@gravity-ui/icons";
import { Button, ComboBox, Input, Label, ListBox, Select, Slider, Switch, TextField } from "@heroui/react";
import { type ReactNode, useEffect, useState } from "react";
import { useDemo } from "../context.tsx";
import { titleCase } from "../format.ts";
import { IconButton } from "../primitives/IconButton.tsx";
import { Segmented } from "../primitives/Segmented.tsx";

interface JsonSchemaProp {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
  title?: string;
  "x-secret"?: boolean;
}

/**
 * Every controller of the agent, which one holds control, and its settings. `extras` adds a
 * controller-specific section (a keymap, a task button) below its settings.
 */
export function ControlPanel({ extras = {} }: { extras?: Record<string, ReactNode> }) {
  const { agent } = useDemo();
  const controllers = useTopic<ControllerState[]>(agent, AgentTopic.controllers) ?? [];
  const status = useTopic<AgentStatus>(agent, AgentTopic.status);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    controllers.find((c) => c.id === selectedId) ?? controllers.find((c) => c.authority) ?? controllers[0];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <ul className="flex flex-col gap-1 px-2">
        {controllers.map((c) => (
          <li key={c.id}>
            <ControllerRow controller={c} selected={selected?.id === c.id} onSelect={() => setSelectedId(c.id)} />
          </li>
        ))}
      </ul>
      {selected && (
        <div className="flex flex-col gap-4 px-4 pt-4 pb-4">
          <p className="text-sm text-muted">{selected.description}</p>
          <ConfigForm controller={selected} />
          {extras[selected.id]}
        </div>
      )}
      {status?.mode === "lockstep" && <TimeControls status={status} />}
    </div>
  );
}

function controllerStatus(c: ControllerState): string {
  if (!c.enabled) return "Off";
  if (c.authority) return c.status ? `In control · ${c.status}` : "In control";
  if (c.engaged) return c.status ? `Waiting · ${c.status}` : "Waiting for control";
  return c.status ?? "Standby";
}

function ControllerRow({
  controller: c,
  selected,
  onSelect,
}: {
  controller: ControllerState;
  selected: boolean;
  onSelect(): void;
}) {
  const { agent } = useDemo();
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row holds its own buttons, which a <button> cannot contain
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      className={`flex cursor-[var(--cursor-interactive)] items-center gap-3 rounded-xl px-2.5 py-2 ${
        selected ? "bg-surface-secondary" : "hover:bg-surface-secondary/60"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{c.label}</div>
        <div className={`truncate text-xs ${c.authority ? "text-accent" : "text-muted"}`}>{controllerStatus(c)}</div>
      </div>
      {c.enabled && (
        <Button
          size="sm"
          variant={c.pinned ? "secondary" : "ghost"}
          onPress={() => agent.command(c.pinned ? AgentCommand.release : AgentCommand.take, { id: c.id })}
        >
          {c.pinned ? "Release" : "Take"}
        </Button>
      )}
      <Switch
        aria-label={`Enable ${c.label}`}
        isSelected={c.enabled}
        onChange={(v) => agent.command(AgentCommand.enable, { id: c.id, enabled: v })}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
}

function ConfigForm({ controller }: { controller: ControllerState }) {
  const { agent } = useDemo();
  const schema = controller.configSchema as { properties?: Record<string, JsonSchemaProp> };
  const props = Object.entries(schema.properties ?? {});
  const config = (controller.config ?? {}) as Record<string, unknown>;
  const set = (key: string, value: unknown) =>
    agent.command(AgentCommand.configure, { id: controller.id, config: { [key]: value } });
  if (props.length === 0) return null;
  const isLlm = controller.kind === "llm" && "provider" in (schema.properties ?? {});
  return (
    <div className="flex flex-col gap-3">
      {props.map(([key, p]) => {
        if (isLlm && key === "model")
          return (
            <ModelField
              key={key}
              provider={config.provider as LlmProvider}
              value={String(config.model ?? "")}
              onCommit={(v) => set(key, v)}
            />
          );
        if (isLlm && key === "baseUrl" && config.provider !== "openai-compatible") return null;
        return <Field key={key} name={key} prop={p} value={config[key]} onCommit={(v) => set(key, v)} />;
      })}
    </div>
  );
}

function Field({
  name,
  prop,
  value,
  onCommit,
}: {
  name: string;
  prop: JsonSchemaProp;
  value: unknown;
  onCommit(v: unknown): void;
}) {
  const label = prop.title ?? titleCase(name);
  if (prop.type === "boolean") {
    return (
      <Switch isSelected={Boolean(value)} onChange={onCommit} className="justify-between">
        <Switch.Content className="flex w-full items-center justify-between text-sm">
          {label}
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    );
  }
  if (prop.enum) {
    return (
      <Select value={String(value ?? "")} onChange={(v) => onCommit(v)} variant="secondary">
        <Label>{label}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {prop.enum.map((o) => (
              <ListBox.Item key={o} id={o} textValue={o}>
                {PROVIDER_LABELS[o] ?? titleCase(o)}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    );
  }
  if (
    (prop.type === "number" || prop.type === "integer") &&
    prop.minimum !== undefined &&
    prop.maximum !== undefined &&
    prop.maximum - prop.minimum <= 1000
  ) {
    return (
      <NumberSlider
        label={label}
        prop={prop}
        value={Number(value ?? prop.default ?? prop.minimum)}
        onCommit={onCommit}
      />
    );
  }
  return (
    <TextInput
      label={label}
      secret={prop["x-secret"] === true}
      value={value === undefined ? "" : String(value)}
      numeric={prop.type === "number" || prop.type === "integer"}
      onCommit={onCommit}
    />
  );
}

function NumberSlider({
  label,
  prop,
  value,
  onCommit,
}: {
  label: string;
  prop: JsonSchemaProp;
  value: number;
  onCommit(v: number): void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const range = prop.maximum! - prop.minimum!;
  const step = prop.type === "integer" ? (range > 1000 ? 250 : 1) : range <= 2 ? 0.05 : range <= 20 ? 0.5 : 1;
  return (
    <Slider
      minValue={prop.minimum}
      maxValue={prop.maximum}
      step={step}
      value={local}
      onChange={(v) => setLocal(v as number)}
      onChangeEnd={(v) => onCommit(v as number)}
    >
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Slider.Output className="tnum text-sm text-muted" />
      </div>
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb />
      </Slider.Track>
    </Slider>
  );
}

function TextInput(props: {
  label: string;
  secret: boolean;
  numeric: boolean;
  value: string;
  onCommit(v: unknown): void;
}) {
  const [local, setLocal] = useState(props.value);
  useEffect(() => setLocal(props.value), [props.value]);
  const commit = () => {
    if (local === props.value) return;
    props.onCommit(props.numeric ? Number(local) : local);
  };
  return (
    <TextField value={local} onChange={setLocal} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()}>
      <Label>{props.label}</Label>
      <Input
        variant="secondary"
        type={props.secret ? "password" : "text"}
        placeholder={props.secret ? "Not set" : undefined}
        onFocus={() => props.secret && local === REDACTED && setLocal("")}
      />
    </TextField>
  );
}

function ModelField({
  provider,
  value,
  onCommit,
}: {
  provider: LlmProvider;
  value: string;
  onCommit(v: string): void;
}) {
  const [input, setInput] = useState(value);
  useEffect(() => setInput(value), [value]);
  const options = MODEL_SUGGESTIONS[provider] ?? [];
  return (
    <ComboBox
      allowsCustomValue
      inputValue={input}
      onInputChange={setInput}
      onSelectionChange={(k) => k && onCommit(String(k))}
      onBlur={() => input && input !== value && onCommit(input)}
      menuTrigger="focus"
    >
      <Label>Model</Label>
      <ComboBox.InputGroup>
        <Input variant="secondary" />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover>
        <ListBox>
          {options.map((m) => (
            <ListBox.Item key={m} id={m} textValue={m}>
              {m}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "openai-compatible": "OpenAI-compatible",
};

const RATES = [
  { id: "5", label: "5" },
  { id: "20", label: "20" },
  { id: "60", label: "60" },
  { id: "0", label: "Max" },
];

function TimeControls({ status }: { status: AgentStatus }) {
  const { agent } = useDemo();
  const { paused, rateHz, waiting } = status.clock;
  const flowing = !paused && status.authority !== null;
  return (
    <div className="mt-auto flex flex-col gap-2 px-4 pt-2 pb-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">Time</span>
        <span className="tnum text-xs text-muted">
          Tick {status.tick?.toLocaleString() ?? "—"}
          {paused ? " · Paused" : flowing ? (waiting ? " · Advancing" : "") : " · Held"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <IconButton
          label={paused ? "Run" : "Pause"}
          variant="secondary"
          onPress={() => agent.command(AgentCommand.clockPause, { paused: !paused })}
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </IconButton>
        <IconButton label="Step one tick" variant="secondary" onPress={() => agent.command(AgentCommand.clockStep)}>
          <ArrowChevronRight className="size-4" />
        </IconButton>
        <div className="flex-1" />
        <Segmented
          label="Ticks per second"
          value={String(rateHz)}
          onChange={(k) => agent.command(AgentCommand.clockRate, { hz: Number(k) })}
          options={RATES}
        />
      </div>
    </div>
  );
}
