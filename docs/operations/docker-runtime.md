# Docker Runtime Operations

This how-to is for operators running the Docker-first preview with Home Assistant Core. Home Assistant OS and Supervised are not supported by this runtime.

## Start in local mode

Local mode is the default. It publishes only on loopback and deliberately uses non-Secure cookies for direct localhost HTTP.

1. Copy `.env.example` to `.env` and set long, unique `ADMIN_TOKEN` and `SETUP_TOKEN` values. Do not commit this file.
2. Set `HA_LOG_FILE` to one existing Home Assistant log file. The container mounts that file read-only; do not mount the full Home Assistant configuration directory.
3. Start the service:

   ```bash
   docker compose up --build --detach
   ```

4. Confirm readiness:

   ```bash
   curl --fail http://127.0.0.1:3000/ready
   ```

`/health` reports process liveness. `/ready` additionally requires the frontend, SQLite data, and a readable HA log. A missing, empty, metadata-only, or unreadable HA log returns HTTP 503 and makes the Docker health check unhealthy.

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

The command builds and starts isolated local and reverse-proxy Compose projects. It checks the forwarded-HTTPS/Secure-cookie contract, honest HA-log readiness, `/app` write denial, `/tmp` and `/data` writes, and `/data` persistence across a restart. It creates a temporary log fixture and volume, and its exit trap removes the temporary containers, volume, and files. It does not print its supplied test tokens; failure diagnostics redact them.

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

The runtime persists local settings, encrypted secrets, digest jobs, and report history. It does not yet include a Home Assistant database adapter. Use the narrow read-only HA log mount only; no Docker socket, host networking, privileged mode, or full Home Assistant configuration mount is supported.
