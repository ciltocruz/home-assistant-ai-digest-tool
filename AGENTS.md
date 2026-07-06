# Home Assistant AI Digest Tool — Agent Instructions

This project builds a public-ready, Docker-first Home Assistant incident analysis tool with a web UI, AI-generated digests, and configurable notifications.

## Product direction

- Build a **clean-room implementation** inspired by the product shape of `saihgupr/HomeAssistantDigest`; do not fork, copy, or extract upstream code.
- Target **Home Assistant Core running in Docker first**. Home Assistant OS/Supervised support may become future adapters, but must not be promised until designed and tested.
- The MVP includes a **web UI from the start**.
- Telegram must be configurable from the UI, including test-send support.
- AI providers must be interchangeable. Initial providers: **OpenAI** and **Gemini**.
- Initial setup should guide the user through Home Assistant connection, AI provider linking, and notifier configuration.
- Analyze broad Home Assistant incidents, not only raw log errors.

## Project boundaries

- Product code and product SDD artifacts belong in this project.
- Cisne-specific deployment, migration, and MkDocs operational notes belong in `cilto-infra`.
- Do not add new tooling to `~/scripts`; this must be a proper project with source, tests, docs, and deployment files.

## Engineering principles

- Be boring, practical, and maintainable.
- Prefer clear boundaries over clever abstractions.
- Apply SOLID where it helps readability and change isolation; do not over-engineer.
- Keep collectors, analyzers, providers, notifiers, persistence, and UI/API concerns separate.
- Design adapters around interfaces:
  - Home Assistant data sources
  - AI providers
  - notification channels
  - report renderers
  - persistence/config storage
- Make the first useful version small enough to review, but not a throwaway prototype.

## Expected architecture shape

Use this as guidance, not as a frozen stack decision:

- `backend/` — HTTP API, scheduler, collectors, analyzer orchestration, persistence.
- `frontend/` — setup flow, dashboard, digest history, settings.
- `docker/` or root Compose files — local and production container workflow.
- `docs/` — user-facing setup, architecture notes, deployment examples.
- `tests/` — unit and integration tests close to the code they verify.

Core concepts should remain independent of framework choice:

- `Collector` gathers raw facts from HA logs, HA API, or optional Docker metadata.
- `IncidentDetector` turns raw facts into normalized incidents.
- `AIProvider` turns incidents/context into a structured digest.
- `Notifier` sends digests to Telegram or future channels.
- `ReportStore` persists digests, configuration metadata, and history.

## Incident scope

Design incident collection as pluggable modules. Candidate sources:

- Home Assistant logs mounted from the host/container.
- Home Assistant REST/WebSocket API state.
- unavailable/unknown entities.
- stale sensors and stuck states.
- failed or suspicious automations.
- integration/config-entry issues when available.
- update availability when available.
- recorder/history gaps.
- optional Docker/container health for Docker installations.

Supervisor-only signals must be clearly marked as unsupported in Docker mode unless a dedicated adapter exists.

## Security rules

- Never commit, log, echo, document, or persist API keys, Telegram tokens, HA tokens, or Engram tokens.
- Treat any pasted key as sensitive and potentially compromised.
- Store secrets through runtime configuration or a secure app-managed store with masking in the UI.
- Logs must redact known secret patterns and provider tokens.
- Do not send raw sensitive Home Assistant data to AI providers unless the user explicitly configures that scope.
- Provider prompts should minimize data exposure and prefer summarized incident context.

## Package manager rule

- **Never use npm or npx.**
- Use **pnpm** for JavaScript/TypeScript tooling.
- If Python is chosen, use a modern reproducible workflow and document it clearly.
- Do not copy upstream `package-lock.json` or committed `node_modules` patterns.

## Testing and verification

- New behavior needs tests before or alongside implementation.
- Keep parsing logic covered with fixture-based tests.
- Keep provider and notifier adapters testable without live external calls.
- Use fake/sandbox implementations for OpenAI, Gemini, Telegram, and Home Assistant in tests.
- Do not claim work is complete until verification has run and the output is checked.

## Documentation expectations

- Public docs must be clear enough for someone who is not Marcos to install and run the tool.
- If support is Docker-only, say so prominently in the README.
- Include examples for Docker Compose, mounted HA logs, HA token setup, AI provider setup, and Telegram setup.
- Keep operational notes about Cisne in `cilto-infra` MkDocs, not in this product README unless they are generic examples.

## SDD and memory

- Store product SDD artifacts in Engram project `home-assistant-ai-digest-tool`.
- Keep `cilto-infra` memories only for homelab deployment and migration context.
- Use topic keys under `sdd/home-assistant-ai-digest-tool/...` for proposal, spec, design, tasks, apply progress, verify reports, and archive reports.
- Do not include secrets in Engram memories.

## Current decisions

- Clean-room rewrite over fork.
- Docker-first service over Home Assistant add-on for the initial product.
- Web UI included in MVP.
- Telegram configurable from UI.
- OpenAI and Gemini supported through a provider abstraction.
- Cisne is the first real test environment, not the only intended environment.
