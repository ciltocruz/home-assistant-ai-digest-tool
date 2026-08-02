# Home Assistant AI Digest Tool

Home Assistant AI Digest Tool is a Docker-first, work-in-progress web app intended to help Home Assistant users understand incidents without reading raw logs by hand.

The goal is simple: collect relevant Home Assistant signals, detect incidents, summarize them with an AI provider, and send a clear digest through channels such as Telegram.

> **Status:** the Docker runtime supports persisted onboarding and settings, durable local report jobs, and deterministic report generation from Home Assistant REST states plus one mounted log file. OpenAI/Gemini and Telegram credentials can be stored and edited safely, but this runtime does not send provider or notification traffic.

## What it is for

- Find important Home Assistant issues faster.
- Turn noisy logs and unavailable entities into readable incident summaries.
- Use AI providers such as OpenAI or Gemini.
- Send digests through notification channels such as Telegram.
- Keep sensitive Home Assistant data protected with redaction and secret masking.

## Current status

The project currently includes:

- A Spanish-first web UI with a persisted six-screen onboarding flow.
- Editable Home Assistant, AI provider, optional Telegram, schedule, privacy, and retention settings with masked secrets.
- Durable queued, running, completed, and failed report jobs with safe retry and report-detail links.
- Backend foundations for incidents, providers, notifications, storage, and safe API access.
- Spanish as the default UI language, with English translations prepared.
- A hardened Docker Compose runtime with persistent `/data`, a narrow read-only Home Assistant log mount, readiness checks, and recovery guidance.
- Automated unit/integration tests, Playwright browser smoke tests, and a built-container verification harness.

The following boundaries are deliberate and important:

- Supported deployment target: standalone Docker next to **Home Assistant Core running in Docker**.
- Unsupported deployment targets: Home Assistant OS, Supervised, Supervisor APIs, add-ons, Docker socket access, host networking, and privileged containers.
- The runtime persists local onboarding checkpoints, settings, encrypted secret records, report jobs, and report history; manual analysis reads bounded HA states and the mounted log locally, then creates a deterministic Markdown digest.
- Provider and notifier adapter classes are covered by fake/injected-client tests. Their presence does not mean the Docker preview sends external traffic.

See [Configuration and integration status](docs/configuration.md) for the exact support matrix, credential guidance, report behavior, and troubleshooting.

## Six-screen onboarding

On first visit, complete the screens in this order: **Home Assistant**, **AI provider**, **notification channel**, **schedule**, **privacy**, and **first report**. Each completed screen is saved by the backend before the next screen opens. Reloading the browser or restarting the container resumes the saved screen; secret values remain encrypted and appear only as masks.

The final screen creates an authenticated session and queues the first report. Repeating a completed setup does not create a second configuration. If a screen reports an error, correct that screen and continue; do not paste secrets into browser-console output, logs, or support requests.

## Settings after onboarding

Settings are editable after setup from **Configuración**. You can change the Home Assistant URL, provider selection, optional Telegram chat, daily or weekly schedule, privacy level, and retention period. This is also where you manage operator notes, ignored warnings, and the Telegram test send; the Dashboard has no duplicate configuration controls. For each stored secret, explicitly choose **Conservar el valor actual** or **Reemplazar con un valor nuevo**. The UI never preloads a raw token or key, and a failed save leaves the previously saved configuration intact. Removing an ignored warning requires confirmation.

## Report job lifecycle

**Lanzar informe** immediately creates a persisted report job rather than waiting for analysis in the browser. The dashboard shows its state as **En cola**, **En curso** with the current stage, **Completado** with a link to the saved report, or **Fallido** with a safe recovery message. A failed job can be retried once when the dashboard offers **Reintentar informe**. The browser may reload at any point: the backend remains the source of truth for jobs and completed reports.

For the URL-backed shell, Configuration ownership, report detail behavior, and accessibility rules, see [Experience shell architecture](docs/architecture/experience-shell.md).

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

The repository includes a Docker-first runtime preview for Home Assistant Core. It serves the built Spanish-first UI and protected API. It is not an HAOS/Supervised add-on and is not a production release.

```bash
cp .env.example .env
# Set ADMIN_TOKEN and SETUP_TOKEN to different long random values before starting.
# Set HA_LOG_FILE to one existing Home Assistant log file on the Docker host.
docker compose up --build --detach
```

Then open `http://localhost:3000`.

The Compose runtime is local-only by default: it binds `127.0.0.1:3000` and requires explicit, different `ADMIN_TOKEN` and `SETUP_TOKEN` values from `.env`. Configure the Home Assistant URL and token through the protected six-screen onboarding, then run an authenticated manual report. Generate bootstrap tokens locally; never commit `.env`. Do not change local mode to `0.0.0.0`; use the documented reverse-proxy mode instead.

The default `SECURE_COOKIES=false` setting is only for this localhost HTTP preview. For a TLS-terminating proxy, start with the explicit override, which requires trusted proxy headers and Secure cookies:

```bash
docker compose -f compose.yaml -f compose.reverse-proxy.yaml up --build --detach
```

The Compose file creates a `/data` volume for persistent SQLite state and `/data/app.key`. Set `HA_LOG_FILE` in `.env` to one real log file. It is mounted read-only and consumed as a bounded tail during manual analysis; `/ready` returns HTTP 503 when it is missing, empty, metadata-only, or unreadable. Do not mount the full Home Assistant configuration directory or Docker socket.

The preview container exposes unauthenticated `/health` and `/ready` endpoints. `/health` is liveness-only; `/ready` includes the frontend, SQLite, and readable HA-log checks. Run the disposable Docker boundary harness with:

```bash
pnpm verify:docker
```

For local mode, reverse-proxy requirements, backup/restore, encryption-key handling, destructive reset, and the current runtime boundary, see [Docker Runtime Operations](docs/operations/docker-runtime.md). For token, provider, Telegram, email, and Markdown-report behavior, see [Configuration and integration status](docs/configuration.md).

## Security notes

Home Assistant data is sensitive. Treat this project like infrastructure software, not like a toy demo.

- Do not commit real Home Assistant tokens.
- Do not commit OpenAI, Gemini, Telegram, database, or app keys.
- Do not paste real secrets into issues, screenshots, logs, or documentation.
- Do not share screenshots that include private entity names, URLs, tokens, or household data.
- Keep `/data` backups private: they contain the database, encryption key, runtime logs, and encrypted credential records.
- Do not put Home Assistant, OpenAI, Gemini, or Telegram credentials in `.env`; only the application bootstrap/admin tokens and log-file path belong there today.
- Home Assistant OS and Supervised installs are not supported; the target is standalone Docker with Home Assistant Core in Docker.

## Roadmap

Near-term work:

- Add optional live AI provider calls, notifier delivery, and schedule execution without changing the local-only report-job path.
- Add an operator-safe interactive setup path for the persistent Docker runtime.
- Add email and Home Assistant notification adapters only after their runtime configuration and verification exist.
- Add safe screenshots once browser capture is available.

## Project principles

- Clean-room implementation. This is not a fork and does not copy upstream code.
- Docker-first for the initial release.
- Web UI included from the start.
- Spanish-first UI, with translation catalogs ready for future localization workflows.
- Secrets must be masked, redacted, and kept out of public artifacts.
