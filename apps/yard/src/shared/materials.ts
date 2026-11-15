/**
 * Every surface in the yard, by the name its parts carry. The world's raycast camera shades with `color`;
 * the renderer uses the rest, and `map` names a texture set when one is loaded.
 */
export interface Material {
  /** sRGB, 0..255. */
  color: [number, number, number];
  roughness: number;
  metalness: number;
  /** A texture set under `assets/textures/<map>/`, tiled every `tile_m` metres. */
  map?: string;
  tile_m?: number;
  /** Paint the set this material's colour, keeping only its light and dark: one photograph, many liveries. */
  tinted?: boolean;
  /** Emitted light, as a multiple of the colour. */
  emissive?: number;
}

export const MATERIALS: Record<string, Material> = {
  asphalt: { color: [62, 63, 66], roughness: 0.95, metalness: 0, map: "asphalt", tile_m: 3 },
  apron: { color: [150, 148, 142], roughness: 0.85, metalness: 0, map: "concrete", tile_m: 3 },
  concrete: { color: [158, 156, 150], roughness: 0.9, metalness: 0, map: "concrete", tile_m: 2.5 },
  cladding: { color: [176, 184, 190], roughness: 0.55, metalness: 0.6, map: "corrugated", tile_m: 2 },
  door: { color: [70, 92, 112], roughness: 0.6, metalness: 0.5, map: "corrugated", tile_m: 1.2, tinted: true },
  container_blue: {
    color: [38, 82, 140],
    roughness: 0.6,
    metalness: 0.45,
    map: "container",
    tile_m: 2.6,
    tinted: true,
  },
  container_rust: {
    color: [150, 66, 40],
    roughness: 0.7,
    metalness: 0.35,
    map: "container",
    tile_m: 2.6,
    tinted: true,
  },
  container_green: {
    color: [44, 110, 84],
    roughness: 0.6,
    metalness: 0.45,
    map: "container",
    tile_m: 2.6,
    tinted: true,
  },
  trailer_deck: { color: [120, 92, 62], roughness: 0.85, metalness: 0, map: "planks", tile_m: 2 },
  trailer_steel: { color: [170, 30, 34], roughness: 0.5, metalness: 0.5 },
  pallet_wood: { color: [186, 150, 104], roughness: 0.85, metalness: 0, map: "planks", tile_m: 1.4, tinted: true },
  crate_plywood: { color: [196, 164, 116], roughness: 0.8, metalness: 0, map: "plywood", tile_m: 1 },
  crate_pine: { color: [170, 134, 88], roughness: 0.8, metalness: 0, map: "plywood", tile_m: 0.8, tinted: true },
  carton: { color: [176, 136, 92], roughness: 0.9, metalness: 0 },
  drum_blue: { color: [30, 76, 150], roughness: 0.45, metalness: 0.6 },
  drum_red: { color: [168, 40, 34], roughness: 0.45, metalness: 0.6 },
  cone: { color: [236, 96, 20], roughness: 0.6, metalness: 0 },
  cone_base: { color: [28, 28, 30], roughness: 0.9, metalness: 0 },
  bollard: { color: [238, 190, 30], roughness: 0.5, metalness: 0.3 },
  pole: { color: [110, 114, 118], roughness: 0.5, metalness: 0.8 },
  lamp: { color: [255, 236, 200], roughness: 0.4, metalness: 0, emissive: 6 },
  truck_paint: { color: [240, 150, 12], roughness: 0.38, metalness: 0.3 },
  truck_iron: { color: [44, 46, 50], roughness: 0.6, metalness: 0.5 },
  truck_frame: { color: [30, 31, 34], roughness: 0.5, metalness: 0.6 },
  truck_seat: { color: [22, 22, 24], roughness: 0.9, metalness: 0 },
  truck_mast: { color: [52, 54, 58], roughness: 0.45, metalness: 0.8 },
  truck_chrome: { color: [210, 214, 220], roughness: 0.15, metalness: 1 },
  truck_fork: { color: [84, 86, 92], roughness: 0.4, metalness: 0.9 },
  truck_tyre: { color: [20, 20, 22], roughness: 0.95, metalness: 0 },
  truck_hub: { color: [236, 200, 40], roughness: 0.5, metalness: 0.4 },
  truck_lamp: { color: [255, 244, 220], roughness: 0.3, metalness: 0, emissive: 4 },
};
