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
