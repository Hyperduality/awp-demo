# AGENTS.md

awp-demo is a set of Agent World Protocol demos: a Node world, a Node agent, and a Vite UI per demo, sharing the packages in `packages/`. It targets one specification revision, the one that the pinned `@hyperduality/awp` version targets. The header of `packages/world/src/host.ts` and the README name it.

## Checks

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs these on Node 24. It also runs awp-conformance against every world, and fails unless each passes every assertion it runs.

## Code

- `packages/world` implements the world side from the specification. Cite a requirement ID (`AWP-XXX-NNN`) where the code implements it. Otherwise, comment only what the code can't say.
- A world never reads what an agent knows, and a controller never reads the world's truth: controllers act only on observations.
- The UI only reads inspector topics and sends inspector commands. It never speaks AWP.
- UI follows the HeroUI design conventions: default sizes, semantic tokens, no decorative chips, dots, or gradients, and Tooltips on icon-only buttons.

## Conformance

`apps/<demo>/conformance/` holds each world's fixture and the report behind the README's claim. The reports must come from the suite version CI runs. After bumping that pin in `.github/workflows/ci.yml`, regenerate them with the commands in the README. Then update the versions named there.

## Commits and pull requests

- Branch from `main` and open a pull request. Merge once CI passes.
- Write the title as one plain sentence in sentence case, with no trailing period, saying what changed: `Let the observation panel's channel picker wrap and scroll`.
- Add a body only when the title can't carry the reason: one or two short sentences.
- Write commits the way a person on the project would. No `Co-Authored-By` trailers, no "Generated with" lines, and no other mention of AI tools, in commits or in PRs.
- The PR title matches the commit title, and the description is a few lines at most.

## Moving to a new draft revision

1. Raise `@hyperduality/awp` to a release that targets the new revision, in every package that depends on it.
2. Update the revision named in `packages/world/src/host.ts` and the README.
3. Fix whatever the typecheck and the tests report.
4. Regenerate the conformance reports.
