# Home Assistant AI Digest Tool

Home Assistant AI Digest Tool is an early clean-room implementation of a Docker-first incident digest service for Home Assistant Core installations. The goal is to collect Home Assistant signals, turn them into normalized incidents, ask an AI provider for a structured summary, and send the resulting digest through configurable notification channels.

The project is inspired by the product shape of Home Assistant digest tools, but it is not a fork and does not copy upstream code.

## Current status

This repository is an early MVP implementation. Core backend contracts, persistence pieces, API protection, provider/notifier abstractions, and the first React onboarding shell are in place, but the runtime packaging is not finished yet.

Use it as a development project for now. Do not treat it as a ready-to-run Docker release until the Dockerfile, Compose file, data volume wiring, and browser smoke tests land.

## User-visible status

| Area | Status |
| --- | --- |
| Web UI | Spanish-first React/Vite onboarding flow with JSON i18n catalogs (`es` default, `en` available). |
| Setup flow | Home Assistant, AI provider, and Telegram fields are represented in the onboarding UI. |
| Privacy | UI-facing errors and setup flows include redaction and secret-scrubbing paths. |
| Manual digest | First-digest triggering is wired through the API client during onboarding. |
| Dashboard | Initial dashboard shell exists, but history, settings, notes, and ignore management are still planned. |

## Developer implementation status

| Area | Status |
| --- | --- |
| Workspace | pnpm TypeScript monorepo with backend, frontend, shared DTOs, Vitest, typecheck, build, and focused-test guard. |
| Shared contracts | Zod DTOs for setup, settings, digests, errors, notifiers, notes, and ignored warnings. |
| Backend boundaries | Domain interfaces for collectors, detectors, AI providers, notifiers, stores, jobs, and renderers. |
| Persistence | SQLite migration and store code for secrets and digest jobs, including secret masking and retry/idempotency behavior. |
| Home Assistant analysis | Collectors and incident detectors for Docker/Core-compatible signals, with Supervisor-only signals treated as unsupported where needed. |
| AI providers | OpenAI and Gemini provider abstractions with fake/test-safe adapters. |
| Notifications | Notifier abstractions including Telegram test/send support paths. |
| API safety | Protected API routes, session/setup-token handling, CSRF-aware cookie behavior, and redacted error responses. |
| Frontend | React/Vite shell, onboarding flow, JSON i18n catalogs, and API client wiring. |
| Privacy | Redaction paths for provider inputs, UI errors, and persisted delivery failures. |

## Screenshots

Screenshots are not committed yet because the project does not currently include a browser capture workflow. They will be added once the frontend can be captured reproducibly in CI or a documented local browser workflow.

Planned screenshot path once capture is available:

```text
docs/assets/screenshots/
```

Screenshot rules for future captures:

- Use the dark default UI.
- Capture blank/default or missing-token states only.
- Never show real Home Assistant tokens, AI keys, Telegram bot tokens, chat IDs, URLs, or private household data.
- Verify every referenced image exists before linking it from this README.

## Architecture overview

```text
React/Vite frontend
  -> protected HTTP API
  -> setup/settings/secret stores

Scheduler or manual run
  -> DigestJobStore
  -> DigestOrchestrator
  -> Home Assistant collectors
  -> IncidentDetector modules
  -> privacy redaction
  -> AIProvider: OpenAI | Gemini | fake
  -> safe report rendering
  -> ReportStore and DeliveryStore
  -> Notifier: Telegram | future channels
```

The code follows a ports-and-adapters shape. Product logic depends on small domain interfaces instead of framework modules, so collectors, providers, notifiers, renderers, persistence, and HTTP/UI concerns can evolve independently.

## Local development quick start

Prerequisites:

- Node.js 22 is recommended for local development until an explicit `.nvmrc` or `engines` field is added.
- pnpm. Do not use npm or npx in this repository.

Install dependencies:

```bash
pnpm install
```

Run the full local verification suite:

```bash
pnpm run ci
```

Run the frontend shell during development:

```bash
pnpm -C frontend dev
```

Build all workspaces:

```bash
pnpm run build
```

Notes:

- The backend package currently has build/typecheck scripts, but no standalone development server script is documented as production-ready.
- Docker runtime files are not present yet, so Docker installation instructions are intentionally not included here.

## Configuration and security notes

This tool is designed for sensitive Home Assistant environments. Treat configuration, logs, screenshots, and test fixtures accordingly.

- Never commit real Home Assistant tokens, AI provider keys, Telegram bot tokens, chat IDs, database keys, or Engram tokens.
- Never paste real secrets into screenshots or public docs.
- APIs should return masked secret references, not raw secrets.
- `/data` backups will be sensitive once Docker/runtime storage exists because they may include SQLite state and the app key.
- AI provider payloads should use redacted incident context, not raw unbounded Home Assistant logs or private entity data.
- Public documentation must stay honest about support: the current target is Home Assistant Core running in Docker first. Home Assistant OS/Supervised support is not promised yet.

## Current limitations and roadmap

| Item | Status |
| --- | --- |
| Full onboarding persistence | Partially implemented. Schedule/privacy persistence still needs final backend wiring. |
| Dashboard/history/settings UI | Planned after the onboarding slice. |
| Browser smoke tests | Planned with Playwright once the E2E layer is added. |
| Docker runtime | Not implemented yet. Dockerfile, Compose file, `/data` volume wiring, and mounted HA log examples are still pending. |
| Public installation docs | Pending Docker runtime completion. |
| Home Assistant OS/Supervised support | Not supported in the MVP until a dedicated adapter is designed and tested. |

## Repository layout

```text
backend/          Fastify API, application services, adapters, persistence
frontend/         React/Vite UI shell and onboarding flow
packages/shared/  Shared Zod DTOs and TypeScript contracts
openspec/         SDD planning artifacts for the MVP
docs/             Public and review documentation
tests/            Workspace-level test helpers and guards
```

## Verification commands

Useful checks before opening a review:

```bash
pnpm run ci
```

This currently runs typechecking, Vitest tests, the focused-test guard, and workspace builds.
