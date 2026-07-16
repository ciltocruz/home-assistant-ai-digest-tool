# Docker Runtime Remediation Design

## Outcome and boundary

Task 5.2 closes only when readiness is honest, both network modes are safe, startup failures are observable, encrypted state is recoverable, and Docker is hardened. Task 5.3 starts after these contracts pass. A Home Assistant database adapter is out of scope.

## Context and review findings

The runtime serves built assets, persists SQLite under `/data`, runs as UID 1001, keeps `/app` root-owned, and records bounded request-failure JSONL with stderr fallback. Remaining blockers:

- `/ready` returns HTTP 200 when the configured HA log mount is missing, empty, or unreadable.
- Local and reverse-proxy deployments share cookie defaults; forwarded-header trust is undefined.
- Pre-construction failures bypass the runtime logger.
- `/data/app.db` and `/data/app.key` fail safely together, but backup and recovery requirements are not documented.
- Compose lacks read-only-root-filesystem, capability, and privilege-escalation controls.

## Runtime modes and configuration contracts

| Mode | Required contract |
|---|---|
| `local` (default) | Publish to loopback; set the explicit Docker environment variable `TRUST_PROXY=false`; direct HTTP and `SECURE_COOKIES=false` are allowed. Ignore forwarded client IP/protocol. |
| `reverse-proxy` | Require `TRUST_PROXY=true` and `SECURE_COOKIES=true`. Bind beyond loopback only behind the controlled proxy. |

`TRUST_PROXY` is an explicit Docker environment variable that defaults to `false`; `true` is the selected activation value, and IP/CIDR or hop-count syntax is not required in this iteration. Startup rejects unknown modes, malformed boolean values, reverse-proxy mode without `TRUST_PROXY=true` or `SECURE_COOKIES=true`, and non-loopback local publication. Forwarded-header trust is only safe when the service is actually behind the controlled proxy. Tests prove cookie attributes and startup rejection.

## Readiness and data flow

```text
Docker healthcheck -> /ready -> frontend + SQLite + HA-log readability
                                  | failure in any mandatory check
                                  v
                              HTTP 503
```

HA logs are mandatory for readiness. A file must open for reading; a directory must be listable and contain a readable regular file. Missing, empty, unreadable, or metadata-only paths return HTTP 503 with a stable, secret-safe reason. `/health` remains liveness-only.

## Logging and persistence recovery

Create the logger before environment validation and persistence. Emit secret-safe startup and API failure events to `/data/logs/runtime.log`; any write-path failure falls back to stderr. Rotation is bounded to a 256 KiB current file plus one `.1` generation.

Task 5.3 recovery docs MUST treat `/data/app.db` and `/data/app.key` as one sensitive unit: stop the container, consistently back up/restore all `/data`, preserve key permissions, and never replace `app.key` when encrypted secrets exist. Invalid keys fail startup. Resetting `/data` is an explicit destructive fresh start.

## Docker hardening

Retain UID/GID 1001 and root-owned code. Compose adds a read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, bounded processes, and bounded `/tmp` tmpfs. Only `/data` is writable; HA logs are narrowly mounted read-only. Forbid Docker socket, host networking, privileged mode, and full HA configuration mounts.

## Planned file changes

| File | Change |
|---|---|
| `backend/src/server.ts` | Parse/validate mode, proxy, cookie, and bind settings; log startup failures. |
| `backend/src/runtime-preview.ts` | Make readable HA logs mandatory for HTTP 200 readiness; pass proxy trust to Fastify. |
| `backend/src/runtime-logging.ts` | Generalize bounded logger for startup and API events. |
| `backend/src/*.test.ts`, `backend/src/http/*.test.ts` | Add RED tests for all contracts. |
| `Dockerfile`, `compose.yaml`, `.env.example` | Encode mode defaults and container hardening. |
| `README.md`, `docs/` | Deferred to task 5.3; document operation and recovery exactly as required above. |

## Test and verification strategy

1. Unit tests cover configuration parsing, rejected combinations, trusted/untrusted forwarded headers, secure cookies, startup stderr fallback, rotation, and every HA-log failure reason.
2. Integration tests cover startup with missing/corrupt/wrong keys and readiness with real temporary permissions/files.
3. Container verification runs `pnpm run ci`, Compose config validation for both modes, image build, local-mode smoke, reverse-proxy-header smoke, health transition to unhealthy without readable HA logs, read-only-rootfs writes, and restart persistence.

## Phases and acceptance criteria

1. **Contracts first:** failing tests define mode, readiness, logging, and recovery behavior.
2. **Runtime remediation:** implement only enough to pass those tests.
3. **Container hardening:** apply Compose/image controls and smoke-test both modes.
4. **Close 5.2:** all checks pass; no secrets appear in output; missing HA logs make Docker unhealthy; startup failures remain visible; state survives restart; hardened container starts normally.
5. **Begin 5.3:** publish installation, proxy, backup/recovery, privacy, and troubleshooting guidance. Do not add the HA database adapter in either phase.

## Threat matrix

| Boundary | Applicability | Reason |
|---|---|---|
| Documentation-like paths | N/A | No executable-file classification or command execution. |
| Git repository selection | N/A | No VCS automation. |
| Commit state | N/A | No commit automation. |
| Push state | N/A | No push automation. |
| PR commands | N/A | No PR automation. |
