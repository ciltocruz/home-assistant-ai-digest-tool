# Contributing

Thanks for helping improve the Home Assistant AI Digest tool. This document describes how this repository actually works — setup, conventions, review flow, and releases.

## Prerequisites

- **Node.js 22** — the runtime and CI target.
- **pnpm 9** — pnpm is mandatory in this repository. Never use `npm` or `npx` (not even for one-off tools; use `pnpm dlx` instead).
- Install dependencies: `pnpm install`

## Everyday commands

| Command | Purpose |
|---------|---------|
| `pnpm ci` | Full local gate: recursive build + typecheck + tests + focused-test guard |
| `pnpm test` | Vitest suite across workspaces |
| `pnpm typecheck` | Strict TypeScript on every workspace |
| `pnpm build` | Build backend, frontend, and shared packages |
| `pnpm test:focused` | Guard against accidentally committed focused tests |

Run `pnpm ci` locally before pushing — CI runs exactly this.

## Change flow

1. **Issue first.** Every change links an issue. Open a bug report or feature request using the templates.
2. **Approval gate.** Maintainers triage issues and add the `status:approved` label. Pull requests must link an approved issue (`Closes #N`); unlinked PRs are blocked by automation.
3. **Branch.** Create your branch from `main` following `type/short-description`:

   | Type | Branch pattern | Example |
   |------|----------------|---------|
   | Bug fix | `fix/<desc>` | `fix/zsh-glob-error` |
   | Feature | `feat/<desc>` | `feat/user-login` |
   | Chore/tooling | `chore/<desc>` | `chore/update-ci-actions` |
   | Docs | `docs/<desc>` | `docs/installation-guide` |

4. **Conventional commits.** Commit messages follow `type(scope): description`:

   ```
   feat(ai): add provider timeout knob
   fix(reports): harden persisted delivery
   docs(readme): update deployment flow
   chore(ci): bump actions group
   ```

5. **Tests.** Behavior changes come with tests (Vitest; Playwright smoke for critical user flows). All suites must pass.
6. **Pull request.** Use the PR template: link the approved issue, check exactly one PR type, and describe what changed and how it was tested. Exactly one `type:*` label is required.

## Review and merge policy

- The repository owner reviews and merges pull requests. External contributors cannot merge their own PRs — merging requires write access.
- `main` is protected by a ruleset: the **Typecheck, tests, and build** check must pass, and force-pushes/deletion of `main` are blocked.
- If your branch falls behind `main`, use *Update branch*; once checks are green the merge is available.
- Commit trailers attributing AI tools (`Co-Authored-By`, etc.) are not used in this repository.

## Releases are manual by design

Merging to `main` publishes nothing. Releases happen when the maintainer decides:

1. From the **Actions → Release → Run workflow** page (run on `main`), or
2. By pushing a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

One run produces a single release covering everything since the previous tag. The version and release notes are computed from all accumulated conventional commits — which is why commit message discipline matters. GHCR images (`version` and `latest`) publish per release.

## Code expectations

- TypeScript strict mode across all workspaces (`backend`, `frontend`, `packages/shared`).
- Keep the test suite green; never leave focused tests behind (CI guards this).
- Never commit secrets. Runtime secrets live encrypted in the application's secret store, not in code or config files.
- UI copy, comments, and documentation are written in English.
