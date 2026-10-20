/** The demos in this repository, for the switcher. Dev ports follow the repo convention (517x). */
export const DEMOS = [
  { id: "sorter", name: "Sorter", url: "http://localhost:5172", blurb: "Lockstep · program first" },
  { id: "vault", name: "Vault", url: "http://localhost:5173", blurb: "Lockstep · LLM first" },
  { id: "dispatch", name: "Dispatch", url: "http://localhost:5174", blurb: "Streaming · LLM first" },
  { id: "minecraft", name: "Minecraft", url: "http://localhost:5175", blurb: "Both time models · device input" },
] as const;

export const REPO_URL = "https://github.com/Hyperduality/awp-demo";
