import { useEffect, useRef } from "react";

export interface Palette {
  background: string;
  surface: string;
  surfaceSecondary: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

/** Theme colours resolved from the CSS variables, so canvases follow light and dark. */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim() || "#888";
  return {
    background: v("--background"),
    surface: v("--surface"),
    surfaceSecondary: v("--surface-secondary"),
    foreground: v("--foreground"),
    muted: v("--muted"),
    border: v("--border"),
    accent: v("--accent"),
    success: v("--success"),
    warning: v("--warning"),
    danger: v("--danger"),
  };
}

/** A colour as [r, g, b] 0–255, whatever CSS syntax it was written in (oklch included). */
export function toRgb(color: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = color;
  g.fillRect(0, 0, 1, 1);
  const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
  return [r!, gg!, b!];
}

/** Mixes two RGB colours; t = 0 gives a, 1 gives b. */
export function mixRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)} ${Math.round(a[1] + (b[1] - a[1]) * k)} ${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}

export type Draw = (ctx: CanvasRenderingContext2D, size: { w: number; h: number }, palette: Palette, t: number) => void;

/**
 * A canvas that fills its parent at device resolution and redraws every animation frame with the
 * latest `draw`. Returns the ref to put on the <canvas>.
 */
export function useCanvas(draw: Draw) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let palette = readPalette(canvas);
    let size = { w: 0, h: 0 };
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size = { w: r.width, h: r.height };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const mo = new MutationObserver(() => {
      palette = readPalette(canvas);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    resize();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = (t: number) => {
      ctx.clearRect(0, 0, size.w, size.h);
      drawRef.current(ctx, size, palette, t);
      // Hidden pages get no animation frames; keep a slow redraw so the canvas is never stale.
      if (document.hidden) timer = setTimeout(() => loop(performance.now()), 200);
      else raf = requestAnimationFrame(loop);
    };
    const onVisible = () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      loop(performance.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    raf = requestAnimationFrame(loop);
    if (document.hidden) loop(performance.now());
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return ref;
}
