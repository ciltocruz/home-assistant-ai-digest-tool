# Self Configuring Monitoring Specification

## Purpose
Monitoring selection.

## Requirements
### Requirement: Prioritize Monitored Entities
The system MUST propose monitored entities with priorities using defaults and MAY use AI when enabled.

#### Scenario: Monitoring tuned
- GIVEN collected entities and optional user changes
- WHEN monitoring is initialized or edited
- THEN priorities, explanations, and preferences drive future digests
