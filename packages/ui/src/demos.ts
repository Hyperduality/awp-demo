/** The demos in this repository, for the switcher. Dev ports follow the repo convention (517x). */
export const DEMOS = [
  { id: "maze", name: "Maze", url: "http://localhost:5171", blurb: "Streaming · manual first" },
  { id: "sorter", name: "Sorter", url: "http://localhost:5172", blurb: "Lockstep · program first" },
  { id: "vault", name: "Vault", url: "http://localhost:5173", blurb: "Lockstep · LLM first" },
] as const;

export const REPO_URL = "https://github.com/Hyperduality/awp-demo";
