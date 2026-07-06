# Security Privacy Specification

## Purpose
Data protection.

## Requirements
### Requirement: Protect Sensitive Data
The system MUST mask secrets, redact logs, and send minimized AI payloads per privacy settings.

#### Scenario: Sensitive data handled
- GIVEN secrets or sensitive incident values
- WHEN storing, displaying, logging, or building provider input
- THEN secrets are masked and configured redaction applies before AI transmission
