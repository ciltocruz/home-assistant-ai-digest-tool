# Design: Home Assistant AI Digest Tool MVP

## Technical Approach

The repo is initialization-only. Build a clean-room Docker-first pnpm TypeScript monorepo: Fastify backend, React/Vite frontend, shared Zod DTOs, SQLite under `/data`, Vitest, and Playwright only for browser flows. Use ports-and-adapters; services depend on domain interfaces.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Tooling | pnpm TS workspace; Fastify; React/Vite; Zod; Vitest; Playwright when needed | Python; single app | Type-aligned contracts, pnpm policy, clear API/UI boundary. |
| Access control | Backend single-admin token/session; localhost binding; reverse-proxy compatible | UI-only; multi-user | Sensitive routes need server auth; UI state is never authz. |
| Boundaries | Services depend on `Collector`, `IncidentDetector`, `AIProvider`, `Notifier`, `SecretStore`, stores | Framework modules | Enables fakes, privacy, future adapters. |
| Persistence | SQLite migrations; `/data/app.db`; compressed JSON blobs | Flat files; external DB | Local-first, Docker-mountable state. |
| Secrets/privacy | `SecretStore`, masks/refs, `RedactedDigestInput` | Raw config DTOs | Prevents logging, API leakage, unbounded AI payloads. |
| Scheduling | `DigestJobStore` unique `triggerWindowId`, retries/backoff | Timers only | Restart-safe idempotency. |

## Data Flow

```text
Frontend -> Auth middleware -> API -> Setup/Settings/SecretStore
Scheduler/API -> DigestJobStore(triggerWindowId) -> DigestOrchestrator
  -> Collectors -> IncidentDetectors -> IgnoreRules/Priority/Battery
  -> PrivacyRedactor(RedactedDigestInput) -> AIProvider -> SafeMarkdownRenderer
  -> ReportStore + DeliveryStore -> Notifier(Telegram/HA/email/markdown)
```

## File Changes

| File | Action | Description |
|---|---|---|
| `package.json`, `pnpm-workspace.yaml` | Create | Workspace scripts: typecheck, test, test:focused, build. |
| `backend/src/domain/*` | Create | Core types. |
| `backend/src/application/*` | Create | Setup, orchestration, scheduling, redaction, rendering. |
| `backend/src/http/*` | Create | Routes/auth. |
| `backend/src/adapters/{ha,ai,notifiers,persistence,security,rendering}/*` | Create | HA, providers, notifiers, SQLite, secrets, sanitizer. |
| `frontend/src/*` | Create | Onboarding, dashboard, history, notes, ignores, settings. |
| `packages/shared/src/*` | Create | Shared Zod DTOs. |
| `docker/`, `compose.yaml`, `Dockerfile` | Create | Docker runtime. |
| `docs/`, `README.md` | Create | Install/privacy docs. |
| `tests/`, `playwright.config.ts` | Create | Fixtures, fakes, guards. |

## Interfaces / Contracts

```ts
interface SecretStore { put(kind: SecretKind, raw: string): Promise<SecretRef>; resolve(ref: SecretRef): Promise<string>; mask(ref: SecretRef): Promise<MaskedSecret>; rotate(ref: SecretRef, raw: string): Promise<void>; }
interface DigestJobStore { enqueue(input: { triggerWindowId: string; kind: 'manual'|'daily'|'weekly' }): Promise<EnqueueResult>; leaseNext(): Promise<DigestJob|null>; complete(id: string): Promise<void>; retry(id: string, reason: string): Promise<void>; }
interface AIProvider { generate(input: RedactedDigestInput): Promise<StructuredDigest>; }
interface Notifier { test(target: ResolvedTargetConfig): Promise<TestResult>; send(digest: RenderedDigest, target: ResolvedTargetConfig): Promise<DeliveryResult>; }
type EnqueueResult = { status: 'queued'; jobId: string } | { status: 'already_queued'; jobId: string };
```

Auth acceptance: protect setup finalization, settings, secret refs, digest run/history, notes, ignores, notifier test/send, admin status. Sessions expire; logout invalidates server state. Cookies use `HttpOnly`, HTTPS `Secure`, `SameSite=Lax`; cookie mutations require CSRF/same-site checks. Bearer setup tokens do not. UI-disabled is not authz.

`SecretStore`: MVP default is SQLite `secrets` in `/data/app.db`, encrypted with `/data/app.key` (`0600` where supported). APIs return masks/refs only; `/data` backups are sensitive. Tests assert raw values never appear in logs, API DTOs, snapshots, errors, history.

`DigestJobStore.enqueue`: unique `triggerWindowId`. First insert returns `{status:'queued', jobId}`; duplicate queued/running/retryable returns `{status:'already_queued', jobId}` with no second row; completed windows need a new manual id.

`RedactedDigestInput`: `{window, privacyLevel, incidents[{type,severity,area,summary,redactedEvidence}], entityStats, notes[], unsupportedSignals[], redactionReport}`. Excludes tokens, full logs, over-private notes, unbounded HA payloads. Provider tests assert it precedes network calls.

Shared DTOs:

| Flow | Request/Response |
|---|---|
| Setup validation | `SetupValidationRequest {haUrl,haToken,aiProvider,aiKey,telegram?}` raw request only; response `MaskedSettings {haUrl,ai:{provider,keyMask,ref},notifiers[]}`. |
| Settings | `RedactedSettingsDto {haUrl,aiProvider,secretRefs,schedules,privacyLevel,retentionDays}`; never raw secrets. |
| Notifier test/send | `NotifierTestRequest {channel,targetRef,message?}` -> `TestResult`; `SendDigestRequest {digestId,targetRef}` -> `DeliveryResult`. |
| Digest run/history | `RunDigestRequest {kind,window?}` -> `{jobId,status}`; `DigestSummary {id,window,severityCounts,createdAt,deliveryStatus}[]`; empty history `[]`. |
| Ignores | `IgnoreRuleCreate {match,type?,expiresAt?,reason?}`; `IgnoreRuleDto {id,match,createdAt,expiresAt?}`; duplicate create is idempotent. |
| Errors | `ErrorDto {code,message,requestId,fieldErrors?}`; no raw secrets or provider payloads. |

Rendering: AI output, HA values, and notes are untrusted. Escape by default, sanitize markdown, disable raw HTML, test scripts/handlers/links/HTML blocks.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | redaction, sanitization, detectors, ignores, battery, priority, scheduler windows | Fixtures, fake clock, malicious samples. |
| Integration | auth, SQLite migrations/transactions, secret-safe DTOs, provider/notifier errors | Temp DB, fakes, concurrent enqueue tests. |
| E2E | onboarding, manual digest, history empty state, notes, ignores, Telegram test-send | Playwright when UI exists; `forbidOnly: true`; no live secrets. |
| CI guard | focused tests | CI runs focused-test detection; if Playwright exists, config must set `forbidOnly: true`. |

Edge cases: empty HA facts/history, invalid inputs, retry exhaustion, provider failure, cleanup, duplicate ignores, window-boundary notes, concurrent triggers, unsupported Docker/Core signals.

## Migration / Rollout

No seed data migration. Create transactional SQLite migrations before APIs serve. Digest creation, history save, and delivery status are transactional so provider/notifier failures preserve incidents and retry state. Use chained PRs under 400 lines.

## Open Questions

None
