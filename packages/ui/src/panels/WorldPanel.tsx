import { WorldCommand, type WorldState, WorldTopic } from "@awp-demo/inspector";
import { useTopic } from "@awp-demo/inspector/react";
import { ArrowRotateLeft } from "@gravity-ui/icons";
import { Button } from "@heroui/react";
import { useDemo } from "../context.tsx";
import { IconButton } from "../primitives/IconButton.tsx";

/** Header actions for a world panel: reset, and the operator's e-stop. */
export function WorldActions() {
  const { world } = useDemo();
  const state = useTopic<WorldState>(world, WorldTopic.world);
  const engaged = state?.eStop === true;
  return (
    <>
      <IconButton label="Reset world" onPress={() => world.command(WorldCommand.reset)}>
        <ArrowRotateLeft className="size-3.5" />
      </IconButton>
      <Button
        size="sm"
        variant={engaged ? "danger" : "danger-soft"}
        onPress={() => world.command(engaged ? WorldCommand.estopRelease : WorldCommand.estopEngage)}
      >
        {engaged ? "Release E-stop" : "E-stop"}
      </Button>
    </>
  );
}
