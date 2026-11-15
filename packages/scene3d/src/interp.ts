/** Seven float32 per body: position then quaternion [x, y, z, w]. */
const STRIDE = 7;

interface Snapshot {
  t_ms: number;
  poses: Float32Array;
}

/**
 * Smooths pose snapshots that arrive unevenly over a socket. It draws the world a little in the past,
 * between the two snapshots either side of that moment, so motion stays even when a frame is late.
 */
export class PoseBuffer {
  private readonly snaps: Snapshot[] = [];
  private offset = -Infinity;
  private readonly delay_ms: number;

  constructor(delay_ms = 50) {
    this.delay_ms = delay_ms;
  }

  clear(): void {
    this.snaps.length = 0;
    this.offset = -Infinity;
  }

  /** `t_ms` is the sim's own clock. A snapshot older than the last one means the world was reset. */
  push(t_ms: number, poses: Float32Array, now_ms: number): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && (t_ms < last.t_ms || poses.length !== last.poses.length)) this.clear();
    if (last && t_ms === last.t_ms) return;
    this.snaps.push({ t_ms, poses });
    if (this.snaps.length > 8) this.snaps.shift();
    // Track the sim clock against ours by its freshest arrival, easing back if the sim runs slow.
    this.offset = Math.max(this.offset - 0.05, t_ms - now_ms);
  }

  /** Write the poses for now into `out`. Returns false until there is something to draw. */
  sample(now_ms: number, out: Float32Array): boolean {
    const n = this.snaps.length;
    if (n === 0) return false;
    const t = now_ms + this.offset - this.delay_ms;
    let b = this.snaps[n - 1] as Snapshot;
    let a = b;
    for (let i = n - 1; i >= 0; i--) {
      const s = this.snaps[i] as Snapshot;
      if (s.t_ms <= t) {
        a = s;
        b = this.snaps[Math.min(i + 1, n - 1)] as Snapshot;
        break;
      }
      a = s;
      b = s;
    }
    if (out.length !== b.poses.length) return false;
    const span = b.t_ms - a.t_ms;
    const k = span > 0 ? Math.min(1, Math.max(0, (t - a.t_ms) / span)) : 1;
    const p = a.poses;
    const q = b.poses;
    for (let o = 0; o < out.length; o += STRIDE) {
      for (let i = 0; i < 3; i++) out[o + i] = (p[o + i] as number) + ((q[o + i] as number) - (p[o + i] as number)) * k;
      // Shortest-arc blend of the quaternions, renormalised.
      let dot = 0;
      for (let i = 3; i < 7; i++) dot += (p[o + i] as number) * (q[o + i] as number);
      const sign = dot < 0 ? -1 : 1;
      let len = 0;
      for (let i = 3; i < 7; i++) {
        const v = (p[o + i] as number) + ((q[o + i] as number) * sign - (p[o + i] as number)) * k;
        out[o + i] = v;
        len += v * v;
      }
      len = Math.sqrt(len) || 1;
      for (let i = 3; i < 7; i++) out[o + i] = (out[o + i] as number) / len;
    }
    return true;
  }
}
