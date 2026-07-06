# Flexible Notifications Specification

## Purpose
Digest outputs.

## Requirements
### Requirement: Deliver Digest Outputs
The system MUST support markdown reports, HA notifications, email, Telegram-style adapters, and test-send.

#### Scenario: Delivery or test-send
- GIVEN a digest or notifier test
- WHEN delivery runs
- THEN the target receives output or actionable failure with secrets hidden
