# Home Assistant Collection Specification

## Purpose
Docker/Core collection.

## Requirements
### Requirement: Collect Incident Signals
The system MUST collect supported log, API, entity, automation, integration, recorder, update, battery, and optional Docker health facts.

#### Scenario: Collection runs
- GIVEN configured HA access
- WHEN collection runs
- THEN normalized facts are produced and supervisor-only signals are marked unsupported in Docker/Core mode
