/** Vault layouts, symbols, and payloads, shared by the world, the controllers, and the view. */

export const PORTS = { world: 8713, worldInspector: 8813, agentInspector: 8913, ui: 5173 } as const;

export type Cell = [number, number];
export type Color = "red" | "blue" | "yellow";
export const COLORS: Record<string, Color> = { r: "red", b: "blue", y: "yellow" };

/**
 * Layout symbols: # wall, . floor, S start, E exit, r/b/y keys, R/B/Y locked doors, G gem.
 * The map the agent receives uses the same symbols, plus ? unseen, @ you, + open door, * gem.
 */
export const LAYOUTS: Record<string, string[]> = {
  default: [
    "#################",
    "#S..#.....#.....#",
    "#.#.#.###.#.###.#",
    "#.#...#r#...#b#.#",
    "#.#####.#####.#.#",
    "#.......R.....#.#",
    "###.#####.###.#.#",
    "#...#...#...#...#",
    "#.###.#.#########",
    "#.....#...B...G.E",
    "#################",
  ],
  small: [
    "#############",
    "#S....#.....#",
    "#.###.#.###.#",
    "#.#y#...#G#.#",
    "#.#.#####Y#.#",
    "#...........#",
    "###.###.#####",
    "#.....#.....E",
    "#############",
  ],
};

export const SIGHT = 3;

export const LEGEND = {
  "#": "wall",
  ".": "floor",
  "?": "not seen yet",
  "@": "you",
  r: "red key",
  b: "blue key",
  y: "yellow key",
  R: "locked red door",
  B: "locked blue door",
  Y: "locked yellow door",
  "+": "open door",
  "*": "gem",
  E: "exit",
} as const;

export interface MapPayload {
  /** Rows from y = 0 (north) down; column index is x. */
  rows: string[];
  width: number;
  height: number;
  legend: Record<string, string>;
}

export interface StatusPayload {
  position: Cell;
  facing: "north" | "south" | "east" | "west";
  inventory: string[];
  message: string;
  escaped: boolean;
  steps: number;
}

export interface VaultView {
  truth: string[];
  seen: string[];
  avatar: Cell;
  facing: StatusPayload["facing"];
  inventory: string[];
  path: Cell[];
  escaped: boolean;
  message: string;
  steps: number;
}

export const DIRS: Record<StatusPayload["facing"], Cell> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};
