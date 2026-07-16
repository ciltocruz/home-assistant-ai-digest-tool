# Docker Runtime Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Honest readiness, modes, observable failures, recovery, and hardening.

**Architecture:** Log first; compose readiness and enforce modes/privilege controls.

**Tech Stack:** TypeScript/Fastify, Vitest, pnpm, Docker, Bash.

---

Delivery decision: Chained PRs
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

Slice boundary: Slice 1 (PR #1, base feature/tracker branch) runtime contracts/readiness/logging; Slice 2 (PR #2, base PR #1 branch) Docker hardening; Slice 3 (PR #3, base PR #2 branch) container verification/recovery docs.

### Task 1: Runtime mode contract

**Files:** Create `backend/src/runtime-config.ts`, `backend/src/runtime-config.test.ts`; modify `backend/src/server.ts`, `backend/src/runtime-preview.ts`, `backend/src/http/app.ts`, `backend/src/http/app.test.ts`.

- [x] RED: test `defaults to safe local mode`, `rejects malformed booleans`, `unknown mode`, `non-loopback local publication`, and `requires trusted proxy and secure cookies`.
- [x] Run `pnpm exec vitest run backend/src/runtime-config.test.ts`; expect missing-module FAIL.
- [x] GREEN: define `RuntimeMode`, strictly parse four variables, and wire proxy trust/cookies.
- [x] Test forwarded IP/`Set-Cookie`; run `pnpm exec vitest run backend/src/runtime-config.test.ts backend/src/http/app.test.ts`; expect PASS.
- [x] Work-unit boundary (do not execute): `feat: enforce Docker runtime modes`.

### Task 2: Mandatory HA-log readiness

**Files:** Modify `backend/src/runtime-preview.ts`, `backend/src/runtime-preview.test.ts`.

- [x] RED: test `rejects unconfigured`, `missing`, `empty`, `unreadable`, `metadata-only HA logs`, and `accepts readable HA log`; failures expect 503/stable reason, `/health` 200.
- [x] Run `pnpm exec vitest run backend/src/runtime-preview.test.ts`; expect existing degraded-200 cases to fail.
- [x] GREEN: require `HA_LOGS_DIR`; accept only an openable file or directory containing one.
- [x] Re-run; expect PASS. Boundary: `fix: require readable HA logs`.

### Task 3: Startup logging and recovery safety

**Files:** Modify `backend/src/runtime-logging.ts`, `backend/src/runtime-logging.test.ts`, `backend/src/server.ts`, `backend/src/runtime-persistence.test.ts`.

- [x] RED: test `logs configuration failure before app construction`, `stderr fallback without secrets`, and `keeps only runtime.log and runtime.log.1`; retain key tests.
- [x] Run both via `pnpm exec vitest run backend/src/runtime-{logging,persistence}.test.ts`; expect FAIL.
- [x] GREEN: create `createRuntimeLogger` first; emit redacted startup/API events; cap at 256 KiB plus `.1`.
- [x] Re-run; expect PASS/no secrets. Boundary: `fix: make startup failures observable`.

### Task 4: Docker hardening and modes

**Files:** Modify `Dockerfile`, `compose.yaml`, `.env.example`; create `compose.reverse-proxy.yaml`.

- [x] RED: run `ADMIN_TOKEN=x SETUP_TOKEN=y docker compose config`; expect absent proxy variables.
- [x] GREEN: add loopback defaults and proxy override (`RUNTIME_MODE=reverse-proxy`, `TRUST_PROXY=true`, `SECURE_COOKIES=true`); enforce read-only root, `cap_drop`, no-new-privileges, PID limit, bounded `/tmp`, writable `/data`, and narrow read-only logs. Forbid socket, host network, privilege, and full HA config mounts.
- [x] Run `ADMIN_TOKEN=x SETUP_TOKEN=y docker compose -f compose.yaml -f compose.reverse-proxy.yaml config`; expect valid YAML. Boundary: `chore: harden Docker runtime`.

### Task 5: Container proof and recovery contract

**Files:** Create `scripts/verify-docker-runtime.sh`, `docs/operations/docker-runtime.md`; modify `README.md`, `package.json`.

- [ ] Add `pnpm verify:docker`: build/smoke both modes; verify proxy headers/Secure cookies, unreadable-log unhealthy transition, denied `/app` writes, allowed `/tmp`/`/data`, restart persistence, and trap cleanup.
- [ ] Document stopped whole-`/data` backup/restore, key permissions, immutable `app.key`, invalid-key failure, destructive reset, and HA DB-adapter deferral.
- [ ] Run `pnpm verify:docker`; expect PASS. Boundary: `test: add Docker boundary verification`.

### Task 6: Acceptance gate

- [ ] Run `pnpm run ci`; expect exit 0.
- [ ] Run `pnpm verify:docker`; expect exit 0, no secrets, hardening, readiness, startup logs, safe modes, persistence.
- [ ] Scan placeholders, inconsistent names, and coverage; expect no findings.
