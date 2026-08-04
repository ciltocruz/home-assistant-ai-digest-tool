# Configuration and integration status

This is the public configuration reference for the Docker-first runtime. It supports a standalone container next to Home Assistant Core running in Docker. Home Assistant OS, Supervised, Supervisor APIs, add-ons, Docker socket access, host networking, and privileged containers are outside this support boundary.

## First-run onboarding (six screens)

The protected browser flow begins with language and admin-account creation, then persists these configuration checkpoints:

1. Home Assistant URL and long-lived access token.
2. AI provider.
3. Optional Telegram notification target.
4. Required schedule and timezone.
5. Privacy and retention.
6. Immediate first report.

Reloading the browser or restarting the container restores the saved non-secret progress. Secret fields are stored encrypted and return only configured/masked metadata. A setup validation failure leaves the previous secret intact; replace a secret only when you intentionally provide a new value.

## Edit saved settings

After onboarding, Settings lets the administrator update the Home Assistant connection, provider, Telegram target, schedule, privacy level, retention, password, ignored signatures, and operator notes. Existing secrets remain masked and unchanged until the operator explicitly selects a replacement.

## Home Assistant connection and log scope

Create a dedicated Long-Lived Access Token from the Home Assistant user profile's **Security** section. Store it through onboarding or Settings, never in `.env`. The application uses it for the supported read-only Home Assistant API and integration-status snapshot.

Set `HA_LOG_FILE` in `.env` to the host path of exactly one `home-assistant.log` file. Compose mounts it at `/ha-logs/home-assistant.log:ro`. The application reads complete log lines from this current file only, tracks a byte cursor, and safely restarts from zero after truncation or replacement. It does not read rotated logs, `/config`, a Home Assistant database, or arbitrary host paths.

The silent baseline uses entries older than the configured lookback, defaulting to 10 days. It can use only the history in the mounted current file and does not imply that older history was available. Recent entries are grouped into stable signatures and classified as New, Recurring, Reactivated, or Latent.

## OpenAI, Gemini, and Ollama

OpenAI, Gemini, and Ollama are interchangeable AI providers. Provider requests receive redacted, bounded context per signature. Every detected signature can be analyzed, so AI costs scale with incident volume and report frequency; select an appropriate provider plan, privacy level, and schedule before enabling production credentials.

Provider failures do not expose a secret. If some signature analyses succeed, the report is saved with a visible partial-analysis warning. If all provider analyses fail, the failed run is visible in the web UI and the log cursor does not advance.

ChatGPT-account login is not an authentication method for this release. Use a provider API key or the configured Ollama endpoint.

## Telegram notifications

Telegram is optional. Configure the bot token and chat ID in onboarding or Settings and use **Send Telegram test** to validate the saved target. The application sends a compact report summary with a report link only when findings are noteworthy.

When a run has no noteworthy findings, no Telegram message is sent. When collection, analysis, scheduling, or delivery cannot produce a trustworthy result, no Telegram message is sent either; the quiet or failed state remains visible in the web UI.

## Schedule, timezone, and retention

Onboarding requires a schedule and timezone. Schedule slot calculation is timezone-aware and has DST coverage for gaps, overlaps, restart recovery, and missed slots. The immediate first report is queued after successful onboarding; manual reports remain available from the dashboard.

V2 report retention keeps the newest 10 reports by default. Removing old report detail never deletes the permanent signature memory used for classification. Update retention intentionally in Settings and back up `/data` before destructive changes.

## Account and session security

The first operator creates the admin account in the browser. Password hashes use Argon2id; sessions and CSRF tokens are stored only as hashes. The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in controlled TLS reverse-proxy mode. Login failures are rate limited, and changing the password invalidates existing sessions.

## Report job lifecycle and recovery

Launching a report creates a durable queued job. The dashboard exposes queued, running, completed, and failed states with a safe retry when available. Completed report links remain valid after a browser reload or container restart. A failed job does not create a partial report; correct the safe UI error before retrying.

## Docker Compose settings

Copy the template:

```bash
cp .env.example .env
```

| Setting | Purpose |
|---|---|
| `HA_LOG_FILE` | Host path of the single Home Assistant log file mounted read-only. |
| `APP_PORT` / `APP_BIND_ADDRESS` | Local application binding; keep the default loopback address. |
| `RUNTIME_MODE`, `TRUST_PROXY`, `SECURE_COOKIES` | Local or documented controlled reverse-proxy cookie mode. |
| `HA_MAX_STATES`, `HA_MAX_LOG_LINES`, `HA_MAX_RESPONSE_BYTES`, `HA_ANALYSIS_TIMEOUT_MS` | Bounds for Home Assistant collection and analysis. |

There are no admin or setup tokens in `.env`. Do not put Home Assistant, provider, or Telegram credentials there.

## Privacy, local data, and recovery

`/data` contains the local SQLite database, `/data/app.key`, encrypted secrets, reports, jobs, and runtime logs. Treat the volume as sensitive. Back up and restore `app.db` and `app.key` together; a mismatched pair cannot decrypt saved settings.

The privacy setting controls the detail sent to AI. Redaction and bounded context reduce exposure but do not remove the need to assess your household data and provider terms. Do not paste secrets or private entity names into issues, screenshots, browser consoles, or logs.

## Troubleshooting

| Symptom | Safe next step |
|---|---|
| `/ready` returns 503 | Check that `HA_LOG_FILE` exists, is readable on the Docker host, and contains usable log data. |
| A report is failed | Read the safe UI error, verify Home Assistant/provider configuration, then retry once if offered. |
| A report has a partial warning | Review the successful findings and correct the affected provider configuration before the next run. |
| No Telegram message arrives | Confirm there were noteworthy findings and use the Settings test-send. Quiet and tool-failure runs intentionally do not notify. |
| Saved secrets cannot be decrypted after restore | Restore the matching complete `/data` backup, including `app.key`. |

For local/reverse-proxy setup, runtime verification, backup, restore, and rollback, see [Docker Runtime Operations](operations/docker-runtime.md).
