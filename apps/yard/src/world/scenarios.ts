import { type BodyDesc, type PartDesc, qAxisAngle, qYaw, type Vec3 } from "@awp-demo/physics";
import { type Bay, BOUNDS } from "../shared/yard.ts";

const X90 = qAxisAngle([1, 0, 0], Math.PI / 2);

export const PALLET = { length_m: 1.2, width_m: 1, height_m: 0.144, mass_kg: 25 } as const;
export const TRAILER_DECK_M = 1.25;

const box = (half: Vec3, at: Vec3, material: string, extra: Partial<PartDesc> = {}): PartDesc => ({
  shape: { kind: "box", half },
  at,
  material,
  ...extra,
});

/** A pallet with real fork pockets: the forks go in along its x axis, from either end. Origin at the bottom centre. */
export function pallet(id: string, p: Vec3, yaw: number): BodyDesc {
  const wood = { friction: 0.7 };
  return {
    id,
    kind: "dynamic",
    type: "pallet",
    p,
    q: qYaw(yaw),
    extraSolverIterations: 4,
    parts: [
      box([0.6, 0.5, 0.011], [0, 0, 0.133], "pallet_wood", { ...wood, mass_kg: 9 }),
      ...[-0.45, 0, 0.45].map((y) => box([0.6, 0.05, 0.05], [0, y, 0.072], "pallet_wood", { ...wood, mass_kg: 4 })),
      ...[-0.55, 0, 0.55].map((x) =>
        box([0.05, 0.5, 0.011], [x, 0, 0.011], "pallet_wood", { ...wood, mass_kg: 4 / 3 }),
      ),
    ],
  };
}

export type LoadKind = "crate" | "stack" | "cartons" | "barrels" | "block";

export const LOAD_LABEL: Record<LoadKind, string> = {
  crate: "a 400 kg crate",
  stack: "two stacked crates, 500 kg",
  cartons: "eight cartons, 240 kg",
  barrels: "four drums, 720 kg",
  block: "a 3.2 t concrete block",
};

/** The loose bodies that make up one load, resting on a pallet at `p` (its bottom centre). */
export function load(kind: LoadKind, id: string, p: Vec3, yaw: number): BodyDesc[] {
  const q = qYaw(yaw);
  const top = p[2] + PALLET.height_m;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (x: number, y: number, z: number): Vec3 => [p[0] + c * x - s * y, p[1] + s * x + c * y, top + z];
  const item = (n: number, type: string, pos: Vec3, part: PartDesc, rot = q): BodyDesc => ({
    id: `${id}_${n}`,
    kind: "dynamic",
    type,
    p: pos,
    q: rot,
    extraSolverIterations: 4,
    parts: [part],
  });
  switch (kind) {
    case "crate":
      return [item(1, "crate", at(0, 0, 0.4), box([0.5, 0.4, 0.4], [0, 0, 0], "crate_plywood", { mass_kg: 400 }))];
    case "stack":
      return [
        item(1, "crate", at(0, 0, 0.3), box([0.5, 0.42, 0.3], [0, 0, 0], "crate_plywood", { mass_kg: 300 })),
        item(2, "crate", at(0, 0, 0.85), box([0.45, 0.38, 0.25], [0, 0, 0], "crate_pine", { mass_kg: 200 })),
      ];
    case "cartons": {
      const out: BodyDesc[] = [];
      let n = 1;
      for (const z of [0.2, 0.6])
        for (const x of [-0.27, 0.27])
          for (const y of [-0.22, 0.22])
            out.push(
              item(
                n++,
                "carton",
                at(x, y, z),
                box([0.26, 0.21, 0.2], [0, 0, 0], "carton", { mass_kg: 30, friction: 0.5 }),
              ),
            );
      return out;
    }
    case "barrels": {
      const out: BodyDesc[] = [];
      let n = 1;
      for (const x of [-0.3, 0.3])
        for (const y of [-0.25, 0.25])
          out.push(
            item(n++, "drum", at(x, y, 0.44), {
              shape: { kind: "cylinder", halfHeight: 0.44, radius: 0.24 },
              rot: X90,
              material: n % 2 ? "drum_blue" : "drum_red",
              mass_kg: 180,
              friction: 0.5,
            }),
          );
      return out;
    }
    case "block":
      return [
        item(
          1,
          "block",
          at(0, 0, 0.35),
          box([0.55, 0.45, 0.35], [0, 0, 0], "concrete", { mass_kg: 3200, friction: 0.8 }),
        ),
      ];
  }
}

