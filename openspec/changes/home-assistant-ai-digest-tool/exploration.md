## Exploration: home-assistant-ai-digest-tool

### Current State
- `saihgupr/HomeAssistantDigest` remains a useful product reference, but the latest GitHub evidence still shows an HAOS/Supervised add-on architecture: hardcoded `http://supervisor/core` and `http://supervisor` endpoints, `SUPERVISOR_TOKEN` usage, HA notify-service delivery, and Supervisor-only monitoring paths.
- The reference project includes more product surface than our MVP: home-profile onboarding, entity auto-configuration, digest history, daily/weekly views, dismiss/ignore actions, note capture, battery prediction, update/add-on checks, and compressed local history.
- The current proposal already matches the requested MVP direction: public/general-purpose, Docker/Home Assistant Core first, web UI from the start, Telegram configurable from the UI, and OpenAI/Gemini interchangeability.
- The new review adds nuance: the blocker is not "forking as a principle" but the combination of missing license evidence, tight Supervisor coupling, and prototype-level maintenance signals.

### Affected Areas
- `openspec/changes/home-assistant-ai-digest-tool/exploration.md` — records the focused capability review and updated fork/reuse stance.
- `openspec/changes/home-assistant-ai-digest-tool/proposal.md` — should soften absolute "no fork" wording while preserving the current legal/technical conclusion.
- `openspec/config.yaml` — existing rules already support clean-room/reference-only constraints; no change required.
- `AGENTS.md` — current product direction remains aligned; no change required for this exploration pass.

### Approaches
1. **Reference-only clean-room implementation** — keep using `HomeAssistantDigest` as a product/UX reference while rebuilding everything independently.
   - Pros: Safest current path; preserves Docker/Core-first architecture freedom; avoids licensing ambiguity and Supervisor debt.
   - Cons: No direct code reuse; feature triage must be deliberate.
   - Effort: Medium

2. **Conditional selective reuse if upstream evidence changes** — allow future reassessment if a clear permissive license appears and isolated parts become worth reusing.
   - Pros: Avoids dogma; keeps optionality if legal status improves later.
   - Cons: Not actionable today; still limited by architecture mismatch and code quality concerns.
   - Effort: Low now / High if pursued later

### Recommendation
Keep the MVP and architecture direction unchanged, but update the wording to: **we are not rejecting fork/reuse on ideology; we are rejecting it based on current evidence**.

Capability review outcome:
- **Do not move extra upstream features into MVP now.** MVP scope is still correct.
- **Preserve several upstream ideas for backlog/design guidance:** weekly digest mode, user notes/event notes, ignore/dismiss rules, compact retained history, battery-depletion prediction, and entity auto-prioritization.
- **Preserve key UX patterns conceptually:** first-run guided setup, dashboard split by digest type, quick overview + attention cards + housekeeping, and easy "note/ignore" feedback loops.
- **Fork/reuse remains inadvisable today:** GitHub API still reports `license: null`, the repo still appears single-maintainer/beta, open issues include install/runtime problems, and the runtime remains Supervisor-centric.

### Risks
- Softening the wording too much could accidentally imply that upstream code reuse is currently approved.
- Pulling too many attractive upstream ideas into MVP would create scope creep and delay a clean first release.

### Ready for Proposal
Yes — update the proposal so it says upstream is a reference source, not a forbidden topic, while documenting that current legal and technical evidence still points to a clean-room Docker/Core-first implementation.
