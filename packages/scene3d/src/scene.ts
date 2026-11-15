import type { LayoutBody } from "@awp-demo/physics/scene";
import {
  AgXToneMapping,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HalfFloatType,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { bodyGeometries } from "./geometry.ts";
import { PoseBuffer } from "./interp.ts";
import { MaterialLibrary, type SceneMaterial } from "./materials.ts";

// The world is z up: x east, y north.
Object3D.DEFAULT_UP.set(0, 0, 1);

const STRIDE = 7;
const SKY_GAIN = 0.16;
const SKY_CAP = 1.4;

/** A rectangle painted on a surface, with an optional label: a bay, a parking slot. */
export interface Mark {
  id: string;
  p: [number, number, number];
  yaw: number;
  size: [number, number];
  label?: string;
  /** sRGB, 0..255. */
  color?: [number, number, number];
}

export interface SceneLayout {
  /** Changes whenever the bodies do. Frames for another key are ignored. */
  key: string;
  bodies: LayoutBody[];
  marks?: Mark[];
}

export interface SceneFrame {
  key: string;
  t_ms: number;
  /** Seven float32 per layout body. */
  poses: Float32Array;
}

export type CameraMode = "orbit" | "chase" | "seat" | "top";
export type Quality = "high" | "low";

export interface Overlay {
  /** World-space xyz triples drawn as dots: a lidar sweep. */
  points?: Float32Array | null;
  /** A route on the ground, as [x, y] corners. */
  path?: [number, number][] | null;
  /** A view frustum: the eye, then its four far corners, in world space. */
  frustum?: [number, number, number][] | null;
}

export interface SceneOptions {
  materials: Record<string, SceneMaterial>;
  /** Base URL of the asset folder holding `textures/`; without it, surfaces use generated patterns. */
  assets?: string;
  /** Direction towards the sun. */
  sun?: [number, number, number];
  /** The body the chase and seat cameras ride with. */
  follow?: string;
  /** Where the seat camera sits in the followed body's frame. */
  seat?: [number, number, number];
}

export interface SceneStats {
  fps: number;
  calls: number;
  triangles: number;
}

/**
 * A physically lit view of a world of rigid bodies. It is given a layout once, then pose frames; it
 * draws the moment a little before the newest frame so motion is smooth. Lighting is a sky model: its
 * sun casts the shadows and the sky itself lights everything else, so there is nothing to place by hand.
 */
export class Scene3D {
  readonly renderer: WebGLRenderer;
  private readonly host: HTMLElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.1, 2000);
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly library: MaterialLibrary;
  private readonly sun: DirectionalLight;
  private readonly buffer = new PoseBuffer(50);
  private readonly world = new Group();
  private readonly overlay = new Group();
  private readonly resize: ResizeObserver;
  private readonly opts: SceneOptions;
  private key = "";
  private moving: { index: number; group: Group }[] = [];
  private poses = new Float32Array(0);
  private followIndex = -1;
  private mode: CameraMode = "orbit";
  private raf = 0;
  private disposed = false;
  private last = 0;
  private frames = 0;
  private since = 0;
  private fps = 0;
  private readonly eye = new Vector3();
  private readonly look = new Vector3();
  private cameraSnap = true;
  private points: Points | undefined;
  private pathLine: Line | undefined;
  private frustumLines: LineSegments | undefined;
  private readonly sky: Sky;

  constructor(host: HTMLElement, opts: SceneOptions) {
    this.host = host;
    this.opts = opts;
    const renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.outputColorSpace = SRGBColorSpace;
    // Applied once, by the output pass, after the effects have worked on the linear image.
    renderer.toneMapping = AgXToneMapping;
    renderer.toneMappingExposure = 0.7;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.library = new MaterialLibrary(opts.materials, opts.assets);
    this.library.setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

    // Sky: a physical sky dome with drifting cloud, which also becomes the image everything reflects
    // and is lit by. Its shader takes y as up, so directions are turned into its frame on the way in.
    const dir = new Vector3(...(opts.sun ?? [-0.45, -0.35, 0.82])).normalize();
    const sky = new Sky();
    sky.scale.setScalar(1500);
    sky.material.fragmentShader = sky.material.fragmentShader.replace(
      "vec3 direction = normalize( vWorldPosition - cameraPosition );",
      "vec3 direction = normalize( vWorldPosition - cameraPosition ).xzy * vec3( 1.0, 1.0, -1.0 );",
    );
    // The sky's own brightness runs to the hundreds at the sun. Left alone, the bloom smears it over
    // the whole picture; scaled to sit with the sunlit ground and capped, only the sun itself glows.
    sky.material.fragmentShader = sky.material.fragmentShader.replace(
      "gl_FragColor = vec4( texColor, 1.0 );",
      `gl_FragColor = vec4( min( texColor * ${SKY_GAIN.toFixed(2)}, vec3( ${SKY_CAP.toFixed(2)} ) ), 1.0 );`,
    );
    const uniform = (name: string, value: number | Vector3) => {
      const u = sky.material.uniforms[name];
      if (u) u.value = value;
    };
    uniform("sunPosition", new Vector3(dir.x, dir.z, -dir.y));
    uniform("turbidity", 3.2);
    uniform("rayleigh", 1.1);
    uniform("mieCoefficient", 0.004);
    uniform("mieDirectionalG", 0.82);
    uniform("cloudCoverage", 0.38);
    uniform("cloudDensity", 0.45);
    this.sky = sky;
    // The sun's own disc is left out of the reflection image: so small and bright, it turns into sparkle.
    uniform("showSunDisc", 0);
    const pmrem = new PMREMGenerator(renderer);
    const skyOnly = new Scene();
    skyOnly.add(sky);
    this.scene.environment = pmrem.fromScene(skyOnly, 0.02, 1, 3000).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
    uniform("showSunDisc", 1);
    this.scene.add(sky);

    const sun = new DirectionalLight(new Color(1, 0.95, 0.86), 6.5);
    sun.position.copy(dir).multiplyScalar(120);
    sun.castShadow = true;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.04;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    // A little fill from the ground, so undersides are not black.
    this.scene.add(new HemisphereLight(new Color(0.55, 0.65, 0.8), new Color(0.28, 0.26, 0.24), 0.12));
    this.scene.add(this.world, this.overlay);

    this.camera.position.set(-6, -30, 17);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, 0, 0.5);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 120;
    this.controls.update();

    // A half-float target keeps the sun's brightness for the bloom; four samples smooth the edges.
    this.composer = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 }));
    this.setQuality("high");

    this.library.onChange = () => {};
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Replace the bodies. Fixed ones are baked into one mesh per material; the rest move with the frames. */
  setLayout(layout: SceneLayout): void {
    this.key = layout.key;
    this.buffer.clear();
    this.clear(this.world);
    this.moving = [];
    this.poses = new Float32Array(layout.bodies.length * STRIDE);
    this.followIndex = this.opts.follow ? layout.bodies.findIndex((b) => b.id === this.opts.follow) : -1;
    this.cameraSnap = true;
    const tile = (m: string) => this.library.tile(m);

    const fixed = new Map<string, BufferGeometry[]>();
    layout.bodies.forEach((body, index) => {
      // Until the first frame arrives, bodies stand where the layout says they started.
      this.poses.set([...body.p, ...body.q], index * STRIDE);
      const parts = bodyGeometries(body, tile);
      if (body.fixed) {
        const q = new Quaternion(body.q[0], body.q[1], body.q[2], body.q[3]);
        for (const [material, g] of parts) {
          g.applyQuaternion(q).translate(body.p[0], body.p[1], body.p[2]);
          const list = fixed.get(material) ?? [];
          list.push(g);
          fixed.set(material, list);
        }
        return;
      }
      const group = new Group();
      group.matrixAutoUpdate = false;
      for (const [material, g] of parts) group.add(this.mesh(g, material));
      this.world.add(group);
      this.moving.push({ index, group });
    });
    for (const [material, list] of fixed) {
      const merged = list.length === 1 ? (list[0] as BufferGeometry) : mergeGeometries(list, false);
      if (!merged) continue;
      const mesh = this.mesh(merged, material);
      mesh.matrixAutoUpdate = false;
      this.world.add(mesh);
    }
    for (const mark of layout.marks ?? []) this.world.add(this.paint(mark));
    this.apply();
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** A new pose frame. Frames for a layout that is not the current one are dropped. */
  push(frame: SceneFrame): void {
    if (frame.key !== this.key || frame.poses.length !== this.poses.length) return;
    this.buffer.push(frame.t_ms, frame.poses, performance.now());
  }

  setCamera(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.controls.enabled = mode === "orbit";
    this.cameraSnap = true;
    if (mode === "orbit") {
      // Keep looking at what the last camera was looking at.
      this.controls.target.copy(this.look);
      this.controls.update();
    }
    this.camera.fov = mode === "seat" ? 70 : mode === "top" ? 30 : 42;
    this.camera.updateProjectionMatrix();
  }

  setQuality(quality: Quality): void {
    const high = quality === "high";
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 2 : 1));
    const size = high ? 4096 : 2048;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    for (const pass of [...this.composer.passes]) {
      this.composer.removePass(pass);
      pass.dispose();
    }
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (high) {
      // Contact shadows in the creases the sun's shadow map is too coarse for.
      const ao = new GTAOPass(this.scene, this.camera, w, h);
      ao.blendIntensity = 0.9;
      ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      this.composer.addPass(ao);
      this.composer.addPass(new UnrealBloomPass(new Vector2(w, h), 0.14, 0.5, 1.6));
    }
    this.composer.addPass(new OutputPass());
    this.fit();
  }

  setOverlay(overlay: Overlay): void {
    if (overlay.points !== undefined) {
      if (this.points) {
        this.overlay.remove(this.points);
        this.points.geometry.dispose();
        this.points = undefined;
      }
      if (overlay.points && overlay.points.length > 0) {
        const g = new BufferGeometry();
        g.setAttribute("position", new BufferAttribute(overlay.points, 3));
        const m = new PointsMaterial({
          color: new Color(0.2, 1, 0.75),
          size: 3,
          sizeAttenuation: false,
          depthTest: true,
          transparent: true,
          opacity: 0.9,
          toneMapped: false,
        });
        this.points = new Points(g, m);
        this.points.frustumCulled = false;
        this.overlay.add(this.points);
      }
    }
    if (overlay.path !== undefined) {
      if (this.pathLine) {
        this.overlay.remove(this.pathLine);
        this.pathLine.geometry.dispose();
        this.pathLine = undefined;
      }
      if (overlay.path && overlay.path.length > 1) {
        const g = new BufferGeometry().setFromPoints(overlay.path.map(([x, y]) => new Vector3(x, y, 0.06)));
        this.pathLine = new Line(
          g,
          new LineBasicMaterial({ color: new Color(0.25, 0.7, 1), transparent: true, opacity: 0.9, toneMapped: false }),
        );
        this.overlay.add(this.pathLine);
      }
    }
    if (overlay.frustum !== undefined) {
      if (this.frustumLines) {
        this.overlay.remove(this.frustumLines);
        this.frustumLines.geometry.dispose();
        this.frustumLines = undefined;
      }
      const f = overlay.frustum;
      if (f && f.length === 5) {
        const v = f.map((p) => new Vector3(p[0], p[1], p[2])) as [Vector3, Vector3, Vector3, Vector3, Vector3];
        const [eye, a, b, c, d] = v;
        const g = new BufferGeometry().setFromPoints([eye, a, eye, b, eye, c, eye, d, a, b, b, c, c, d, d, a]);
        this.frustumLines = new LineSegments(
          g,
          new LineBasicMaterial({ color: new Color(1, 0.8, 0.2), transparent: true, opacity: 0.7, toneMapped: false }),
        );
        this.overlay.add(this.frustumLines);
      }
    }
  }

  stats(): SceneStats {
    const info = this.renderer.info.render;
    return { fps: this.fps, calls: info.calls, triangles: info.triangles };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear(this.world);
    this.clear(this.overlay);
    this.library.dispose();
    this.composer.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private mesh(geometry: BufferGeometry, material: string): Mesh {
    const mesh = new Mesh(geometry, this.library.get(material));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** A painted outline on the ground with its label inside. */
  private paint(mark: Mark): Group {
    const group = new Group();
    const [w, d] = mark.size;
    const c = mark.color ?? [236, 196, 40];
    const paint = new MeshStandardMaterial({
      color: new Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, SRGBColorSpace),
      roughness: 0.7,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const line = 0.09;
    const strips: [number, number, number, number][] = [
      [0, d / 2, w + line, line],
      [0, -d / 2, w + line, line],
      [w / 2, 0, line, d + line],
      [-w / 2, 0, line, d + line],
    ];
    for (const [x, y, sx, sy] of strips) {
      const strip = new Mesh(new PlaneGeometry(sx, sy), paint);
      strip.position.set(x, y, 0);
      strip.receiveShadow = true;
      group.add(strip);
    }
    if (mark.label) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 128;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
      ctx.font = "700 92px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(mark.label, 128, 70);
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = 8;
      const text = new Mesh(
        new PlaneGeometry(Math.min(w, d) * 0.9, Math.min(w, d) * 0.45),
        new MeshStandardMaterial({
          map: texture,
          transparent: true,
          roughness: 0.7,
          side: DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      // Read from the side a truck approaches from.
      text.rotation.z = -Math.PI / 2;
      text.receiveShadow = true;
      group.add(text);
    }
    group.position.set(mark.p[0], mark.p[1], mark.p[2] + 0.006);
    group.rotation.z = mark.yaw;
    return group;
  }

  private clear(group: Group): void {
    group.traverse((o) => {
      if (o instanceof Mesh || o instanceof Line || o instanceof Points) {
        o.geometry.dispose();
        const m = o.material;
        if (m instanceof MeshBasicMaterial || m instanceof LineBasicMaterial || m instanceof PointsMaterial)
          m.dispose();
      }
    });
    group.clear();
  }

  private fit(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Put every moving body where the pose array says. */
  private apply(): void {
    const p = this.poses;
    for (const { index, group } of this.moving) {
      const o = index * STRIDE;
      group.position.set(p[o] as number, p[o + 1] as number, p[o + 2] as number);
      group.quaternion.set(p[o + 3] as number, p[o + 4] as number, p[o + 5] as number, p[o + 6] as number);
      group.updateMatrix();
    }
  }

  private place(dt: number): void {
    const p = this.poses;
    const o = this.followIndex * STRIDE;
    const has = this.followIndex >= 0;
    const at = has ? new Vector3(p[o], p[o + 1], p[o + 2]) : new Vector3();
    const q = has ? new Quaternion(p[o + 3], p[o + 4], p[o + 5], p[o + 6]) : new Quaternion();
    const fwd = new Vector3(1, 0, 0).applyQuaternion(q);
    const flat = new Vector3(fwd.x, fwd.y, 0).normalize();

    // The shadow follows what is being looked at, snapped to its texels so it does not shimmer.
    const focus = this.mode === "orbit" ? this.controls.target : at;
    const span =
      this.mode === "orbit" ? MathUtils.clamp(this.camera.position.distanceTo(this.controls.target) * 0.9, 18, 46) : 26;
    const cam = this.sun.shadow.camera;
    if (cam.right !== span) {
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = 20;
      cam.far = 240;
      cam.updateProjectionMatrix();
    }
    const texel = (span * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fy = Math.round(focus.y / texel) * texel;
    const offset = this.sun.position.clone().sub(this.sun.target.position);
    this.sun.target.position.set(fx, fy, 0);
    this.sun.position.copy(this.sun.target.position).add(offset);
    this.sun.target.updateMatrixWorld();

    if (this.mode === "orbit") {
      this.controls.update();
      this.look.copy(this.controls.target);
      return;
    }
    const eye = new Vector3();
    const look = new Vector3();
    if (this.mode === "chase") {
      eye
        .copy(at)
        .addScaledVector(flat, -8.5)
        .add(new Vector3(0, 0, 4.2));
      look
        .copy(at)
        .addScaledVector(flat, 2.5)
        .add(new Vector3(0, 0, 0.9));
    } else if (this.mode === "seat") {
      const seat = this.opts.seat ?? [-0.2, 0, 1.2];
      eye.copy(new Vector3(...seat).applyQuaternion(q)).add(at);
      look
        .copy(eye)
        .addScaledVector(fwd, 10)
        .add(new Vector3(0, 0, -1.6));
    } else {
      eye.copy(at).add(new Vector3(0, -0.01, 55));
      look.copy(at);
    }
    // Ease towards the new place, except straight after a cut or in the seat, which is bolted on.
    const ease = this.cameraSnap || this.mode === "seat" ? 1 : 1 - Math.exp(-dt * (this.mode === "top" ? 3 : 4.5));
    this.eye.lerp(eye, ease);
    this.look.lerp(look, ease);
    this.cameraSnap = false;
    this.camera.position.copy(this.eye);
    this.camera.up.set(0, 0, 1);
    if (this.mode === "top") this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
  }

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    const time = this.sky.material.uniforms.time;
    if (time) time.value = now / 1000;
    if (this.buffer.sample(performance.now(), this.poses)) this.apply();
    this.place(dt);
    this.composer.render(dt);
    this.frames++;
    if (now - this.since > 500) {
      this.fps = (this.frames * 1000) / (now - this.since);
      this.frames = 0;
      this.since = now;
    }
  };
}
