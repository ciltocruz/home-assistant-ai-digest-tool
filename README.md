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
- Automated tests for the current backend and frontend slices.

Still pending before normal users should install it:

- Docker image and Compose example.
- Persistent data storage for the Docker release.
- Public installation guide.
- Browser smoke tests.
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

This runs typechecking, tests, the focused-test guard, and workspace builds.

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
- Add browser smoke tests.
- Add Dockerfile, Compose example, and `/data` volume documentation.
- Add safe screenshots once browser capture is available.

## Project principles

- Clean-room implementation. This is not a fork and does not copy upstream code.
- Docker-first for the initial release.
- Web UI included from the start.
- Spanish-first UI, with translation catalogs ready for future localization workflows.
- Secrets must be masked, redacted, and kept out of public artifacts.