export const BAYS: Bay[] = [
  { id: "bay_a", label: "Bay A", p_m: [14, -9, 0], yaw_rad: 0, size_m: [1.8, 1.6] },
  { id: "bay_b", label: "Bay B", p_m: [14, -6, 0], yaw_rad: 0, size_m: [1.8, 1.6] },
  { id: "bay_c", label: "Bay C", p_m: [14, -3, 0], yaw_rad: 0, size_m: [1.8, 1.6] },
  {
    id: "trailer_1",
    label: "Trailer slot 1",
    p_m: [13.2, 8.66, TRAILER_DECK_M],
    yaw_rad: Math.PI / 2,
    size_m: [1.5, 1.6],
  },
  {
    id: "trailer_2",
    label: "Trailer slot 2",
    p_m: [15, 8.66, TRAILER_DECK_M],
    yaw_rad: Math.PI / 2,
    size_m: [1.5, 1.6],
  },
  {
    id: "trailer_3",
    label: "Trailer slot 3",
    p_m: [16.8, 8.66, TRAILER_DECK_M],
    yaw_rad: Math.PI / 2,
    size_m: [1.5, 1.6],
  },
];

/** The pad where incoming pallets are set down: on the site map, though what stands on it is not. */
export const RECEIVING_PAD = {
  id: "receiving_pad",
  label: "Receiving pad",
  p_m: [-12.6, 0, 0] as Vec3,
  size_m: [6.4, 21] as [number, number],
};

/** Where the receiving area's pallets stand. */
export const RECEIVING: { p: Vec3; yaw: number }[] = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5].map((y) => ({
  p: [-12, y, 0.002],
  yaw: 0,
}));

const CONTAINER: Vec3 = [3.03, 1.22, 1.295];

/** Everything that never moves: the floor, the walls, the trailer, the containers. */
export function yardStatics(): BodyDesc[] {
  const [x0, y0] = BOUNDS.min;
  const [x1, y1] = BOUNDS.max;
  const fixed = (id: string, type: string, p: Vec3, parts: PartDesc[], yaw = 0): BodyDesc => ({
    id,
    kind: "fixed",
    type,
    p,
    q: qYaw(yaw),
    parts,
  });
  const wall = (id: string, p: Vec3, half: Vec3) =>
    fixed(id, "wall", p, [box(half, [0, 0, 0], "concrete", { friction: 0.8 })]);
  const container = (id: string, p: Vec3, yaw: number, material: string) =>
    fixed(id, "container", p, [box(CONTAINER, [0, 0, 0], material, { friction: 0.6 })], yaw);
  const lamp = (id: string, x: number, y: number) =>
    fixed(
      id,
      "lamp",
      [x, y, 0],
      [
        { shape: { kind: "cylinder", halfHeight: 3.5, radius: 0.08 }, at: [0, 0, 3.5], rot: X90, material: "pole" },
        box([0.5, 0.12, 0.05], [x > 0 ? -0.45 : 0.45, 0, 7], "pole", { visual: true }),
        box([0.22, 0.1, 0.02], [x > 0 ? -0.75 : 0.75, 0, 6.94], "lamp", { visual: true }),
      ],
    );
  return [
    fixed(
      "ground",
      "ground",
      [0, 0, 0],
      [
        box([(x1 - x0) / 2 + 12, (y1 - y0) / 2 + 12, 0.5], [0, 0, -0.5], "asphalt", { friction: 0.9 }),
        // The loading apron by the bays and the receiving pad are poured concrete.
        box([4, 9, 0.004], [14.5, -1.5, 0.004], "apron", { visual: true }),
        box([3.2, 10.5, 0.004], [-12.6, 0, 0.004], "apron", { visual: true }),
      ],
    ),
    wall("wall_n", [0, y1 + 0.2, 0.45], [(x1 - x0) / 2 + 0.4, 0.2, 0.45]),
    wall("wall_s", [0, y0 - 0.2, 0.45], [(x1 - x0) / 2 + 0.4, 0.2, 0.45]),
    wall("wall_e", [x1 + 0.2, 0, 0.45], [0.2, (y1 - y0) / 2, 0.45]),
    fixed(
      "warehouse",
      "building",
      [x0 - 3, 0, 0],
      [
        box([3, (y1 - y0) / 2 + 0.4, 4], [0, 0, 4], "cladding", { friction: 0.6 }),
        box([0.06, 2.2, 1.9], [3.0, -6, 1.9], "door", { visual: true }),
        box([0.06, 2.2, 1.9], [3.0, 6, 1.9], "door", { visual: true }),
        box([3.05, (y1 - y0) / 2 + 0.45, 0.12], [0, 0, 8.1], "truck_frame", { visual: true }),
      ],
    ),
    fixed(
      "trailer",
      "trailer",
      [15, 9.25, 0],
      [
        box([3.5, 1.25, 0.08], [0, 0, TRAILER_DECK_M - 0.08], "trailer_deck", { friction: 0.7 }),
        box([3.2, 0.45, 0.2], [0, 0.3, 0.9], "truck_frame"),
        box([0.06, 1.25, 0.6], [3.44, 0, TRAILER_DECK_M + 0.6], "trailer_steel"),
        ...[-2.2, -1.3].flatMap((x): PartDesc[] =>
          [-0.5, 1.05].map((y) => ({
            shape: { kind: "cylinder", halfHeight: 0.14, radius: 0.5 },
            at: [x, y, 0.5],
            material: "truck_tyre",
            visual: true,
          })),
        ),
        box([0.06, 0.06, 0.45], [2.6, 0.9, 0.45], "truck_frame", { visual: true }),
        box([0.06, 0.06, 0.45], [2.6, -0.3, 0.45], "truck_frame", { visual: true }),
      ],
    ),
    container("container_1", [-14, 13.4, CONTAINER[2]], 0, "container_blue"),
    container("container_2", [-7.6, 13.4, CONTAINER[2]], 0, "container_rust"),
    container("container_3", [-10.8, 13.4, CONTAINER[2] * 3], 0, "container_green"),
    container("container_4", [2, 13.4, CONTAINER[2]], 0, "container_green"),
    container("container_5", [-4, -13.4, CONTAINER[2]], 0, "container_rust"),
    container("container_6", [3, -13.2, CONTAINER[2]], 0.06, "container_blue"),
    container("container_7", [21.5, 2, CONTAINER[2]], Math.PI / 2, "container_blue"),
    lamp("lamp_1", x0 + 1.2, y0 + 1.2),
    lamp("lamp_2", x0 + 1.2, y1 - 1.2),
    lamp("lamp_3", x1 - 1.2, y0 + 1.2),
    lamp("lamp_4", x1 - 1.2, y1 - 1.2),
    ...[-10.5, -7.5, -4.5, -1.5].map((y, i) =>
      fixed(
        `bollard_${i + 1}`,
        "bollard",
        [16.4, y, 0],
        [
          {
            shape: { kind: "cylinder", halfHeight: 0.45, radius: 0.09 },
            at: [0, 0, 0.45],
            rot: X90,
            material: "bollard",
            friction: 0.5,
          },
        ],
      ),
    ),
  ];
}

