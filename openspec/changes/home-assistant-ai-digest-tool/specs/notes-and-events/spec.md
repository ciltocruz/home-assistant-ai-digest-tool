# Notes And Events Specification

## Purpose
User context.

## Requirements
### Requirement: Attach Context Notes
The system MUST let users add notes/events and include relevant entries in digest context.

#### Scenario: Note scope
- GIVEN notes inside and outside the digest window
- WHEN a digest is generated
- THEN in-window notes are included and out-of-window notes are excluded
