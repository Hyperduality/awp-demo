import { clamp, wrapAngle } from "@awp-demo/physics";
import { TRUCK } from "./forklift.ts";
import type { Leg } from "./plan.ts";

export interface Target {
  x: number;
  y: number;
  /** Arrive heading this way, on the straight line through the target. */
  yaw?: number;
  vMax: number;
  /** Drive backwards, tail first. */
  reverse?: boolean;
  /** How close counts as there, metres (default 0.15, or 0.04 along a line). */
  tolerance?: number;
  /** Carrying a load: turn on the spot slowly, or it slides off. */
  gentle?: boolean;
  /** Hold the line closely enough to put forks into a pallet's pockets. */
  precise?: boolean;
  /** A planned route to drive first, each leg forward or in reverse; the target is then close and ahead. */
  route?: Leg[];
}

export interface Kinematic {
  x: number;
  y: number;
  yaw: number;
  v: number;
}

export interface Steer {
  v_mps: number;
  steer_rad: number;
  arrived: boolean;
  remaining_m: number;
}

/** A planned route brings the truck onto a target's line this far before it, already heading along it. */
export const JOIN_M = 2.4;
/** Without a route, it joins the line at least this far before the target. */
const UNPLANNED_JOIN_M = 3;
/** The nearest point it steers at. */
const LOOKAHEAD_M = 1.2;
/** On a planned route it steers at a point this far along it. */
const ROUTE_LOOKAHEAD_M = 1.5;
/** Fixed (front) axle ahead of the chassis origin. */
const AXLE_M = TRUCK.wheelbase_m / 2;
/** Arriving further than this off the line, or this far off its heading, it backs up and comes in again. */
const OFF_LINE_M = 0.07;
const OFF_HEADING_RAD = 0.06;
/** The distance over which the truck settles onto a line it is tracking. */
const SETTLE_M = 0.55;

/**
 * Steers the truck to a point, or to a pose along a straight final approach, by pure pursuit.
 *
 * The truck steers with its rear wheels, so the middle of its front axle is the point that goes where
 * the truck is heading; the tail swings the other way first. Pursuit is done from that point: steering
 * at a point `d` away and `e` off the heading needs the bicycle angle atan(2 L sin(e) / d).
 *
 * It plans nothing itself. Given a route, it drives each leg in the leg's direction, stopping where the
 * direction changes, and then finishes on the target.
 */
export class Follower {
  readonly target: Target;
  private readonly start: number;
  private retries = 2;
  private backing = false;
  private nearest = Infinity;
  private joining: boolean | undefined;
  private leg = 0;
  private corner = 0;

  constructor(target: Target, from: Kinematic) {
    this.target = target;
    this.start = Math.max(0.01, Math.hypot(target.x - from.x, target.y - from.y));
  }

  /** Whether the truck is being driven tail first right now. */
  get reversing(): boolean {
    const leg = this.target.route?.[this.leg];
    return leg ? leg.reverse : this.backing !== !!this.target.reverse;
  }

  /** Share of the straight-line distance covered, 0..1. */
  progress(s: Kinematic): number {
    return clamp(1 - Math.hypot(this.target.x - s.x, this.target.y - s.y) / this.start, 0, 1);
  }

