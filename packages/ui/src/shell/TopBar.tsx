import { type AgentStatus, AgentTopic, type ControllerState } from "@awp-demo/inspector";
import { useConnection, useTopic } from "@awp-demo/inspector/react";
import { ChevronDown, LayoutCellsLarge, LogoGithub, Moon, Sun } from "@gravity-ui/icons";
import { Button, Dropdown, Label, Separator } from "@heroui/react";
import { useDemo } from "../context.tsx";
import { DEMOS, REPO_URL } from "../demos.ts";
import { TONE_CLASS, type Tone } from "../format.ts";
import { IconButton } from "../primitives/IconButton.tsx";
import { useTheme } from "../theme.ts";
import type { PanelDef, WorkspaceApi } from "./Workspace.tsx";

export function TopBar({ panels, api }: { panels: PanelDef[]; api: WorkspaceApi }) {
  const { demo, world, agent } = useDemo();
  const worldConn = useConnection(world);
  const agentConn = useConnection(agent);
  const status = useTopic<AgentStatus>(agent, AgentTopic.status);
  const controllers = useTopic<ControllerState[]>(agent, AgentTopic.controllers) ?? [];
  const theme = useTheme();
  const holder = controllers.find((c) => c.authority);

  const agentState: [string, Tone] =
    agentConn !== "open"
      ? ["Offline", "danger"]
      : status?.connection === "connected"
        ? ["Live", "success"]
        : status?.connection === "suspended"
          ? ["Suspended", "warning"]
          : status?.connection === "error"
            ? ["No world", "warning"]
            : ["Connecting", "muted"];
  const worldState: [string, Tone] =
    worldConn === "open"
      ? ["Live", "success"]
      : worldConn === "connecting"
        ? ["Connecting", "muted"]
        : ["Offline", "danger"];

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="pl-1 font-mono text-sm font-semibold tracking-tight text-foreground">awp</span>
        <span className="text-muted">/</span>
        <Dropdown>
          <Button variant="ghost" size="sm" className="gap-1.5 px-2 font-medium">
            {demo.name}
            <ChevronDown className="size-3.5 text-muted" />
          </Button>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              aria-label="Demos"
              onAction={(key) => {
                const d = DEMOS.find((x) => x.id === key);
                if (d && d.id !== demo.id) window.location.href = d.url;
              }}
            >
              {DEMOS.map((d) => (
                <Dropdown.Item key={d.id} id={d.id} textValue={d.name}>
                  <Label>{d.name}</Label>
                  <span className="text-xs text-muted">{d.blurb}</span>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>

      <div className="flex-1" />

      <div className="hidden items-center gap-4 text-sm md:flex">
        <span className="tnum text-muted">
          {holder ? (
            <>
              <span className="text-foreground">{holder.label}</span> in control
            </>
          ) : (
            "No controller engaged"
          )}
        </span>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-muted">
          World <span className={TONE_CLASS[worldState[1]]}>{worldState[0]}</span>
        </span>
        <span className="text-muted">
          Agent <span className={TONE_CLASS[agentState[1]]}>{agentState[0]}</span>
        </span>
      </div>

      <div className="flex items-center gap-0.5 text-muted">
        <Dropdown>
          <IconButton label="Layout">
            <LayoutCellsLarge className="size-4" />
          </IconButton>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label="Layout"
              onAction={(key) => {
                if (key === "reset") api.reset();
                else if (api.state.minimized.includes(String(key))) api.restore(String(key));
                else api.minimize(String(key));
              }}
            >
              <Dropdown.Section>
                {panels.map((p) => (
                  <Dropdown.Item key={p.id} id={p.id} textValue={p.title}>
                    <Label>{p.title}</Label>
                    <span className="text-xs text-muted">{api.state.minimized.includes(p.id) ? "Hidden" : ""}</span>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
              <Dropdown.Section>
                <Dropdown.Item id="reset" textValue="Reset layout">
                  <Label>Reset Layout</Label>
                </Dropdown.Item>
              </Dropdown.Section>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        <IconButton
          label={theme.resolved === "dark" ? "Light theme" : "Dark theme"}
          onPress={() => theme.set(theme.resolved === "dark" ? "light" : "dark")}
        >
          {theme.resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </IconButton>
        <IconButton label="Source on GitHub" onPress={() => window.open(REPO_URL, "_blank", "noopener")}>
          <LogoGithub className="size-4" />
        </IconButton>
      </div>
    </header>
  );
}
