import {
  CanvasTexture,
  Color,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from "three";

/** A surface: its colour and finish, and optionally a named texture set to give it grain. */
export interface SceneMaterial {
  /** sRGB, 0..255. */
  color: [number, number, number];
  roughness: number;
  metalness: number;
  /** A texture set: `<assets>/textures/<map>/{color,normal,rough}.jpg` when present, else a generated pattern. */
  map?: string;
  tile_m?: number;
  /** Paint the set this material's colour, keeping only its light and dark: one photograph, many liveries. */
  tinted?: boolean;
  /** Emitted light, as a multiple of the colour. */
  emissive?: number;
}

/** A small seeded generator, so the generated patterns are the same on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE = 512;

/** Tileable value noise at one scale, 0..1. */
function noise(cells: number, rand: () => number): (u: number, v: number) => number {
  const grid = Float32Array.from({ length: cells * cells }, () => rand());
  const at = (x: number, y: number) =>
    grid[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)] as number;
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/**
 * A greyscale pattern for a texture set's name, 0..1 per pixel: used both to vary the colour and as a
 * height for bump shading. Stand-ins until photographed textures are in place, and tileable.
 */
function pattern(name: string): (u: number, v: number) => number {
  const rand = rng(name.length * 7919 + name.charCodeAt(0) * 131);
  const coarse = noise(6, rand);
  const mid = noise(24, rand);
  const fine = noise(96, rand);
  const grit = noise(256, rand);
  switch (name) {
    case "asphalt":
      // Aggregate: mostly fine speckle, with patches where the surface has worn.
      return (u, v) => 0.5 + (grit(u, v) - 0.5) * 0.55 + (fine(u, v) - 0.5) * 0.25 + (coarse(u, v) - 0.5) * 0.3;
    case "concrete":
      return (u, v) => 0.6 + (coarse(u, v) - 0.5) * 0.35 + (mid(u, v) - 0.5) * 0.2 + (grit(u, v) - 0.5) * 0.12;
    case "corrugated":
      // Ribs run up the sheet: a rounded wave across u, with a little dirt.
      return (u, v) =>
        0.5 + Math.sin(u * Math.PI * 2 * 8) * 0.32 + (mid(u, v) - 0.5) * 0.12 + (coarse(u, v * 0.3) - 0.5) * 0.14;
    case "planks":
      // Boards along u, six to a tile, each its own shade, with grain and dark joints.
      return (u, v) => {
        const board = Math.floor(v * 6);
        const edge = Math.abs(v * 6 - board - 0.5) > 0.46 ? -0.35 : 0;
        const shade = (((board * 2654435761) >>> 0) / 4294967296 - 0.5) * 0.3;
        const grain = (noise1(u * 3 + board * 0.37, v * 60, fine) - 0.5) * 0.3;
        return 0.6 + shade + grain + edge;
      };
    default:
      // Plywood and anything else: long grain with broad figure.
      return (u, v) => 0.6 + (noise1(u * 2, v * 40, fine) - 0.5) * 0.3 + (coarse(u, v) - 0.5) * 0.2;
  }
}

function noise1(u: number, v: number, n: (u: number, v: number) => number): number {
  return n(u - Math.floor(u), v - Math.floor(v));
}

function patternTexture(name: string): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const image = ctx.createImageData(SIZE, SIZE);
  const f = pattern(name);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const g = Math.max(0, Math.min(1, f(x / SIZE, y / SIZE))) * 255;
      const o = (y * SIZE + x) * 4;
      image.data[o] = g;
      image.data[o + 1] = g;
      image.data[o + 2] = g;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}

