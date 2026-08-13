# Refactor Prompt — Home Assistant AI Digest Tool (v2)

> Hand this prompt to the AI that will perform the refactor. Read it fully before starting. If any requirement is ambiguous, ask before implementing — do not guess.

## Role

You are a senior full-stack engineer refactoring an existing, public-ready project. This is a **refactor of a working codebase**, not a rewrite from scratch: reuse every sound piece (onboarding shell, settings, encrypted secret store, report persistence, provider abstraction, Docker Compose, test harness) and replace the analysis core with the new batch model described here. Work **in the existing repository**, in place, and leave it green: all tests passing, typecheck clean, Docker image building.

## Project context

- Repository: `home-assistant-ai-digest-tool` (TypeScript pnpm monorepo: `backend/`, `frontend/`, `packages/`).
- Stack: Node.js 22, TypeScript, pnpm workspaces, SQLite persistence, Vite frontend, Vitest, Playwright.
- **Hard rule: pnpm only. Never use npm or npx.**
- Existing assets to keep and evolve: six-screen onboarding concept, settings with masked secrets, encrypted secret store, report job persistence, provider/notifier adapter abstractions (currently OpenAI + Gemini + Telegram), hardened Docker Compose with `/data` volume and readiness checks, `pnpm run ci` pipeline (typecheck + tests + focused-test guard + Playwright smoke + build).
- The current runtime is a local-only preview that does NOT send real provider or Telegram traffic. The refactor makes the tool actually work end to end.
- The project name stays the same. UI copy and code artifacts are written in English by default (see Language section).

## Product definition

A Docker-first web tool for Home Assistant (Core, running in Docker) that periodically analyzes the Home Assistant log, detects problems worth knowing about, generates an AI report, shows it in the web UI, and sends a summary to Telegram.

### Hard deployment boundary (must be prominent in README and docs)

- The tool runs as a Docker container **on the same machine as Home Assistant Core (Docker)**.
- The single log file `home-assistant.log` is mounted **read-only** into the tool container. No other log files are read: `home-assistant.log.1`, `.2`, etc. are explicitly NOT read, neither at first run nor later.
- **Home Assistant OS, Supervised, and add-on installs are NOT supported** and this must be stated clearly and prominently in the README.
- No Docker socket access, no host networking, no privileged containers.
- Keep the existing reverse-proxy mode (TLS termination + Secure cookies) and local-only mode.

### Error model (the domain core)

1. **Levels**: ERROR and CRITICAL log entries are "errors". WARNING is excluded by default, behind a configurable toggle in settings ("include warnings").
2. **Error signature**: a stable identity derived from component (the bracketed module), level, and the message with volatile parts stripped (timestamps, IDs, line numbers, IPs, dynamic numbers). Recurrences of the same problem share one signature. Store signatures persistently forever — the store is the memory that makes "new" meaningful.
3. **New error**: first-ever occurrence of a signature. This is what reports flag as new.
4. **Recurring error**: a known signature appearing within the current period; grouped under its signature with count and trend vs. the previous period.
5. **Reactivated error**: a known signature that reappears after a configurable reactivation window (default 7 days, configurable). Reactivations are reported again, distinguished from new errors.
6. **Latent error**: a signature that already existed before the lookback window and is still appearing — a carried problem, reported as persistent, never as new.

### Batch analysis model (no real-time)

- **There is no continuous watcher and no immediate alerting.** On each scheduled run the tool:
  1. Reads the log delta since the last run. Persist the last-read byte offset. If the file is truncated or replaced (size smaller than the stored offset), restart from the beginning and let signature deduplication make re-reads safe.
  2. Detects new, recurring, and reactivated signatures for the period.
  3. Collects integration status from the Home Assistant API (see below).
  4. Generates the AI report (bounded context, see below).
  5. Sends a Telegram summary (if configured and there is something to say).
  6. Persists the report in the web UI.
- **Silence rule**: if the run finds no new errors, no reactivations, and no notable findings, **no Telegram message is sent**. The web still records the run ("no changes").
- **Run failure handling**: if a run itself fails (log file unreadable, provider down, scheduling error), the failure is recorded and shown in the web dashboard. **No Telegram message for tool failures** — silence means "nothing to report", never alarm about the tool's own health.
- Log parsing must be covered by fixture-based tests using **real Home Assistant log lines** (format example: `2026-08-02 10:15:33.123 ERROR (MainThread) [homeassistant.components.zwave_js] Message text`).

