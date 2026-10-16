import { type AgentStatus, AgentTopic, type ControllerState } from "@awp-demo/inspector";
import { useConnection, useTopic } from "@awp-demo/inspector/react";
import { ChevronDown, LogoGithub, Moon, Sun, Xmark } from "@gravity-ui/icons";
import { Button, Dropdown, Label, Modal, Separator } from "@heroui/react";
import { useDemo } from "../context.tsx";
import { DEMOS, REPO_URL } from "../demos.ts";
import { TONE_CLASS, type Tone } from "../format.ts";
import { IconButton } from "../primitives/IconButton.tsx";
import { useTheme } from "../theme.ts";
import { type PanelDef, PanelHeader } from "./Workspace.tsx";

/** The demo picker, live status, the buttons for modal panels, and theme and source links. */
export function TopBar({ panels }: { panels: PanelDef[] }) {
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
        {panels.map((p) => (
          <PanelModal key={p.id} panel={p} />
        ))}
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

/** A panel that lives in a dialog, opened from its button in the top bar. */
function PanelModal({ panel }: { panel: PanelDef }) {
  return (
    <Modal>
      <Button variant="ghost" size="sm" className="font-medium">
        {panel.title}
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="lg" scroll="inside">
          {/* The panel's own header and edges, as in the grid, so its contents line up with the title. */}
          <Modal.Dialog className="overflow-hidden p-0">
            <PanelHeader
              title={panel.title}
              heading={
                <Modal.Heading className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {panel.title}
                </Modal.Heading>
              }
              actions={
                <IconButton label="Close" slot="close">
                  <Xmark className="size-3.5" />
                </IconButton>
              }
            />
            <div className="relative h-[min(70vh,640px)] min-h-0 overflow-hidden">{panel.children}</div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
