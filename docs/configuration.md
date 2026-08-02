# Configuration and integration status

This page is the public configuration reference for the Docker-first runtime. It persists onboarding, settings, report jobs, and reports in local SQLite; a manual job reads bounded Home Assistant REST states and one read-only mounted log file, then stores a deterministic local Markdown digest. It does not call AI providers or notifiers.

## Quick path

1. Run the local Docker Compose preview with one read-only Home Assistant log file.
2. Check `http://127.0.0.1:3000/ready`.
3. Read the support matrix before configuring any external credential.
4. Complete the six-screen onboarding in the browser, then use [Docker Runtime Operations](operations/docker-runtime.md) for reverse proxy, backup, restore, and reset procedures.

## First-run onboarding (six screens)

The protected browser flow saves one checkpoint at a time: **Home Assistant**, **AI provider**, **notification channel**, **schedule**, **privacy**, and **first report**. A reload or container restart restores the next required screen with saved non-secret values and masked secret metadata. The browser never stores raw Home Assistant, provider, or Telegram credentials as workflow state.

The last screen commits the configuration and queues the first report. If the backend rejects a screen, correct the displayed field and submit it again. Do not work around a validation error by placing product credentials in `.env`.

## Edit saved settings

Open **Configuración** after onboarding to edit every saved connection, notification preference, schedule, privacy level, and retention period. Each secret is an explicit operation:

- **Conservar el valor actual** keeps the encrypted secret reference unchanged.
- **Reemplazar con un valor nuevo** validates and atomically stores a new secret.

Secret inputs start empty, current values are masked, and API responses never contain the raw secret. When a settings save fails, no related setting or secret is partially changed; review the safe error, correct the input, and retry.

## Report job lifecycle and recovery

Choosing **Lanzar informe** returns a durable job immediately. The dashboard polls persisted state and exposes **En cola**, **En curso** with a progress stage, **Completado** with a report link, or **Fallido** with a safe error and, when permitted, **Reintentar informe**. Retry is bounded; repeated retry requests return the current job state rather than creating duplicate work.

Jobs and completed reports survive browser reloads and container restarts. A completed report opens from its saved link without rerunning collection. If a report is unavailable after retention cleanup, return to the panel, refresh history, and create a new manual report only when required.

## Support matrix

| Area | Current behavior | Operator action |
|---|---|---|
| Docker Compose runtime | Supported for a standalone container next to Home Assistant Core in Docker. Local and controlled reverse-proxy modes are verified. | Follow the README and operations guide. |
| Home Assistant log mount | Supported as one narrow, read-only file mount and required by `/ready`. | Set `HA_LOG_FILE` to one readable log file. |
| Home Assistant REST collection | Supported for bounded read-only `/api/states` requests with an encrypted saved token. | Configure HA URL/token through protected onboarding and use a manual report. |
| OpenAI and Gemini | Adapter classes exist and are tested with fake HTTP clients; neither is live-wired in the preview. | Do not expect provider traffic or generated digests. |
| Telegram | Setup data can be represented and the UI has a test control; the preview deliberately does not send real messages. | Treat every preview test-send as an expected safe failure. |
| Markdown reports | A deterministic local Markdown digest is persisted, linked to its completed job, and displayed in history/detail. | No external Markdown export target exists. |
| Email and Home Assistant notifications | Not implemented in the Docker preview. | No email or HA notification configuration is available. |
| Home Assistant OS, Supervised, and Supervisor APIs | Unsupported. | Use neither add-on nor Supervisor-specific setup. |

## Docker Compose settings

Copy the supplied template and keep the resulting `.env` private:

```bash
cp .env.example .env
```

Set these values before starting the container:

| Setting | Purpose | Notes |
|---|---|---|
| `ADMIN_TOKEN` | Creates an administrator session through the protected API. | Required; use a long random value. |
| `SETUP_TOKEN` | Protects first-run setup API calls. | Required; use a different long random value. It is server-side in the persistent preview and the browser has no token-entry flow. |
| `HA_LOG_FILE` | Source path of one Home Assistant log file on the Docker host. | Required for readiness; mounted at `/ha-logs/home-assistant.log:ro`. |
| `APP_PORT` | Host port for the local preview. | Defaults to `3000`. |
| `APP_BIND_ADDRESS` | Host bind address. | Keep the default `127.0.0.1` for local mode. |

Generate `ADMIN_TOKEN` and `SETUP_TOKEN` locally, for example with `openssl rand -base64 32`. Do not place Home Assistant, provider, or Telegram credentials in `.env`.

`HA_LOG_FILE` must resolve on the Docker host, not inside the container. A missing, empty, metadata-only, or unreadable target makes `/ready` return HTTP 503 and the Compose health check unhealthy. Mount exactly one log file: never mount the full Home Assistant configuration directory, a database directory, a Docker socket, or host paths with broader access than needed.

