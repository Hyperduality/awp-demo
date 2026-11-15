import { useEffect, useRef } from "react";
import {
  type CameraMode,
  type Overlay,
  type Quality,
  Scene3D,
  type SceneFrame,
  type SceneLayout,
  type SceneOptions,
} from "./scene.ts";

export interface ViewportProps {
  options: SceneOptions;
  layout: SceneLayout | null | undefined;
  /** Called once with a function that takes each new frame: frames skip React and go straight to the scene. */
  frames: (push: (frame: SceneFrame) => void) => () => void;
  camera?: CameraMode;
  quality?: Quality;
  overlay?: Overlay;
  onScene?: (scene: Scene3D | null) => void;
  className?: string;
}

/** A 3D view of a world of rigid bodies. See `Scene3D`. */
export function Viewport({
  options,
  layout,
  frames,
  camera = "orbit",
  quality = "high",
  overlay,
  onScene,
  className,
}: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene3D | null>(null);

  // The options are read once: materials and mounts do not change while a view is up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!host.current) return;
    const s = new Scene3D(host.current, options);
    scene.current = s;
    onScene?.(s);
    return () => {
      onScene?.(null);
      scene.current = null;
      s.dispose();
    };
  }, []);

  useEffect(() => {
    if (layout) scene.current?.setLayout(layout);
  }, [layout]);
  useEffect(() => frames((frame) => scene.current?.push(frame)), [frames]);
  useEffect(() => scene.current?.setCamera(camera), [camera]);
  useEffect(() => scene.current?.setQuality(quality), [quality]);
  useEffect(() => {
    if (overlay) scene.current?.setOverlay(overlay);
  }, [overlay]);

  return <div ref={host} className={className} />;
}
