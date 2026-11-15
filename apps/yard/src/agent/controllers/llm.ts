import { createLlmSupervisor, LlmConfig, type SupervisorOptions } from "@awp-demo/agent/llm";
import type { TaskObs } from "../../shared/yard.ts";
import { basisOf, readYard, renderYard } from "./observe.ts";

const INSTRUCTIONS = [
  "You operate a forklift in a freight yard. Your job is the list of orders: each names a pallet and the bay it belongs in. Everything here is a rigid body under physics: loads slide off a pallet that is thrown about, a truck driven into things knocks them over, and a truck that tips is finished.",
  "You know the yard only through the truck. Its site map gives what is built here: the buildings, the containers, the trailer, the bays, and the receiving pad where incoming pallets are set down. Everything that can move (pallets, drums, cones) you know only once the truck's camera or lidar has picked it out. The lidar sees all round to about 20 m; the camera sees further, but only ahead. Neither sees through a container or round a corner. The view lists what is in sight now and what you saw earlier; something you saw earlier may have moved. What the operator tells you about where things are, you may also go on.",
  "The world frame has x pointing east and y pointing north, in metres; yaw is in radians from east, turning towards north. The yard runs from x -24 to 24 and y -16 to 16.",
  "If a pallet you need is not seen yet, go and look: drive_to a point with a view of where it is likely to be, facing it, and read the view again. pick_pallet needs the truck to have seen the pallet, and fails with reason `x-yard.unseen` if it has not, or if the pallet is no longer where it was.",
  "pick_pallet takes a pallet id and does the whole pickup: it lines up with the fork pockets, drives in, lifts, and backs out. place_pallet takes a bay id (or x_m, y_m and yaw_rad for a spot on the ground) and does the whole put-down, raising the forks for the trailer by itself. Both plan a route around the site map and what the truck has seen. drive_to goes to a point the same way, arriving heading yaw_rad if you give one. set_forks raises or lowers the forks. stop halts the truck. cancel stops an action by its id.",
  "One action drives the truck at a time: a new drive_to, pick_pallet or place_pallet replaces the one running. So start one, wait to hear how it ended, then start the next. An action can fail: `x-yard.blocked` means something is in the way or there is no clear route, `x-yard.overload` means the load is more than the hoist can lift (about 2.4 tonnes), `x-yard.missed` means the forks came up empty. Read the reason and decide: try again, look again, clear the way, or leave that order and say so.",
  "Work through the orders one at a time. Do not pick up a pallet that is not in an order. When every order is delivered, say so and stop.",
].join("\n");

const lines = (t: TaskObs | undefined) => t?.log ?? [];

export const yardLlm = (overrides: Partial<SupervisorOptions<LlmConfig>> = {}) =>
  createLlmSupervisor<LlmConfig>({
    description:
      "A language model at the controls. It knows the site map and what the truck's sensors have seen, goes looking for what it has not, and works through the orders with the truck's pallet skills.",
    config: LlmConfig,
    kickoff: () => "You are on shift. Find the ordered pallets and deliver them.",
    instructions: () => INSTRUCTIONS,
    observe: (ctx) => {
      const yard = readYard(ctx);
      return { text: yard ? renderYard(yard) : "No observation yet.", basis: basisOf(ctx) };
    },
    actions: { types: ["pick_pallet", "place_pallet", "drive_to", "set_forks", "stop"] },
    // What the yard's log says that the model should hear: spills and impacts wake it, the rest can wait.
    news: (channel, payload, previous) => {
      if (channel !== "task") return [];
      const before = new Set(lines(previous as TaskObs | undefined));
      return lines(payload as TaskObs).filter((l) => !before.has(l) && /fell|impact|tipped|stalled/.test(l));
    },
    notes: (channel, payload, previous) => {
      if (channel !== "task") return [];
      const before = new Set(lines(previous as TaskObs | undefined));
      return lines(payload as TaskObs).filter((l) => !before.has(l) && !/fell|impact|tipped|stalled/.test(l));
    },
    // The work is a chain of steps, each waiting on the last: the model is woken when its own action ends.
    wakeOnCompletion: true,
    keepTurns: 8,
    validForMs: 4000,
    ...overrides,
  });

export const llm = yardLlm();
