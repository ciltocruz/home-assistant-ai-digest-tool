# Lightweight Operation Specification

## Purpose
Safe load.

## Requirements
### Requirement: Bound Operational Load
The system MUST enforce polling, storage, concurrency, and retry limits.

#### Scenario: Limits enforced
- GIVEN configured limits
- WHEN jobs request work
- THEN allowed work stays within limits and excess work is delayed or skipped with reason