/** Loose scenery: cones around the trailer, a few empty drums, a spare pallet stack. */
export function yardProps(rand: () => number): BodyDesc[] {
  const jitter = (v: number, by: number) => v + (rand() - 0.5) * by;
  const cone = (i: number, x: number, y: number): BodyDesc => ({
    id: `cone_${i}`,
    kind: "dynamic",
    type: "cone",
    p: [jitter(x, 0.2), jitter(y, 0.2), 0.005],
    parts: [
      box([0.18, 0.18, 0.015], [0, 0, 0.015], "cone_base", { mass_kg: 1.5, friction: 0.8 }),
      {
        shape: { kind: "cone", halfHeight: 0.3, radius: 0.13 },
        at: [0, 0, 0.33],
        rot: X90,
        material: "cone",
        mass_kg: 1.5,
      },
    ],
  });
  const drum = (i: number, x: number, y: number): BodyDesc => ({
    id: `drum_${i}`,
    kind: "dynamic",
    type: "drum",
    p: [jitter(x, 0.1), jitter(y, 0.1), 0.445],
    parts: [
      {
        shape: { kind: "cylinder", halfHeight: 0.44, radius: 0.29 },
        rot: X90,
        material: i % 2 ? "drum_blue" : "drum_red",
        mass_kg: 18,
        friction: 0.5,
      },
    ],
  });
  const out: BodyDesc[] = [
    cone(1, 10.9, 7.2),
    cone(2, 19.1, 7.2),
    cone(3, 15.7, -11.4),
    cone(4, 15.7, -0.6),
    cone(5, -9.6, -10.8),
    cone(6, -9.6, 10.8),
    drum(1, 6.2, 12.6),
    drum(2, 6.9, 12.9),
    drum(3, 6.5, 12),
    drum(4, 7.4, 12.3),
  ];
  for (let i = 0; i < 5; i++)
    out.push(pallet(`spare_${i + 1}`, [-17.5, -11.5, 0.002 + i * (PALLET.height_m + 0.002)], jitter(0, 0.08)));
  return out;
}
