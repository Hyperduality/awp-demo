import { type Pose, rotate, type Vec3 } from "./math.ts";
import type { PhysicsWorld } from "./world.ts";

/** A pinhole camera looking along its frame's +x, with y left and z up. */
export interface CameraDesc {
  width: number;
  height: number;
  fovY_rad: number;
  maxRange_m: number;
}

export type Rgb = [number, number, number];

export interface Shading {
  /** Albedo per material name, 0..255. Unlisted materials are mid grey. */
  albedo: Record<string, Rgb>;
  /** Unit vector towards the sun. */
  sun: Vec3;
  ambient: number;
  zenith: Rgb;
  horizon: Rgb;
  /** Cast a second ray towards the sun at every hit. Doubles the cost and makes shapes far easier to read. */
  shadows: boolean;
}

export interface CameraFrame {
  /** Distance along the optical axis in metres, row-major from the top-left; 0 where nothing was hit. */
  depth: Float32Array;
  /** Packed rgb8, row-major from the top-left. */
  rgb: Uint8Array;
  /** Which body each pixel's ray hit, as an index into `PhysicsWorld.ids`; -1 for none. */
  bodies: Int16Array;
}

/**
 * Render a depth image and a shaded colour image by casting one ray per pixel through the physics world.
 * It sees exactly the collision geometry, costs no GPU, and is reproducible bit for bit.
 */
export function castCamera(
  pw: PhysicsWorld,
  pose: Pose,
  cam: CameraDesc,
  shading: Shading,
  skipGroup = 0,
): CameraFrame {
  const { width: W, height: H } = cam;
  const depth = new Float32Array(W * H);
  const rgb = new Uint8Array(W * H * 3);
  const bodies = new Int16Array(W * H).fill(-1);
  const tanY = Math.tan(cam.fovY_rad / 2);
  const tanX = (tanY * W) / H;
  const palette = pw.materials.map((m) => shading.albedo[m] ?? ([128, 128, 128] as Rgb));
  const [ox, oy, oz] = pose.p;
  const fwd = rotate(pose.q, [1, 0, 0]);
  const left = rotate(pose.q, [0, 1, 0]);
  const up = rotate(pose.q, [0, 0, 1]);
  const [sx, sy, sz] = shading.sun;

  for (let j = 0; j < H; j++) {
    const v = (1 - (2 * (j + 0.5)) / H) * tanY;
    for (let i = 0; i < W; i++) {
      const u = (1 - (2 * (i + 0.5)) / W) * tanX;
      let dx = fwd[0] + left[0] * u + up[0] * v;
      let dy = fwd[1] + left[1] * u + up[1] * v;
      let dz = fwd[2] + left[2] * u + up[2] * v;
      const inv = 1 / Math.hypot(dx, dy, dz);
      dx *= inv;
      dy *= inv;
      dz *= inv;
      const o = (j * W + i) * 3;
      // Sky: blend horizon to zenith by elevation.
      const k = Math.max(0, Math.min(1, dz * 2.5));
      let r = shading.horizon[0] + (shading.zenith[0] - shading.horizon[0]) * k;
      let g = shading.horizon[1] + (shading.zenith[1] - shading.horizon[1]) * k;
      let b = shading.horizon[2] + (shading.zenith[2] - shading.horizon[2]) * k;
      // The ray is longer than the range along the axis by 1 / inv at the image corners.
      const hit = pw.castRay(ox, oy, oz, dx, dy, dz, cam.maxRange_m / inv, skipGroup);
      if (hit) {
        const toi = hit.toi;
        depth[j * W + i] = toi * inv;
        bodies[j * W + i] = hit.body;
        const c = palette[hit.material] as Rgb;
        let lambert = Math.max(0, hit.nx * sx + hit.ny * sy + hit.nz * sz);
        if (shading.shadows && lambert > 0) {
          const e = 0.02;
          const px = ox + dx * toi + hit.nx * e;
          const py = oy + dy * toi + hit.ny * e;
          const pz = oz + dz * toi + hit.nz * e;
          if (pw.occluded(px, py, pz, sx, sy, sz, 60, skipGroup)) lambert = 0;
        }
        const light = shading.ambient + (1 - shading.ambient) * lambert;
        const fog = Math.min(1, toi / cam.maxRange_m) ** 2 * 0.6;
        r = c[0] * light * (1 - fog) + shading.horizon[0] * fog;
        g = c[1] * light * (1 - fog) + shading.horizon[1] * fog;
        b = c[2] * light * (1 - fog) + shading.horizon[2] * fog;
      }
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  return { depth, rgb, bodies };
}

export interface LidarDesc {
  /** Elevation of each ring, radians above the horizontal. */
  rings_rad: number[];
  /** Rays per ring, evenly spaced from azimuth 0 (forward) turning left. */
  azimuths: number;
  maxRange_m: number;
}

export interface LidarSweep {
  /** The returns only, as float32 xyz triples in the sensor's own frame, ring by ring. */
  points: Float32Array;
  /** Which body each return came off, as an index into `PhysicsWorld.ids`. */
  bodies: Int16Array;
}

/** A spinning lidar: one ray per azimuth on each ring, keeping the ones that hit something in range. */
export function castLidar(pw: PhysicsWorld, pose: Pose, lidar: LidarDesc, skipGroup = 0): LidarSweep {
  const out = new Float32Array(lidar.rings_rad.length * lidar.azimuths * 3);
  const bodies = new Int16Array(lidar.rings_rad.length * lidar.azimuths);
  const [ox, oy, oz] = pose.p;
  let n = 0;
  for (const elevation of lidar.rings_rad) {
    const ce = Math.cos(elevation);
    const se = Math.sin(elevation);
    for (let a = 0; a < lidar.azimuths; a++) {
      const az = (a / lidar.azimuths) * 2 * Math.PI;
      const local: Vec3 = [ce * Math.cos(az), ce * Math.sin(az), se];
      const d = rotate(pose.q, local);
      const hit = pw.castRay(ox, oy, oz, d[0], d[1], d[2], lidar.maxRange_m, skipGroup);
      if (!hit) continue;
      bodies[n / 3] = hit.body;
      out[n++] = local[0] * hit.toi;
      out[n++] = local[1] * hit.toi;
      out[n++] = local[2] * hit.toi;
    }
  }
  return { points: out.slice(0, n), bodies: bodies.slice(0, n / 3) };
}
