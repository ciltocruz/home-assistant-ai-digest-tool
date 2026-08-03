# Docker Runtime Operations

This how-to is for operators running the Docker-first runtime with Home Assistant Core. Home Assistant OS and Supervised are not supported by this runtime.

## Start in local mode

Local mode is the default. It publishes only on loopback and deliberately uses non-Secure cookies for direct localhost HTTP.

1. Copy `.env.example` to `.env`. Do not commit this file; it contains runtime binding and log-mount configuration only.
2. Set `HA_LOG_FILE` to one existing `home-assistant.log` file. The container mounts that file read-only; do not mount the full Home Assistant configuration directory. Optional `HA_MAX_STATES`, `HA_MAX_LOG_LINES`, and `HA_MAX_RESPONSE_BYTES` constrain collection and analysis.
3. Start the service:

   ```bash
   docker compose up --build --detach
   ```

4. Confirm readiness:

   ```bash
   curl --fail http://127.0.0.1:3000/ready
   ```

`/health` reports process liveness. `/ready` additionally requires the frontend, SQLite data, and a readable HA log. A missing, empty, metadata-only, or unreadable HA log returns HTTP 503 and makes the Docker health check unhealthy.

## Complete protected onboarding and run a report

On first visit, choose a language, create the admin account, and complete the protected onboarding with the Home Assistant URL, dedicated long-lived token, provider, optional Telegram target, required schedule, timezone, and privacy settings. The first report is queued immediately; later reports can be launched from the dashboard. The server accepts only authenticated, CSRF-protected requests.

Each report reads complete lines from `/ha-logs/home-assistant.log` and the configured read-only Home Assistant API. It never mounts `/config`, uses Supervisor APIs, or mutates Home Assistant. Reports and their signature history are stored in `/data` and remain available after restart. The log baseline is limited to the history currently present in the mounted file; the runtime never opens rotated logs.

If a source is unauthorized, malformed, oversized, unavailable, or another analysis is already active, the request returns a safe code and stores no partial report. Roll back by deploying the previous image/Compose version while preserving `/data`.

## Start behind a controlled reverse proxy

Use reverse-proxy mode only when a controlled proxy terminates TLS. The application must receive its forwarded headers only from that proxy.

```bash
docker compose -f compose.yaml -f compose.reverse-proxy.yaml up --build --detach
```

The override sets `RUNTIME_MODE=reverse-proxy`, `TRUST_PROXY=true`, and `SECURE_COOKIES=true`. It intentionally keeps the published port on loopback, so place the reverse proxy on the same host or private network path. Do not expose the application port publicly without the proxy. A successful session response in this mode includes the `Secure`, `HttpOnly`, and `SameSite=Lax` cookie attributes.

## Verify the image and runtime boundary

Run the disposable verification harness from a checkout with Docker available:

```bash
pnpm verify:docker
```

The command builds and starts isolated local and reverse-proxy Compose projects. Its local overlay uses an internal fake Home Assistant service plus a mounted synthetic log to prove account-backed onboarding, authenticated collection, mounted-log analysis, report retrieval after restart, and a controlled source failure that adds no report. It verifies that onboarding, settings, completed jobs, and reports survive a restart. It also checks the forwarded-HTTPS/Secure-cookie contract, honest HA-log readiness, `/app` write denial, and `/tmp` and `/data` writes. It uses bounded waits; its exit trap removes the temporary containers, volumes, networks, and files. It does not print its supplied passwords, cookies, CSRF values, or authorization headers; failure diagnostics redact them.

### Verifier timeout and cleanup contract

The verifier owns a 180 seconds execution deadline. Callers must allow its 20-second cleanup grace and five-second cushion (205 seconds total), rather than killing it during teardown. Inspect the active contract instead of duplicating those values in automation:

```bash
bash scripts/verify-docker-runtime.sh --print-timeout-contract
```

Use the fast port/isolation check when Docker lifecycle coverage is not needed:

```bash
pnpm verify:docker:preflight
```