  step(s: Kinematic): Steer {
    const t = this.target;
    const legs = t.route ?? [];
    while (this.leg < legs.length) {
      const leg = legs[this.leg] as Leg;
      const sign = leg.reverse ? -1 : 1;
      const pts = leg.points;
      // Pursuit is done from the front axle going forward, and from the chassis origin backing up.
      const fx = s.x + (leg.reverse ? 0 : Math.cos(s.yaw) * AXLE_M);
      const fy = s.y + (leg.reverse ? 0 : Math.sin(s.yaw) * AXLE_M);
      // Move on along the leg while the next stretch is the nearer one.
      while (this.corner < pts.length - 2 && project(pts, this.corner + 1, fx, fy) > 0) this.corner++;
      let rest = -Math.max(0, project(pts, this.corner, fx, fy));
      for (let i = this.corner; i < pts.length - 1; i++) rest += span(pts, i);
      const last = this.leg === legs.length - 1;
      // The last leg runs straight into the final approach if that goes the same way; otherwise the truck
      // stops at the end of a leg before setting off the other way.
      const flows = last && leg.reverse === !!t.reverse;
      if (rest < (flows ? 0.6 : 0.25)) {
        if (!flows && Math.abs(s.v) > 0.05) return { v_mps: 0, steer_rad: 0, arrived: false, remaining_m: rest };
        this.leg++;
        this.corner = 0;
        continue;
      }
      // Steer at the point a lookahead further along the leg, past its end if it comes to that.
      let reach = Math.max(0, project(pts, this.corner, fx, fy)) + ROUTE_LOOKAHEAD_M;
      let i = this.corner;
      while (i < pts.length - 2 && reach > span(pts, i)) reach -= span(pts, i++);
      const a = pts[i] as [number, number];
      const b = pts[i + 1] as [number, number];
      const len = span(pts, i) || 1e-6;
      const ax = a[0] + ((b[0] - a[0]) / len) * reach;
      const ay = a[1] + ((b[1] - a[1]) / len) * reach;
      let after = 0;
      for (let n = this.leg + 1; n < legs.length; n++) {
        const q = (legs[n] as Leg).points;
        for (let j = 0; j < q.length - 1; j++) after += span(q, j);
      }
      const top = leg.reverse ? Math.min(t.vMax, 1.2) : t.vMax;
      const cruise = flows ? top : Math.min(top, 0.35 + 0.9 * rest);
      return { ...this.pursue(s, ax, ay, sign, cruise, fx, fy), arrived: false, remaining_m: rest + after + JOIN_M };
    }
    return t.yaw === undefined ? this.toPoint(s) : this.alongLine(s, t.yaw);
  }

  private toPoint(s: Kinematic): Steer {
    const t = this.target;
    const sign = t.reverse ? -1 : 1;
    const rho = Math.hypot(t.x - s.x, t.y - s.y);
    // There, or as near as this pass gets: past the closest point, it stops rather than circle.
    if (rho < (t.tolerance ?? 0.15) || (rho < 1 && rho > this.nearest + 0.03))
      return { v_mps: 0, steer_rad: 0, arrived: true, remaining_m: rho };
    this.nearest = Math.min(this.nearest, rho);
    // Aim a little beyond the point, so the chassis origin and not the axle ends up on it.
    const fx = s.x + Math.cos(s.yaw) * AXLE_M;
    const fy = s.y + Math.sin(s.yaw) * AXLE_M;
    const far = Math.hypot(t.x - fx, t.y - fy) || 1;
    const ax = t.x + ((t.x - fx) / far) * sign * AXLE_M * 1.5;
    const ay = t.y + ((t.y - fy) / far) * sign * AXLE_M * 1.5;
    return { ...this.pursue(s, ax, ay, sign, Math.min(t.vMax, 0.3 + 0.9 * rho)), arrived: false, remaining_m: rho };
  }

