import type { ControlContext } from "@awp-demo/agent";
import { actionTools, createLlmController, type LlmConfig } from "@awp-demo/agent/llm";
import { tool } from "ai";
import { z } from "zod";
import type { PosePayload, ProgressPayload, RangesPayload, VisionPayload } from "../../shared/maze.ts";
import { followPath, TileMap, tileOf } from "./mapping.ts";

const deg = (r: number) => Math.round((r * 180) / Math.PI);
const side = (b: number) => (Math.abs(b) < 0.05 ? "ahead" : b > 0 ? `${deg(b)}° right` : `${-deg(b)}° left`);

/** What the runner senses, in words and a map of what it has explored. */
function describe(ctx: ControlContext<unknown>, map: TileMap): string {
  const pose = ctx.latest<PosePayload>("pose");
  const ranges = ctx.latest<RangesPayload>("ranges");
  const vision = ctx.latest<VisionPayload>("vision");
  const progress = ctx.latest<ProgressPayload>("progress");
  if (!pose || !ranges) return "No observation yet.";
  const at = (bearing: number) => {
    let best = 0;
    for (let i = 0; i < ranges.bearings_rad.length; i++) {
      if (
        Math.abs(Math.atan2(Math.sin(ranges.bearings_rad[i]! - bearing), Math.cos(ranges.bearings_rad[i]! - bearing))) <
        0.1
      )
        best = ranges.ranges_m[i]!;
    }
    return best.toFixed(1);
  };
  const heading = ((deg(pose.yaw_rad) % 360) + 360) % 360;
  const [tx, ty] = tileOf(pose.x_m, pose.y_m);
  return [
    `You are at tile (${tx}, ${ty}), heading ${heading}° (0 east, 90 south, 180 west, 270 north).`,
    `Open distance: ahead ${at(0)} m, right ${at(Math.PI / 2)} m, behind ${at(Math.PI)} m, left ${at(-Math.PI / 2)} m.`,
    vision && (vision.cores.length > 0 || vision.exit)
      ? `In view: ${[
          ...vision.cores.map((c) => `a core ${c.range_m.toFixed(1)} m ${side(c.bearing_rad)}`),
          ...(vision.exit
            ? [
                `the exit door ${vision.exit.range_m.toFixed(1)} m ${side(vision.exit.bearing_rad)} (${vision.exit.open ? "open" : "locked"})`,
              ]
            : []),
        ].join("; ")}.`
      : "Nothing of note in view.",
    progress
      ? `Cores ${progress.cores_collected} of ${progress.cores_total}; exit ${progress.exit_open ? "open" : "locked"}${progress.escaped ? "; you escaped" : ""}.`
      : "",
    "Map of what you have seen (# wall, . floor, ? unknown, @ you, C core, E exit):",
    map.ascii(pose),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A language model in the maze. It has the world's motion actions and one skill of its own,
 * go_to, which plans over the tiles it has already seen and walks there with those same actions.
 */
export const mazeLlm = (overrides: Partial<Parameters<typeof createLlmController<LlmConfig>>[0]> = {}) =>
  createLlmController({
    description: "A language model with the runner's actions and a go_to skill over the tiles it has mapped.",
    kickoff: () => "Collect every core, then leave through the exit.",
    instructions: () =>
      [
        "You control a runner in a maze through the Agent World Protocol. Tiles are 1 m; x grows east, y grows south.",
        "You see a range scan, what is in your field of view, and a map of the tiles you have explored so far.",
        "Walking over a core collects it. The exit door opens once every core is collected; stand next to it and interact.",
        "Prefer go_to for travel over tiles you have seen; use turn to look around and move to step into the unknown.",
        "Each tool returns the outcome and what you sense afterwards. Keep thinking short. Call finish when you have escaped or cannot continue.",
      ].join("\n"),
    tools: (ctx) => {
      const map = new TileMap(ctx);
      const observe = () => describe(ctx, map);
      return {
        ...actionTools(ctx, {
          types: ["move", "turn", "interact", "stop"],
          observe,
          format: (o) =>
            [
              `${o.action}: ${o.state}${o.detail ? ` (${o.detail})` : o.reason ? ` (${o.reason})` : ""}`,
              o.meanwhile?.length ? `Meanwhile: ${o.meanwhile.join("; ")}` : "",
              String(o.observation),
            ]
              .filter(Boolean)
              .join("\n"),
        }),
        go_to: tool({
          description:
            "Walk to a tile you have already seen, planning a path over explored floor. Issues turn and move actions.",
          inputSchema: z.object({ x: z.number().int(), y: z.number().int() }),
          execute: async ({ x, y }) => {
            const pose = ctx.latest<PosePayload>("pose");
            if (!pose) return "No pose yet.";
            const path = map.path(tileOf(pose.x_m, pose.y_m), [x, y]);
            if (!path) return `No known path to (${x}, ${y}).\n${observe()}`;
            const ok = await followPath(ctx, path).catch(() => false);
            return `${ok ? "Arrived" : "Stopped short"} at (${x}, ${y}).\n${observe()}`;
          },
        }),
        look: tool({
          description: "Describe what you sense now, without moving.",
          inputSchema: z.object({}),
          execute: async () => observe(),
        }),
      };
    },
    ...overrides,
  });

export const llm = mazeLlm();
