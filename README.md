# Home Assistant AI Digest Tool

Home Assistant AI Digest Tool is a work-in-progress web app that will help Home Assistant users understand what happened in their home without reading raw logs by hand.

The goal is simple: collect relevant Home Assistant signals, detect incidents, summarize them with an AI provider, and send a clear digest through channels such as Telegram.

> **Status:** early MVP. The web UI and backend foundations are being built, but this is not a ready-to-install Docker release yet.

## What it is for

- Find important Home Assistant issues faster.
- Turn noisy logs and unavailable entities into readable incident summaries.
- Use AI providers such as OpenAI or Gemini.
- Send digests through notification channels such as Telegram.
- Keep sensitive Home Assistant data protected with redaction and secret masking.

## Current status

The project currently includes:

- A Spanish-first web UI with onboarding screens.
- Home Assistant, AI provider, and Telegram setup fields in the UI.
- Backend foundations for incidents, providers, notifications, storage, and safe API access.
- Spanish as the default UI language, with English translations prepared.
- Automated unit/integration tests and Playwright browser smoke tests for the current backend and frontend slices.

Still pending before normal users should install it:

- Production-ready Docker runtime wiring.
- Persistent app storage connected to the final Docker release.
- Public installation guide.
- Full dashboard, history, settings, notes, and ignore-management screens.

## Screenshots

Screenshots are not available yet.

They will be added when the project has a reproducible browser capture workflow. Future screenshots should use the dark UI and must never show real Home Assistant URLs, tokens, AI keys, Telegram tokens, chat IDs, entity names, or private household data.

Planned location:

```text
docs/assets/screenshots/
```

## Try the development preview

This is only for contributors or early testers. It is not the final Docker installation path.

### Requirements

- Node.js 22.
- pnpm.

Do not use npm or npx in this repository.

### Install dependencies

```bash
pnpm install
```

### Run the frontend preview

```bash
pnpm -C frontend dev
```

The UI is currently Spanish-first. English translations exist in the locale catalog, but a public language switcher is not part of the MVP yet.

### Run checks

```bash
pnpm run ci
```

This runs typechecking, unit/integration tests, the focused-test guard, Playwright Chromium smoke tests, and workspace builds. To run only the browser smoke tests, use:

```bash
pnpm run test:smoke
```

The smoke command installs Playwright Chromium if it is missing.

### Run the Docker preview

The repository includes an early Docker preview so contributors can build the backend and frontend together. It serves the built Spanish-first UI and a protected preview API, but it is not the final production install path yet.

```bash
cp .env.example .env
# Replace ADMIN_TOKEN and SETUP_TOKEN with long random values before starting.
docker compose up --build
```

Then open `http://localhost:3000`.

The Compose preview is local-only by default: it binds `127.0.0.1:3000` and requires explicit `ADMIN_TOKEN` and `SETUP_TOKEN` values from `.env`. In the persistent runtime the setup token stays private and server-side; the current UI does not expose a manual setup-token entry flow yet. Do not bind the preview to `0.0.0.0` unless you understand this is still an early preview and have added your own network protection.

The default `SECURE_COOKIES=false` setting is only for this localhost HTTP preview. Use secure cookies for HTTPS or reverse-proxy deployments.

The Compose file creates a `/data` volume for the partially real persistent runtime. Setup/settings secrets, digest job queue state, and report history are now backed by SQLite plus `/data/app.key`; external Home Assistant collection, live AI provider calls, live notifier delivery, and scheduler execution are still pending. The optional read-only `HA_LOGS_PATH` mount placeholder is for future Home Assistant log collection. The example path is outside the repository (`/tmp/ha-digest-preview/ha-logs`) so real Home Assistant logs are not normalized as project files; if you use a repo-local scratch folder anyway, `.preview/` is ignored by Git and Docker.

The preview container also exposes unauthenticated `/health` and `/ready` endpoints for local Docker health checks.

## Security notes

Home Assistant data is sensitive. Treat this project like infrastructure software, not like a toy demo.

- Do not commit real Home Assistant tokens.
- Do not commit OpenAI, Gemini, Telegram, database, or app keys.
- Do not paste real secrets into issues, screenshots, logs, or documentation.
- Do not share screenshots that include private entity names, URLs, tokens, or household data.
- Home Assistant OS and Supervised installs are not supported yet; the first target is Home Assistant Core running in Docker.

## Roadmap

Near-term work:

- Finish the onboarding and settings flows.
- Build the dashboard, digest history, notes, and ignored-warning UI.
- Expand browser smoke coverage as new runtime capabilities become available.
- Wire external Home Assistant, AI provider, notifier, and scheduler adapters into the persistent runtime.
- Add safe screenshots once browser capture is available.

## Project principles

- Clean-room implementation. This is not a fork and does not copy upstream code.
- Docker-first for the initial release.
- Web UI included from the start.
- Spanish-first UI, with translation catalogs ready for future localization workflows.
- Secrets must be masked, redacted, and kept out of public artifacts.
