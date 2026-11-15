/** Right-handed frames, x forward, y left, z up; SI units; quaternions are [x, y, z, w]. */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface Pose {
  p: Vec3;
  q: Quat;
}

export const QID: Quat = [0, 0, 0, 1];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}

export function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function qAxisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function qYaw(yaw: number): Quat {
  return [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Heading about +z, in (-pi, pi]. */
export function yawOf(q: Quat): number {
  return Math.atan2(2 * (q[3] * q[2] + q[0] * q[1]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
}

/** The z component of the body's up axis: 1 upright, 0 on its side. */
export function upZ(q: Quat): number {
  return 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
}

/** A point in a child frame, expressed in the parent frame. */
export function transform(parent: Pose, p: Vec3): Vec3 {
  return add(parent.p, rotate(parent.q, p));
}

export function compose(parent: Pose, child: Pose): Pose {
  return { p: transform(parent, child.p), q: qMul(parent.q, child.q) };
}

/** A world point expressed in the frame `pose`. */
export function toLocal(pose: Pose, p: Vec3): Vec3 {
  return rotate(qConj(pose.q), sub(p, pose.p));
}

export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Move `x` towards `target` by at most `step`. */
export function approach(x: number, target: number, step: number): number {
  return x < target ? Math.min(target, x + step) : Math.max(target, x - step);
}
