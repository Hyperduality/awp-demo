import RAPIER from "@dimforge/rapier3d-deterministic-compat";

let ready: Promise<typeof RAPIER> | undefined;

/**
 * The deterministic Rapier build, pinned to 0.19.3. From 0.20 on, a body resting on a turning surface
 * drifts outward by a tenth of the distance it is carried, whatever the friction, step or solver
 * settings: a box on a turntable spirals off it, and a load slides off a truck's forks in every turn.
 * `test/turntable.test.ts` holds the check to run before moving the pin.
 *
 * This build: the same inputs give the same bits on every machine, which is what
 * lets a seed reproduce a run (AWP-REP-001). The WASM is inlined, so this works in Node and browsers.
 */
export function initRapier(): Promise<typeof RAPIER> {
  ready ??= quietly(() => RAPIER.init()).then(() => RAPIER);
  return ready;
}

/** This build's loader warns about its own call into wasm-bindgen on every start. */
async function quietly(run: () => Promise<void>): Promise<void> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await run();
  } finally {
    console.warn = warn;
  }
}

export type Rapier = typeof RAPIER;
export type { RAPIER };
