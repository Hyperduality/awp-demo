import type { LayoutBody, Shape } from "@awp-demo/physics/scene";
import { BoxGeometry, type BufferGeometry, ConeGeometry, CylinderGeometry, Quaternion } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

type Part = LayoutBody["parts"][number];

/** A part's mesh in its own frame, with texture coordinates in metres over `tile_m` so textures keep their scale. */
function shapeGeometry(shape: Shape, tile_m: number): BufferGeometry {
  if (shape.kind === "box") {
    const [hx, hy, hz] = shape.half;
    const g = new BoxGeometry(hx * 2, hy * 2, hz * 2);
    // Faces come in the order +x, -x, +y, -y, +z, -z, four corners each.
    const spans: [number, number][] = [
      [hz * 2, hy * 2],
      [hz * 2, hy * 2],
      [hx * 2, hz * 2],
      [hx * 2, hz * 2],
      [hx * 2, hy * 2],
      [hx * 2, hy * 2],
    ];
    const uv = g.attributes.uv;
    if (uv) {
      for (let i = 0; i < uv.count; i++) {
        const [su, sv] = spans[Math.floor(i / 4)] as [number, number];
        uv.setXY(i, (uv.getX(i) * su) / tile_m, (uv.getY(i) * sv) / tile_m);
      }
    }
    return g;
  }
  const g =
    shape.kind === "cone"
      ? new ConeGeometry(shape.radius, shape.halfHeight * 2, 24)
      : new CylinderGeometry(shape.radius, shape.radius, shape.halfHeight * 2, 32);
  const uv = g.attributes.uv;
  if (uv) {
    const around = (2 * Math.PI * shape.radius) / tile_m;
    const up = (shape.halfHeight * 2) / tile_m;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, uv.getY(i) * up);
  }
  return g;
}

function partGeometry(part: Part, tile_m: number): BufferGeometry {
  const g = shapeGeometry(part.shape, tile_m);
  g.applyQuaternion(new Quaternion(part.rot[0], part.rot[1], part.rot[2], part.rot[3]));
  g.translate(part.at[0], part.at[1], part.at[2]);
  return g;
}

/** One merged geometry per material for a body, in the body's frame: a body costs a draw per material, not per part. */
export function bodyGeometries(body: LayoutBody, tileOf: (material: string) => number): Map<string, BufferGeometry> {
  const byMaterial = new Map<string, BufferGeometry[]>();
  for (const part of body.parts) {
    const list = byMaterial.get(part.material) ?? [];
    list.push(partGeometry(part, tileOf(part.material)));
    byMaterial.set(part.material, list);
  }
  const out = new Map<string, BufferGeometry>();
  for (const [material, list] of byMaterial) {
    const merged = list.length === 1 ? (list[0] as BufferGeometry) : mergeGeometries(list, false);
    if (merged) out.set(material, merged);
    if (list.length > 1) for (const g of list) g.dispose();
  }
  return out;
}
