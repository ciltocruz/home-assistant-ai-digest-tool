# Product Experience Context

This context defines the user-facing language for configuring Home Assistant incident analysis and operating generated reports.

## Language

**Onboarding screen**:
A persisted, ordered setup checkpoint that collects one configuration concern and can be resumed.
_Avoid_: step, wizard page

**Configuration**:
The saved, non-secret settings and encrypted secret references used to connect, analyze, schedule, and notify.
_Avoid_: draft, credentials

**Report job**:
A durable request to collect incidents and generate one report for a fixed window and configuration snapshot.
_Avoid_: request, queue item, synchronous analysis

**Report**:
The completed, persisted digest produced by a report job.
_Avoid_: result, history item

**Secret operation**:
An explicit instruction to keep, replace, or deliberately remove one stored secret.
_Avoid_: optional password field

**Recovery action**:
The next safe operation presented after loading, failure, or restart, such as retry, resume, or edit settings.
_Avoid_: fallback, workaround

**Experience shell**:
The stable application frame that exposes Dashboard, Reports, and Configuration navigation.

**Operational shell**:
The experience shell shown only after onboarding is complete; it is the daily-use context for reports and recovery actions.

**Attention item**:
A report finding that requires awareness or action, ordered before observations and positive status.

## Refactor v2 terms

**Error signature**:
A stable identity for a log problem, derived from component, level, and normalized message (timestamps, IDs, line numbers, and volatile values stripped). Recurrences of the same problem share one signature.
_Avoid_: raw log line, message hash without normalization

**New error**:
The first-ever occurrence of an error signature in the persistent signature store. Only new errors and reactivations are treated as noteworthy.
_Avoid_: latest error, last entry

**Recurring error**:
A known signature that keeps appearing within the current period, grouped under one signature with counts and trend.
_Avoid_: repeated alert, duplicate

**Reactivated error**:
A known signature that reappears after a configurable reactivation window (default 7 days) has passed. Reactivation is reported again.
_Avoid_: old error again, re-spam

**Latent error**:
A signature that already existed before the lookback window and is still present — a carried problem, not a new one.
_Avoid_: hidden error, legacy error

**Baseline**:
The silent first-run learning of signatures older than the lookback window, so the tool can distinguish new problems from carried ones.
_Avoid_: cold start, history import

**Lookback window**:
Configurable period (default 10 days) reviewed on the first run, bounded by what the current log file contains. Rotation files are not read.
_Avoid_: history depth, scan days

**Report schedule**:
The user-chosen execution frequency with no default: presets (15m, 30m, 1h, 6h, 12h, daily with hour) or a custom weekday + time.
_Avoid_: default interval, run often

**Integration status**:
The report section fed by the Home Assistant WebSocket API (`config_entries/get`), showing config entry state. Unavailable when the API call fails; the report still generates.
_Avoid_: integration health from logs, status by guessing

**Admin account**:
The username/password account created in onboarding that protects the web UI. Session via httpOnly cookie; no bootstrap tokens.
_Avoid_: admin token, API key login

**Report retention**:
The maximum number of newest v2 reports retained locally (default 10). Retention removes report detail only; error signatures remain permanent.
_Avoid_: signature expiry, log retention

**Silence rule**:
No Telegram message is sent when a run has no noteworthy findings or when a tool failure prevents a trustworthy delivery. The web UI still records the quiet or failed run.
_Avoid_: failure alert, empty digest notification
