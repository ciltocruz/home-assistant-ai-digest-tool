# Home Assistant AI Digest Tool

Home Assistant AI Digest Tool is a Docker-first web application that turns Home Assistant Core log incidents into structured, actionable reports. It reads one mounted `home-assistant.log` file, groups stable error signatures, enriches reports with Home Assistant integration status, and can analyze findings with AI providers.

> **Supported deployment:** a standalone container on the same host as **Home Assistant Core running in Docker**. Home Assistant OS, Supervised, add-ons, Supervisor APIs, Docker socket access, host networking, and privileged containers are not supported.

## What it does

- Reads only one narrow, read-only Home Assistant log mount; it never reads log rotations or a full HA configuration directory.
- Keeps a byte cursor and permanent signature memory to identify new, recurring, reactivated, and latent errors.
- Learns older available log entries as a silent baseline. The lookback is bounded by the history present in the current file; rotation files are never read to extend it.
- Stores reports locally, retaining the newest 10 v2 reports by default without deleting signatures.
- Supports OpenAI, Gemini, and Ollama through interchangeable provider adapters. Context is redacted and bounded per signature, while every detected signature is eligible for analysis.
- Shows partial AI failures in the report. A complete AI failure is recorded in the web UI without advancing the log cursor.
- Queries Home Assistant integration status once per report; an unavailable API appears as unavailable without discarding the report.
- Sends a compact linked Telegram summary only for noteworthy findings. Quiet runs and tool failures never send a Telegram message.

## Important operating limits

AI costs scale with the number of error signatures analyzed and the schedule controls how often analysis runs. Review the provider's pricing and select a privacy level before enabling a production API key. The application minimizes provider input, but Home Assistant data remains sensitive.

The current runtime provides persisted report jobs, an immediate first report after onboarding, and manual report launches. Schedule definitions are stored with timezone and DST-safe slot logic; validate automated schedule behavior in your deployment before relying on it for unattended operations.

## Quick start

### Requirements

- Docker Engine with Docker Compose.
- Home Assistant Core running in Docker on the same host.
- One readable Home Assistant log file on that host.

Copy the environment template and set the log source:

```bash
cp .env.example .env
# Set HA_LOG_FILE to the host path of home-assistant.log.
docker compose up --build --detach
```

Open `http://127.0.0.1:3000`. Local mode binds only to loopback.

## Six-screen onboarding

The first browser visit selects a language, creates the admin account, then resumes the protected onboarding flow:

1. Home Assistant URL and long-lived access token.
2. OpenAI, Gemini, or Ollama provider configuration.
3. Optional Telegram bot token and chat ID.
4. Required schedule and timezone.
5. Privacy level and report retention.
6. An immediate first report.

Secrets are encrypted in `/data`, returned only as masks, and must never be committed, logged, or pasted into support requests. There are no bootstrap credentials in Compose or `.env`.

For TLS behind a controlled reverse proxy:

```bash
docker compose -f compose.yaml -f compose.reverse-proxy.yaml up --build --detach
```

The override enables trusted proxy headers and Secure cookies while the application port remains loopback-only.

## Report job lifecycle

The current runtime provides persisted report jobs, an immediate first report after onboarding, and manual report launches. Schedule definitions are stored with timezone and DST-safe slot logic; validate automated schedule behavior in your deployment before relying on it for unattended operations.

## Configuration

Settings are editable after setup. You can update the Home Assistant connection, AI provider, optional Telegram target and test-send, schedule, privacy level, report retention, password, ignored signatures, and operator notes. A masked secret is preserved unless you explicitly choose to replace it.

See [Configuration and integration status](docs/configuration.md) for provider, Telegram, privacy, cost, and troubleshooting details. See [Docker Runtime Operations](docs/operations/docker-runtime.md) for runtime verification, backup, restore, and rollback.

## Verification

```bash
pnpm run ci
pnpm verify:docker
```

The Docker verifier creates isolated local and reverse-proxy Compose projects, tests readiness and persistence, and removes its disposable resources on exit. It never needs your production Home Assistant or provider credentials.

## Security and data handling

- Keep the complete `/data` volume private: it contains SQLite data, the encryption key, encrypted credential records, and runtime logs.
- Back up `app.db` and `app.key` together; neither can restore encrypted settings alone.
- Use a dedicated Home Assistant long-lived token and only the required access scope.
- Do not mount `/config`, a Home Assistant database, Docker socket, or broad host paths.
- Use local mode only on a trusted host. For network access, terminate TLS at a controlled reverse proxy.

## Development

Use pnpm only:

```bash
pnpm install
pnpm run ci
```

This is a clean-room implementation inspired by the product shape of Home Assistant incident digests; it is not a fork.