### First run (baseline)

- The first run reads the current `home-assistant.log` only.
- Entries **older than the lookback window** (configurable, default 10 days) are learned **silently** as known signatures (baseline) — no report content, no notifications.
- Entries **within the last 10 days** are reviewed and produce the first report, distinguishing **new** (not in baseline) from **latent/persistent** (in baseline and still appearing).
- The lookback window is bounded by what the current log file actually contains; document this honestly.
- When onboarding completes, the first run (baseline + first report) executes **immediately** so the user validates everything works; afterwards, runs follow the schedule.

### Scheduling

- **No default schedule**: choosing one is a mandatory onboarding step.
- Presets: every 15 minutes, 30 minutes, 1 hour, 6 hours, 12 hours, daily. Choosing **daily** requires picking the execution hour of day.
- **Custom**: one or more weekdays + a time of day.
- **Timezone**: a timezone setting (default: the container's timezone) governs when daily/custom times fire and how schedule times are displayed. **Daylight-saving correctness is a hard requirement: extensive tests with fake clocks across winter/summer time transitions** — a daily run must never fire an hour off because of DST.
- The scheduler must be idempotent and testable (fake clock); a missed run must not double-fire or lose the delta.

### Report content

1. **Executive summary**: counts for the period (new, recurring, reactivated, latent), and trend vs. the previous period.
2. **New errors**: per signature — component, message, first-seen time, frequency in the period, and the AI analysis: "what may be happening" plus an actionable recommendation for that error.
3. **Recurring errors**: grouped by signature, with counts and worsening/improving trend.
4. **Reactivations**: known signatures that reappeared after the reactivation window.
5. **Integration status**: fed ONLY by the Home Assistant API — see below.
- **Bounded AI context**: the AI receives bounded context per signature (first N lines / N occurrences, redacted), never the full raw log. Keep provider prompts minimizing data exposure. This keeps cost low and protects user data.
- The recommendation is **per error**; there is no separate recommendations section.

### Integration status (the only API use)

- The Home Assistant API is used **only** for the integration status section of reports. Error detection never depends on it.
- Use the Home Assistant WebSocket API with the long-lived access token stored during onboarding: command `config_entries/get`, returning config entries with their state (`loaded`, `setup_error`, `not_loaded`, `setup_retry`, `failed_unload`, ...), optionally complemented by the issues registry.
- Queried once per report run, at report time (batch, not continuous).
- **Graceful degradation**: if the API call fails (HA unreachable, token expired), the report still generates and the integration section renders as "unavailable". A report must never be blocked by the API.

### AI providers (v1)

- **OpenAI** (existing adapter, extended) and **Gemini** and **Ollama** (new, local).
- **OpenAI has two selectable auth modes** (chosen during onboarding):
  1. **API key** (classic pay-per-token).
  2. **ChatGPT account login** (browser OAuth-style flow, like opencode's `auth login`): the user authorizes with their ChatGPT Plus/Pro subscription ($20/month) and the tool uses the ChatGPT backend with the obtained tokens — no API key needed. Implement as a browser authorization flow (PKCE) with callback handled by the web app; tokens stored encrypted in the secret store with refresh handling.
  - Honest engineering note that must be documented: the ChatGPT-account path uses an **unofficial backend API**; it can break or be rate-limited by OpenAI at any time. It is a community convenience, never the default, and API key remains the recommended mode. The adapter must be covered by tests against a fake auth/OAuth server and a fake chat backend.
- **Ollama**: configurable base URL (e.g. `http://<host>:11434`) and model name in settings. **Ollama correctness must come from tests**: the maintainer will not manually test it. Cover the adapter with tests against a fake/local Ollama HTTP server (request shape, model name, response parsing, error handling, timeouts).
- Anthropic is out of v1. Keep the provider abstraction extensible.
- **No cap on the number of signatures analyzed per report**: if the Home Assistant log has many errors, the AI analyzes all of them and the user assumes the cost. The README must state honestly that **AI costs scale with error volume** and that the schedule controls that volume. (Per-signature context stays bounded; the count is not.)

### Notifications (Telegram)

- Bot token + chat ID configured during onboarding, with a test-send button in settings (keep this from the current project).
- The Telegram message is a **compact summary of the report** (what's new, what reactivated, headline counts) with a link to the full report in the web UI.
- Sent only when there is something to report (silence rule above).
- Notifier adapter tested with a fake Telegram HTTP server.

### Authentication (replaces token auth)

- **Admin account with username and password**, created during onboarding (first visit flow: choose language → create admin account → log in → configure the rest).
- Passwords hashed with **argon2**; sessions via **httpOnly cookie** (Secure behind TLS proxy, SameSite); **rate-limit the login endpoint** (brute-force protection); allow changing the password in settings.
- **Remove the `ADMIN_TOKEN` / `SETUP_TOKEN` mechanism entirely** — it no longer exists in the design, the code, the Compose files, or the docs.

### Onboarding and settings (evolved from the current six-screen flow)

- **Step 1: language selection** (see Language).
- Then: create admin account → log in.
- Then: Home Assistant connection (URL + long-lived token), AI provider (type, key/base URL/model), Telegram (optional), schedule (mandatory, no default), privacy/redaction level (keep the existing concept), finish → first run executes immediately.
- Settings remain editable after onboarding: HA connection, provider, Telegram (with test send), schedule, retention, warning toggle, reactivation window, lookback window, language, password change, privacy level, and the existing operator notes / ignored warnings.

### Retention

- Report retention configurable, **default 10 reports**: when exceeded, the oldest reports are deleted from storage and the web history.
- The signature store persists forever (it powers new/reactivation detection).

### Web UI (design decisions)

**Visual language.** Dark-only admin panel aesthetic, in the spirit of Portainer / Immich / Uptime Kuma: dark background, sidebar navigation, cards with subtle borders, semantic status colors (red = new error, amber = reactivation, green = healthy), clean typography, medium density. No light mode in v1.

**Navigation.** Collapsible left sidebar (Dashboard, Reports, Settings) plus a thin topbar with operational status (last run, next report, language). On small screens the sidebar collapses to a hamburger menu.

**Dashboard = status panel.** On entry the user must know in 5 seconds whether things are fine:
- Header cards: last run status/time, next report countdown, new errors in last period, reactivations.
- Latest report summary: the 3–5 most important signatures with semantic colors and a link to the full report.
- Integrations mini-panel: healthy/failing counts, linking to the report section.
- When there is nothing to report, show a quiet green "no new errors" state.

**Report detail is structured, not rendered Markdown.** Executive summary on top; sections by type (New / Recurring / Reactivations / Integration status); each error signature is an expandable card showing component, message, first-seen, frequency, and the **full AI analysis plus recommendation — never truncated**. Semantic severity colors. Consistent structure across reports, scalable to 20+ errors.

**Interactions with errors (v1).**
- **Ignore a signature**: button in the report detail; requires confirmation (silencing an error is a decision); ignored signatures disappear from future reports and are managed in Settings.
- **Operator note**: free-text note per signature, shown next to that error in future reports.

**Responsive strategy (explicit).** Desktop-first in v1. Mobile gets the minimum indispensable: fluid grid collapsing to one column, readable type, tappable links. The report detail page MUST be readable on a phone — it is the destination of the Telegram link and the main consumption path. No special mobile navigation, no bottom bars, no PWA in v1. Full mobile support (adapted navigation, touch polish, optional PWA) is an explicit roadmap item.

**Views.** Login (centered card), onboarding wizard with progress indicator and resume support (steps: language → create admin account → Home Assistant → AI provider → Telegram → schedule → privacy → finish), dashboard, report history (respecting retention), report detail, settings. Well-designed empty states (no reports yet, no errors, integration API unavailable). Secret values always masked; never preload raw tokens/keys.

### Language (important quality requirement)

- UI is **English-first** with a Spanish locale. The **first onboarding step is the language selector**; everything after (onboarding, web UI, reports, Telegram messages) uses the chosen language. Report language is also changeable in settings.
- **Spanish translations must be Spain Spanish (es-ES) and CORRECT**: professional register, correct grammar, natural wording — never literal/machine-like translations, no invented terms, no mixing with English. This is a hard quality gate; review every string.

### Distribution, releases, license

- **License: MIT.** Add the LICENSE file and a LICENSE section to the README.
- **Docker Hub**: the image is published to Docker Hub (the maintainer already has an account and published containers there). Set up the repository/token naming and the workflow accordingly; `docker pull` must be the primary installation path documented in the README.
- **Releases: semantic-release.** Automatic semantic versioning on the default branch; releases produce version tags, GitHub release notes, and the Docker Hub image push. Conventional commits are already the rule in this repo — semantic-release depends on them.

### Security

- Secrets encrypted at rest, masked in UI, redacted in logs. Never log raw tokens or keys. No secrets in `.env` beyond what is documented (none today after token removal).
- Provider prompts minimize data exposure (bounded, redacted context).
- No Docker socket, no privileged, non-root container.

### Engineering and testing requirements (non-negotiable)

- **Testing is a pillar of this refactor.** Every module has unit tests: log parsing (real HA fixtures), signature normalization/deduplication, baseline logic, delta/offset handling (truncation and rotation cases), scheduler (fake clock, idempotency), report assembly, retention enforcement, provider adapters (fake HTTP servers — especially Ollama), Telegram notifier (fake server), integration-status client (fake WebSocket), auth (hashing, sessions, rate limit), and settings persistence.
- Keep the existing CI shape: `pnpm run ci` — typecheck, unit/integration tests, focused-test guard, Playwright smoke, build — all green.
- No silly errors: every behavior has coverage before the refactor is claimed complete.
- Conventional commits, no AI attribution ("Co-Authored-By" forbidden).

### Documentation (public project)

- README rewritten for someone who is not the maintainer: what it does, the **same-host requirement and HA OS/Supervised incompatibility stated prominently**, quick start with Docker Compose, HA long-lived token setup, AI provider setup (OpenAI, Gemini, Ollama), Telegram setup, reverse proxy with TLS, backup/restore, troubleshooting.
- Update `docs/` accordingly (configuration matrix, architecture notes, operations).
- Keep `CONTEXT.md` glossary in sync with the domain terms (error signature, new/recurring/reactivated/latent error, baseline, lookback window, report schedule, integration status, admin account).

### Explicit roadmap (not v1)

- Full mobile support: adapted navigation, touch polish, optional PWA.
- Light theme, only if the community asks for it.
- Anthropic provider.
- Broader Home Assistant API usage is not planned; the API stays scoped to integration status.

### Acceptance checklist

- [ ] Batch analysis core implemented (delta read, signatures, baseline, lookback window).
- [ ] First-run baseline + immediate first report after onboarding.
- [ ] Scheduler presets + daily-with-hour + custom weekday/time; no default; idempotent.
- [ ] Report with executive summary, new/recurring/reactivated sections, per-error AI analysis + recommendation, integration status with graceful "unavailable".
- [ ] OpenAI, Gemini, Ollama adapters working; OpenAI supports API key AND ChatGPT-account login (browser OAuth-style); Ollama covered by fake-server tests.
- [ ] No cap on analyzed signatures; README documents that AI cost scales with error volume.
- [ ] Timezone setting with DST-correct scheduling tests (winter/summer transitions, fake clock).
- [ ] Run failures shown in web only; no Telegram for tool failures.
- [ ] MIT license; Docker Hub publishing via semantic-release-driven releases.
- [ ] Telegram summary with silence rule; test-send in settings.
- [ ] HA WebSocket integration status, API used nowhere else.
- [ ] Admin login (argon2, httpOnly session, rate limit); tokens removed everywhere.
- [ ] Retention default 10, configurable.
- [ ] Language selector first onboarding step; es-ES translations correct and professional.
- [ ] Dark-only admin aesthetic; sidebar + topbar; dashboard status panel with header cards.
- [ ] Structured report detail with full per-error AI analysis and recommendation (never truncated); semantic severity colors.
- [ ] Ignore-signature (with confirmation) and operator notes interactions.
- [ ] Desktop-first; report detail readable on mobile (Telegram link destination); no special mobile nav in v1; full mobile support documented on the roadmap.
- [ ] Secret masking/redaction preserved; no secrets in docs or `.env`.
- [ ] `pnpm run ci` green; Docker image builds; Compose runs with the single read-only log mount.
- [ ] README and docs updated with the hard deployment boundary.
