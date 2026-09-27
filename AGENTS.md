# AGENTS.md

awp-demo is a set of Agent World Protocol demos: a Node world, a Node agent, and a Vite UI per demo, sharing the packages in `packages/`. It targets one specification revision, 0.1-draft.10, through `@hyperduality/awp`.

## Checks

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

CI runs these, then runs awp-conformance against every world; each must pass every assertion it runs.

## Code

- `packages/world` implements the world side from the specification. Cite a requirement ID (`AWP-XXX-NNN`) where the code implements it; otherwise comment only what the code can't say.
- A world never reads what an agent knows, and a controller never reads the world's truth: controllers act only on observations.
- The UI only reads inspector topics and sends inspector commands. It never speaks AWP.
- UI follows the HeroUI design conventions: default sizes, semantic tokens, no decorative chips, dots, or gradients, and Tooltips on icon-only buttons.

## Commits and pull requests

- Branch from `main` and open a pull request. Merge once CI passes.
- Write the title as one plain sentence in sentence case, with no trailing period, saying what changed.
- Add a body only when the title can't carry the reason: one or two short sentences.
- Write commits the way a person on the project would. No `Co-Authored-By` trailers, no "Generated with" lines, and no other mention of AI tools, in commits or in PRs.