/** A photograph reduced to its light and dark, scaled so its average is white: a surface ready to be painted. */
function shadesOf(photo: Texture): Texture {
  const image = photo.image as HTMLImageElement;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4)
    sum += 0.2126 * (px[i] as number) + 0.7152 * (px[i + 1] as number) + 0.0722 * (px[i + 2] as number);
  const gain = 235 / (sum / (px.length / 4) || 1);
  for (let i = 0; i < px.length; i += 4) {
    const l = Math.min(
      255,
      (0.2126 * (px[i] as number) + 0.7152 * (px[i + 1] as number) + 0.0722 * (px[i + 2] as number)) * gain,
    );
    px[i] = l;
    px[i + 1] = l;
    px[i + 2] = l;
  }
  ctx.putImageData(data, 0, 0);
  photo.dispose();
  return new CanvasTexture(canvas);
}

/**
 * Builds and caches the scene's materials. A material that names a texture set starts with a generated
 * pattern and swaps to the photographed set if `<assets>/textures/<map>/color.jpg` loads.
 */
export class MaterialLibrary {
  private readonly defs: Record<string, SceneMaterial>;
  private readonly assets: string | undefined;
  private readonly cache = new Map<string, MeshStandardMaterial>();
  private readonly patterns = new Map<string, Texture>();
  private readonly shades = new Map<string, Texture>();
  private readonly loader = new TextureLoader();
  private anisotropy = 1;
  onChange: (() => void) | undefined;

  constructor(defs: Record<string, SceneMaterial>, assets?: string) {
    this.defs = defs;
    this.assets = assets;
  }

  setAnisotropy(level: number): void {
    this.anisotropy = level;
  }

  tile(name: string): number {
    return this.defs[name]?.tile_m ?? 1;
  }

  get(name: string): MeshStandardMaterial {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const def = this.defs[name] ?? { color: [128, 128, 128], roughness: 0.8, metalness: 0 };
    const color = new Color().setRGB(def.color[0] / 255, def.color[1] / 255, def.color[2] / 255, SRGBColorSpace);
    const material = new MeshStandardMaterial({ color, roughness: def.roughness, metalness: def.metalness });
    if (def.emissive) {
      material.emissive = color.clone();
      material.emissiveIntensity = def.emissive;
    }
    if (def.map) {
      const set = def.map;
      let generated = this.patterns.get(set);
      if (!generated) {
        generated = patternTexture(set);
        generated.anisotropy = this.anisotropy;
        this.patterns.set(set, generated);
      }
      // The pattern is mid-grey on average, so the colour is lifted to keep the surface's own tone.
      material.map = generated;
      material.color.multiplyScalar(1.6);
      material.bumpMap = generated;
      material.bumpScale = set === "corrugated" ? 3 : 0.8;
      if (this.assets) this.photographed(material, set, color, def.tinted === true);
    }
    this.cache.set(name, material);
    return material;
  }

  private photographed(material: MeshStandardMaterial, set: string, tint: Color, tinted: boolean): void {
    const ready = (t: Texture, srgb: boolean) => {
      t.wrapS = RepeatWrapping;
      t.wrapT = RepeatWrapping;
      t.anisotropy = this.anisotropy;
      if (srgb) t.colorSpace = SRGBColorSpace;
      material.needsUpdate = true;
      this.onChange?.();
    };
    const load = (file: string, apply: (t: Texture) => void) =>
      this.loader.load(`${this.assets}/textures/${set}/${file}`, apply, undefined, () => {});
    load("color.jpg", (t) => {
      // A photographed surface carries its own colour. A tinted one keeps only its light and dark, evened
      // out to white on average, so the material's colour comes through as painted.
      const map = tinted ? (this.shades.get(set) ?? shadesOf(t)) : t;
      if (tinted) this.shades.set(set, map);
      ready(map, true);
      material.map = map;
      material.color.copy(tinted ? tint : new Color(1, 1, 1));
      material.bumpMap = null;
    });
    load("normal.jpg", (t) => {
      ready(t, false);
      material.normalMap = t;
      material.bumpMap = null;
    });
    load("rough.jpg", (t) => {
      ready(t, false);
      material.roughnessMap = t;
      material.roughness = 1;
    });
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    for (const t of this.patterns.values()) t.dispose();
    for (const t of this.shades.values()) t.dispose();
  }
}
