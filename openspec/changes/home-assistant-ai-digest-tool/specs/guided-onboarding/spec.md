# Guided Onboarding Specification

## Purpose
First run.

## Requirements
### Requirement: Complete First Run
The system MUST guide HA connection, provider, notifier/report target, schedule, privacy, validation, and first digest.

#### Scenario: Setup validated
- GIVEN valid or invalid setup input
- WHEN onboarding validates it
- THEN valid input is saved masked, or invalid input reports the failing step without secret logging
