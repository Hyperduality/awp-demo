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
    const loop = (t: number) => {
      ctx.clearRect(0, 0, size.w, size.h);
      drawRef.current(ctx, size, palette, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return ref;
}