  private alongLine(s: Kinematic, yaw: number): Steer {
    const t = this.target;
    const sign = t.reverse ? -1 : 1;
    const dx = Math.cos(yaw);
    const dy = Math.sin(yaw);
    // `along`: how far the target is ahead on the line; `cross`: how far the truck is to the line's left.
    const along = ((t.x - s.x) * dx + (t.y - s.y) * dy) * sign;
    const cross = (s.y - t.y) * dx - (s.x - t.x) * dy;
    const heading = wrapAngle(s.yaw - yaw);

    if (this.backing) {
      // Straight back along the line until there is room to come in again.
      if (along >= UNPLANNED_JOIN_M) this.backing = false;
      else {
        const bx = t.x - dx * (along + LOOKAHEAD_M) * sign;
        const by = t.y - dy * (along + LOOKAHEAD_M) * sign;
        return { ...this.pursue(s, bx, by, -sign, 0.7), arrived: false, remaining_m: along };
      }
    }
    // From beside or beyond the target there is no room to line up: go back to the join first.
    this.joining ??= along < UNPLANNED_JOIN_M * 0.8 && Math.abs(cross) > 0.5;
    if (this.joining) {
      const jx = t.x - dx * UNPLANNED_JOIN_M * sign;
      const jy = t.y - dy * UNPLANNED_JOIN_M * sign;
      const rho = Math.hypot(jx - s.x, jy - s.y);
      if (rho < 1.2) this.joining = false;
      else return { ...this.pursue(s, jx, jy, sign, t.vMax), arrived: false, remaining_m: rho + UNPLANNED_JOIN_M };
    }
    if (along <= (t.tolerance ?? 0.04) && Math.abs(cross) < 0.5)
      return { v_mps: 0, steer_rad: 0, arrived: true, remaining_m: Math.max(0, along) };
    const tight = t.precise ? 0.7 : 1;
    const off = Math.abs(cross) > OFF_LINE_M * tight || Math.abs(heading) > OFF_HEADING_RAD * tight;
    if (along < 0.5 && off && this.retries > 0 && !t.reverse) {
      this.retries--;
      this.backing = true;
      return { v_mps: 0, steer_rad: 0, arrived: false, remaining_m: along };
    }

    if (sign < 0 || Math.abs(cross) > 1.2 || Math.abs(heading) > 0.9) {
      // Backing along the line, or still far from it: steer at a point ahead on it, closing at an angle.
      const ahead = along - Math.max(LOOKAHEAD_M, Math.abs(cross) * 0.9);
      const ax = t.x - dx * ahead * sign;
      const ay = t.y - dy * ahead * sign;
      const cruise = Math.min(t.vMax, 0.22 + 0.7 * (along + Math.abs(cross)));
      return { ...this.pursue(s, ax, ay, sign, cruise), arrived: false, remaining_m: along + Math.abs(cross) };
    }
    // On the line, hold it by the front axle, which goes where the truck points. Its offset `e` then
    // obeys e'' = curvature per metre driven, so a curvature of -(2/l) e' - (1/l^2) e brings it in
    // without overshoot, the same at any speed. e' is the sine of the heading error.
    const e = cross + Math.sin(heading) * AXLE_M;
    const curve = -(2 / SETTLE_M) * Math.sin(heading) - e / (SETTLE_M * SETTLE_M);
    const steer = clamp(Math.atan(curve * TRUCK.wheelbase_m), -TRUCK.maxSteer_rad, TRUCK.maxSteer_rad);
    const cruise = Math.min(t.vMax, 0.22 + 0.7 * along) * clamp(1 - Math.abs(steer) * 0.6, 0.35, 1);
    return { v_mps: cruise, steer_rad: steer, arrived: false, remaining_m: along };
  }

  /** Steer the leading end at a point, slowing for sharp turns. `sign` is -1 to drive tail first. */
  private pursue(
    s: Kinematic,
    ax: number,
    ay: number,
    sign: number,
    cruise: number,
    fx = s.x + Math.cos(s.yaw) * AXLE_M,
    fy = s.y + Math.sin(s.yaw) * AXLE_M,
  ): { v_mps: number; steer_rad: number } {
    const d = Math.max(Math.hypot(ax - fx, ay - fy), 0.6);
    const err = wrapAngle(Math.atan2(ay - fy, ax - fx) - (sign > 0 ? s.yaw : s.yaw + Math.PI));
    // Facing well away from the point, it turns nearly on the spot at full lock before setting off.
    const pivot = Math.abs(err) > 0.9;
    const curve = pivot ? Math.sign(err) * 10 : (2 * Math.sin(err)) / d;
    const steer = clamp(Math.atan(sign * curve * TRUCK.wheelbase_m), -TRUCK.maxSteer_rad, TRUCK.maxSteer_rad);
    const speed = pivot
      ? Math.min(cruise, this.target.gentle ? 0.3 : 0.6)
      : cruise * clamp(1 - (Math.abs(steer) / TRUCK.maxSteer_rad) * 0.75, 0.25, 1);
    return { v_mps: speed * sign, steer_rad: steer };
  }
}

/** Length of the stretch of a polyline that starts at point `i`. */
function span(pts: [number, number][], i: number): number {
  const a = pts[i] as [number, number];
  const b = pts[i + 1] as [number, number];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** How far along stretch `i` the point (x, y) projects, from the stretch's start; negative before it. */
function project(pts: [number, number][], i: number, x: number, y: number): number {
  const a = pts[i] as [number, number];
  const b = pts[i + 1] as [number, number];
  const len = span(pts, i) || 1e-6;
  return ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / len;
}
