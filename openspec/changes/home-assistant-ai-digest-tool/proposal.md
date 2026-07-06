# Proposal: Home Assistant AI Digest Tool MVP

## Intent

Build a public-ready, clean-room, Docker-first Home Assistant AI digest tool that helps users understand what needs attention without reading logs manually. The MVP includes guided setup, self-configuring monitoring, daily/weekly digests, local history, notes, ignore controls, battery prediction, flexible reports/notifications, and privacy-first AI summarization. Cisne is the first test deployment, not the product boundary. `saihgupr/HomeAssistantDigest` remains a product/UX reference, but current evidence does not justify code reuse.

## Scope

### In Scope
- Standalone backend, web UI, scheduler, persistence, docs, tests, and Docker examples.
- Guided onboarding for HA connection, AI provider, notification/report targets, schedule, privacy level, and first scan.
- Self-configuring monitoring: AI-assisted/default entity prioritization with optional user tuning.
- Digests: manual, scheduled daily, and weekly summaries; markdown report output; HA notifications, email, or Telegram-style notifier adapters.
- Incident inputs: logs, unavailable/unknown entities, stale states, automations, integrations, recorder gaps, updates, batteries, and optional Docker health.
- User notes/event notes, dismiss/ignore warnings with configurable ignored list, compressed local history, and battery depletion prediction.
- Privacy-focused/lightweight operation: local storage, redaction, summarized/anonymized AI payloads, bounded polling, and minimal HA impact.

### Out of Scope
- Copying upstream code without clear license and fit; HAOS/Supervised add-on packaging; Supervisor APIs.
- Multi-user auth, mobile app, remediation automation, cloud-hosted mode, and natural language analytics.

## Capabilities

### New Capabilities
- `guided-onboarding`: first-run setup, validation, privacy choices, and first digest.
- `home-assistant-collection`: Docker/Core collectors for HA facts and incident signals.
- `self-configuring-monitoring`: default/AI-assisted monitored entity selection and prioritization.
- `digest-scheduling`: manual, daily, and weekly digest orchestration.
- `ai-digest-generation`: provider-neutral summarized digest generation for Gemini now and OpenAI support.
- `flexible-notifications`: Home Assistant notifications, email, and markdown reports; notifier abstraction.
- `local-history`: compressed local digest/event history with retention controls.
- `notes-and-events`: user notes and event annotations attached to digest context.
- `ignored-warnings`: dismiss/ignore actions and configurable ignored warning list.
- `battery-prediction`: low-battery and depletion trend prediction.
- `security-privacy`: secret handling, redaction, anonymized/summarized AI payloads.
- `lightweight-operation`: bounded resource use, polling limits, and HA-safe execution.

### Modified Capabilities
- None.

## Approach

Use a clean-room standalone service with clear interfaces: `Collector`, `IncidentDetector`, `PriorityEngine`, `AIProvider`, `Notifier`, `ReportStore`, `Scheduler`. The MVP is ambitious; downstream spec/design/tasks should split it into coherent chained PR slices rather than one oversized delivery.

## Roadmap

- Initial release: expanded MVP above, Docker/Core first.
- Web UI historical trends and graph views.
- Custom monitoring rules and multiple schedules, including morning/evening.
- Weekly/monthly summary reports with graphs.
- Anomaly detection that learns and adjusts baselines.
- Push notifications for critical issues before the next digest.
- Natural language queries, e.g. “How did my energy usage compare to last week?”
- Reassess HAOS/Supervised adapters and upstream reuse only if legal/technical evidence changes.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `backend/` | New | API, scheduler, collectors, prioritization, predictions, providers, notifiers, persistence |
| `frontend/` | New | Onboarding, dashboard, history, notes, ignored warnings, settings |
| `docker/` | New | Docker-first local/product deployment examples |
| `docs/`, `README.md` | New | Install, privacy, support limits, configuration, roadmap |
| `tests/` | New | Fake HA/provider/notifier coverage |

## Risks and Tradeoffs

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Expanded MVP is too large for one PR | High | Split specs/tasks into chained reviewable slices |
| Self-configuring monitoring may be noisy | High | Provide defaults, explanations, and tuning/ignore controls |
| Privacy expectations conflict with AI value | High | Local-first history, redaction, summarized/anonymized payloads |
| Battery prediction and anomaly logic are inaccurate early | Medium | Mark confidence, require history, degrade gracefully |
| Flexible notifications expand integration surface | Medium | Keep channel adapters isolated and fake-testable |
| Lightweight operation may conflict with broad monitoring | Medium | Bounded polling, retention limits, and resource budgets |

## Rollback Plan

Before implementation, rollback is deleting this change folder and Engram proposal. After implementation, rollback is stopping/removing the standalone container and reverting product repo changes; Cisne deployment remains separate until explicitly migrated.

## Dependencies

- HA URL/token, mounted HA logs, AI provider key, notification credentials, local writable storage. No secrets in artifacts.

## Success Criteria

- [ ] A user can complete guided onboarding and receive a manual, daily, and weekly digest.
- [ ] The system auto-prioritizes monitored entities while allowing tuning and ignores.
- [ ] Notes/events, ignored warnings, compressed history, and retention controls work locally.
- [ ] Battery prediction produces confidence-aware warnings without blocking digests.
- [ ] HA notification, email, and markdown report paths are supported through adapters.
- [ ] AI payloads are redacted/summarized, secrets are masked, and HA remains responsive.
