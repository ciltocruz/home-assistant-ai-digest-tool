# Ignored Warnings Specification

## Purpose
Warning suppression.

## Requirements
### Requirement: Manage Ignored Warnings
The system MUST support dismissing items and editing ignored warning rules.

#### Scenario: Ignore lifecycle
- GIVEN a warning rule is added or removed
- WHEN future digests evaluate matching warnings
- THEN active rules suppress matches and removed rules allow matches again
