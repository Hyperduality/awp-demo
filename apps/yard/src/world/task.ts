import type { Order, TaskObs } from "../shared/yard.ts";

export interface PalletInfo {
  id: string;
  label: string;
  /** The loose bodies that started on it. */
  items: string[];
}

/** What the task asks of the world each step: only facts, no physics. */
export interface TaskProbe {
  carrying: string | null;
  /** The bay a pallet rests in with the forks clear of it, if any. */
  restingIn(pallet: string): string | null;
  /** How many of a pallet's items are still on it. */
  itemsOn(pallet: string): number;
  tipped: boolean;
  stalled: boolean;
}

const LOG_LINES = 10;

/**
 * The yard's work for one run: orders to move pallets into bays, a score, and a short log. A delivery
 * scores 100 scaled by how much of the load arrived on the pallet; every item that fell off any pallet
 * costs 5, and tipping the truck ends the run.
 */
export class Task {
  readonly orders: Order[];
  private readonly pallets: Map<string, PalletInfo>;
  private readonly bayLabel: Map<string, string>;
  private readonly log: string[] = [];
  private readonly lost = new Map<string, number>();
  private elapsed = 0;
  private phase: TaskObs["phase"] = "working";
  private wasStalled = false;
  private wasCarrying: string | null = null;
  private readonly announced = new Set<string>();
  private readonly heardByTruck = new Set<string>();

  constructor(pallets: PalletInfo[], orders: { pallet: string; bay: string }[], bays: { id: string; label: string }[]) {
    this.pallets = new Map(pallets.map((p) => [p.id, p]));
    this.bayLabel = new Map(bays.map((b) => [b.id, b.label]));
    this.orders = orders.map((o) => ({ ...o, status: "waiting", intact: 1 }));
    for (const p of pallets) this.lost.set(p.id, 0);
  }

  note(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_LINES) this.log.shift();
  }

  update(dt_s: number, probe: TaskProbe): void {
    if (this.phase === "working") this.elapsed += dt_s;

    if (probe.carrying !== this.wasCarrying) {
      if (probe.carrying) this.note(`Picked up ${this.name(probe.carrying)}`);
      this.wasCarrying = probe.carrying;
    }
    if (probe.stalled && !this.wasStalled) this.note("The hoist stalled: the load is more than it can lift");
    this.wasStalled = probe.stalled;

    for (const [id, info] of this.pallets) {
      const lost = info.items.length - probe.itemsOn(id);
      const before = this.lost.get(id) ?? 0;
      if (lost > before) {
        const line = `${lost - before === 1 ? "An item" : `${lost - before} items`} fell off ${this.name(id)}`;
        this.note(line);
        // The load cell feels what leaves the forks; nothing tells the truck about any other pallet.
        if (probe.carrying === id) this.heardByTruck.add(line);
      }
      // Putting a fallen item back is allowed, but the count of spills only goes up.
      if (lost > before) this.lost.set(id, lost);
    }

    for (const o of this.orders) {
      const info = this.pallets.get(o.pallet);
      const total = info?.items.length ?? 0;
      o.intact = total === 0 ? 1 : probe.itemsOn(o.pallet) / total;
      const was = o.status;
      const bay = probe.restingIn(o.pallet);
      o.status = bay === o.bay ? "delivered" : probe.carrying === o.pallet ? "carried" : "waiting";
      if (o.status === "delivered" && was !== "delivered" && !this.announced.has(o.pallet)) {
        this.announced.add(o.pallet);
        const how = o.intact === 1 ? "load intact" : `${Math.round(o.intact * 100)}% of its load`;
        this.note(`Delivered ${this.name(o.pallet)} to ${this.bayLabel.get(o.bay) ?? o.bay}, ${how}`);
      }
    }

    if (this.phase === "working") {
      if (probe.tipped) {
        this.phase = "failed";
        this.note("The truck tipped over");
      } else if (this.orders.length > 0 && this.orders.every((o) => o.status === "delivered")) {
        this.phase = "done";
        this.note(`All ${this.orders.length} orders delivered in ${Math.round(this.elapsed)} s`);
      }
    }
  }

  score(): number {
    let s = 0;
    for (const o of this.orders) if (o.status === "delivered") s += Math.round(100 * o.intact);
    for (const lost of this.lost.values()) s -= 5 * lost;
    if (this.phase === "failed") s -= 100;
    return s;
  }

  /**
   * The task as the agent hears it: the orders, which are done, and a log of what the truck itself could
   * tell. How much of a load is left, and anything falling off a pallet the truck is not carrying, is
   * for its sensors to find out, so the score and those lines are left out.
   */
  observe(): TaskObs {
    const view = this.view();
    return {
      ...view,
      score: view.orders.filter((o) => o.status === "delivered").length * 100,
      orders: view.orders.map((o) => ({ ...o, intact: 1 })),
      log: view.log.filter((l) => !/fell off/.test(l) || this.heardByTruck.has(l)),
    };
  }

  /** The task in full, for the UI. */
  view(): TaskObs {
    return {
      phase: this.phase,
      score: this.score(),
      elapsed_s: Math.round(this.elapsed * 10) / 10,
      orders: this.orders.map((o) => ({
        ...o,
        intact: Math.round(o.intact * 100) / 100,
        pallet_label: this.name(o.pallet),
        bay_label: this.bayLabel.get(o.bay) ?? o.bay,
      })),
      log: [...this.log],
    };
  }

  private name(pallet: string): string {
    return this.pallets.get(pallet)?.label ?? pallet;
  }
}