## Home Assistant token and log access

Create a dedicated Long-Lived Access Token in Home Assistant from your user profile's **Security** section. Copy it once, grant it only the access required by the integration, and store it like a password.

The protected setup API encrypts the token in `/data`; it is resolved only inside the REST adapter for a read-only states request. Use local HTTP only for trusted local Docker networking, or configure HTTPS normally—TLS verification is never disabled.

The read-only log mount is independent of the access token. Manual analysis reads a bounded tail; do not mount a directory or extra HA configuration.

## OpenAI and Gemini providers

The codebase has interchangeable OpenAI and Gemini provider adapters. They receive a minimized, redacted digest input when used by application code and their tests do not make live network calls. The Docker preview does not construct or call either adapter.

The onboarding and settings UI let you choose `OpenAI` or `Gemini` and safely replace a key, but this does not enable provider access in the current Docker runtime. Do not use a production API key to test this preview. When a live provider path is released, this page will document the supported models, outbound-network requirements, cost controls, and provider-specific validation.

## Telegram, email, and Markdown reports

### Telegram setup and test-send

The onboarding model accepts a Telegram bot token and chat ID, and the dashboard can show a Telegram test button after a target is stored. In the persistent Docker preview, `/api/notifiers/test` returns a safe failure because notification adapters are not live-wired. No Telegram message is sent, and that result does not validate your bot token or chat ID.

Do not place Telegram credentials in `.env`, screenshots, issue reports, or chat transcripts. Wait for a live, validated Telegram configuration flow before using a production bot.

### Email and Home Assistant notifications

Email delivery and Home Assistant notification delivery are not implemented in the preview. There are no SMTP, webhook, or HA-notification environment variables to configure.

### Markdown reports

Digest content is designed to be safely rendered as Markdown, and report records can be stored locally. The preview does not run a live digest pipeline, so it does not create a report file or send Markdown to a target. A Markdown notifier adapter is isolated and tested, but it has no runtime target configuration or writable output mount in Compose.

## Privacy, secrets, and local data

The runtime stores its local SQLite database and encryption key in `/data`. Secret records are encrypted with `/data/app.key`; API responses are designed to return masked values or references rather than raw tokens. Runtime logs and errors must remain secret-safe, but operators must still protect the host, Docker volume, backups, and `.env` file.

Treat the full `/data` volume as sensitive. Back up and restore it as one unit—`app.db` and `app.key` cannot be recovered independently. The [operations guide](operations/docker-runtime.md) has the supported whole-volume procedure and destructive-reset warning.

Before any future provider call, digest input is designed to be redacted and minimized. That does not make the preview suitable for sending real household data: there is no live provider path to verify yet.

## Troubleshooting

| Symptom | Likely cause | Safe next step |
|---|---|---|
| `docker compose up` rejects a setting | A required application token is empty or runtime-mode values are inconsistent. | Recheck `.env`; keep local mode defaults or use only the documented reverse-proxy override. |
| `/health` works but `/ready` returns 503 | The HA log mount, frontend, or SQLite check is not ready. | Verify `HA_LOG_FILE` exists and is readable on the Docker host; inspect `docker compose logs app` without copying sensitive output into tickets. |
| The UI loads but no digest arrives | HA access, mounted log, or protected session is unavailable. | Check the safe API error and `/ready`; do not paste tokens into logs or tickets. |
| Telegram test-send reports failure | Expected preview boundary. | No real Telegram request is made; do not retry with production credentials. |
| No OpenAI or Gemini traffic appears | Expected preview boundary. | Provider adapters are not live-wired. |
| A restore cannot decrypt secrets | The database and `app.key` came from different backups. | Stop the app and restore the matching complete `/data` archive. |
| Setup returns to an earlier screen after reload | The next checkpoint was not saved or the backend rejected it. | Read the field-level error, correct that screen, and submit it again; do not re-enter masked secrets unless replacing them. |
| A report stays in **En cola** or **En curso** | The worker has not completed the persisted job or the browser is offline. | Reload the dashboard after checking `/ready`; the saved job state resumes from the backend. |
| A report is **Fallido** | Collection or rendering failed with a classified safe error. | Follow the displayed recovery action, then use **Reintentar informe** once when it is available. |

## Current limitations

- This is Docker-first for standalone Home Assistant Core deployments only; it is not an HA add-on.
- The port stays loopback-only in local mode. Use the supplied reverse-proxy override only behind a controlled TLS-terminating proxy.
- REST states and a mounted-log tail are the only live collection sources; live AI calls, scheduled job execution, Telegram/email/Home Assistant delivery, and Markdown export remain unavailable. Manual report jobs are durable and run in the same process.
- No Docker socket, host networking, privileged mode, full HA configuration mount, HA database mount, or Supervisor feature is supported.
- The UI is Spanish-first. English translation resources exist, but a public language selector is not part of the preview.
