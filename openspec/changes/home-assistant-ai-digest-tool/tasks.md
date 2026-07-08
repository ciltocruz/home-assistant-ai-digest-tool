# Tasks: Home Assistant AI Digest Tool MVP

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2,500-4,500 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 foundation → PR 2 backend core → PR 3 API/security → PR 4 frontend → PR 5 Docker/docs |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

## Review Notes Policy

Implementation review notes are maintainer-local working artifacts and MUST NOT be committed to the repository. When preparing a review, keep the notes outside tracked product documentation and cover:

- What changed and what is intentionally out of scope.
- Which files to open first and why.
- Which commands to run with `pnpm`.
- What behavior to verify manually, if any.
- A brief explanation of any new Fastify, React, Vite, Zod, Vitest, Playwright, SQLite, or Docker concept introduced by that PR.

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Workspace, shared DTOs, tests, CI guard | PR 1 | Base = feature/tracker branch; pnpm only. |
| 2 | SQLite stores, secrets, jobs, redaction | PR 2 | Base = PR 1 branch; includes unit/integration tests. |
| 3 | Collectors, detectors, digest orchestration, APIs | PR 3 | Base = PR 2 branch; fake adapters only. |
| 4 | React onboarding, dashboard, history/settings | PR 4 | Base = PR 3 branch; depends on API DTOs. |
| 5 | Docker runtime and public docs | PR 5 | Base = PR 4 branch; final integration into tracker. |

## Phase 1: Foundation

- [x] 1.1 Create `package.json`, `pnpm-workspace.yaml`, `backend/`, `frontend/`, `packages/shared/` with typecheck, test, build, and focused-test scripts.
- [x] 1.2 Add `packages/shared/src/dtos.ts` Zod DTOs for setup, settings, digest, errors, notifiers, notes, ignores.
- [x] 1.3 Add Vitest config and focused-test guard under `tests/` or scripts; ensure CI fails on `.only`.

## Phase 2: Backend Persistence and Safety

- [x] 2.1 Create `backend/src/domain/*` interfaces for collectors, detectors, providers, notifiers, stores, jobs, and renderers.
- [x] 2.2 Implement SQLite migrations in `backend/src/adapters/persistence/` for settings, secrets, jobs, reports, notes, ignores, deliveries.
- [x] 2.3 Implement `SQLiteSecretStore` with `/data/app.key`, masked refs only, and tests proving raw secrets never leave store boundaries.
- [x] 2.4 Implement `DigestJobStore.enqueue/lease/complete/retry` with unique `triggerWindowId` and concurrent duplicate enqueue tests.

## Phase 3: Backend Behavior and API

- [x] 3.1 Implement redaction, safe markdown rendering, ignore rules, priority, battery prediction, and fixture tests for malicious/empty inputs.
- [x] 3.2 Implement HA collectors and incident detectors under `backend/src/adapters/ha/`, marking Supervisor-only signals unsupported in Docker/Core.
- [ ] 3.3 Implement fake/OpenAI/Gemini provider adapters and notifier adapters with no live network in tests.
- [ ] 3.4 Add Fastify auth/session/CSRF middleware and protected routes for setup, settings, digest run/history, notes, ignores, notifier test/send.
- [ ] 3.5 Implement `DigestOrchestrator` transactions so provider/notifier failures preserve incidents and retry state.

## Phase 4: Frontend

- [ ] 4.1 Create React/Vite app in `frontend/src/` with API client consuming shared DTOs and redacted error handling.
- [ ] 4.2 Build onboarding flow for HA, provider, notifier, schedule, privacy, validation, and first digest.
- [ ] 4.3 Build dashboard, history empty/list states, notes, ignored warnings, settings, and Telegram test-send UI.

## Phase 5: Verification, Docker, Docs

- [ ] 5.1 Add Playwright smoke flows for onboarding, manual digest, history empty state, notes, ignores, and notifier test-send.
- [ ] 5.2 Add `Dockerfile`, `compose.yaml`, and `/data` volume wiring for backend, frontend assets, SQLite, logs, and mounted HA logs.
- [ ] 5.3 Write `README.md` and `docs/` for Docker-only support, privacy/secrets, HA token/log mounts, providers, Telegram, email, and markdown reports.
