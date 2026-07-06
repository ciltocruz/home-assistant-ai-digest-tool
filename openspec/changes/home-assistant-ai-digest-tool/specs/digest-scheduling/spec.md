# Digest Scheduling Specification

## Purpose
Digest orchestration.

## Requirements
### Requirement: Run Digests On Demand And Schedule
The system MUST support manual, daily, and weekly jobs.

#### Scenario: Digest queued
- GIVEN setup is complete and a trigger occurs
- WHEN orchestration runs
- THEN exactly one digest job is queued for that trigger window