Preflight reserves the requested `VERIFY_DOCKER_PORT` exactly, or falls back from the historic port to an available local port when none is requested. It does not build images or start Compose services. A full run uses a fresh workspace, project name, and port; readiness and health diagnostics include the final observed HTTP and Docker-health states when the deadline expires.

The verifier cleans its own containers, networks, volumes, port holder, and workspace on normal exit, failure, SIGINT, and SIGTERM. At startup it can recover a stale verifier-owned record left by an untrappable termination, but skips live, incomplete, young, malformed, or unrelated records. If a run is interrupted, allow cleanup to finish before starting another one.

Rollback: revert the verifier script, its tests, `compose.verify.yaml`, this section, and the preflight package command together. These files affect only disposable verification resources; no product runtime data or Home Assistant behavior changes.

## Back up all persistent data

`/data/app.db` and `/data/app.key` are a single recovery unit. The database contains encrypted secret records and `app.key` decrypts them. Back up the complete `/data` volume while the application is stopped; copying only the database or only the key is not a usable backup.

From the repository root:

```bash
umask 077
backup_dir="$PWD/backups"
mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"
container_id="$(docker compose ps -q app)"
test -n "$container_id"
data_volume="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
test -n "$data_volume"
archive_name="ha-digest-data-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose stop app
docker run --rm \
  --mount "source=$data_volume,target=/data,readonly" \
  --mount "type=bind,source=$backup_dir,target=/backup" \
  alpine:3.20 sh -ec 'umask 077; archive="/backup/$1"; tar -C /data -czf "$archive" .; chmod 0600 "$archive"' sh "$archive_name"
docker compose start app
```

Treat the archive as a secret: it may contain the database, encryption key, runtime logs, and encrypted provider or notifier credentials. The command creates an owner-only backup directory and archive (`0700` and `0600` respectively); do not relax those modes. Test restoration before relying on it.

## Restore a full `/data` backup

> **Destructive:** restoring replaces the current contents of `/data`. Stop the application and choose the intended archive explicitly. Do not continue if the backup is incomplete.

```bash
backup_file="$PWD/backups/ha-digest-data-YYYYMMDD-HHMMSS.tar.gz"
container_id="$(docker compose ps -q app)"
data_volume="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
docker compose stop app
docker run --rm \
  --mount "source=$data_volume,target=/data" \
  --mount "type=bind,source=$(dirname "$backup_file"),target=/backup,readonly" \
  alpine:3.20 sh -ec 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /data -xzf "/backup/$(basename "$0")"' "$backup_file"
docker compose start app
```

After startup, check `/ready` and the container logs without pasting them into tickets or chat. A missing, malformed, or wrong `app.key` fails startup when encrypted secrets exist; restore the matching key from the same whole-`/data` archive rather than generating or substituting a new key.

## Protect `app.key`

The runtime creates `/data/app.key` as a 32-byte base64 AES-256 key with mode `0600` where the filesystem supports Unix permissions. It must remain readable only by the runtime user and must be treated as immutable application state:

- Do not edit, rotate, regenerate, or copy `app.key` independently of `app.db`.
- Do not replace it after setup when encrypted secrets exist; the runtime intentionally rejects a key that cannot decrypt stored secrets.
- Preserve the archive file's restrictive permissions and restore the complete `/data` directory together.

## Destructive fresh start

Use this only when permanently discarding all local settings, encrypted secrets, jobs, reports, logs, and the encryption key:

```bash
docker compose down --volumes
docker compose up --build --detach
```

This creates an empty `/data` volume and a new key on first start. It cannot recover data encrypted with the removed key.

## Current boundary

The runtime persists local settings, encrypted secrets, report jobs, reports, and signature history. It reads a narrow read-only HA-log mount and Home Assistant API data; it does not include a Home Assistant database adapter or a realtime watcher. AI provider and Telegram delivery are configuration-driven runtime integrations, but quiet and tool-failure runs never send Telegram notifications.

No Docker socket, host networking, privileged mode, full Home Assistant configuration mount, HA database mount, or Supervisor feature is supported. Roll back the application by restoring the prior image/Compose version and the matching `/data` backup; do not import preview-era report history into v2.
