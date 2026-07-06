# Local History Specification

## Purpose
Local retention.

## Requirements
### Requirement: Store Compressed History
The system MUST persist compressed digest/event history locally with configurable retention.

#### Scenario: History lifecycle
- GIVEN completed digests and retention settings
- WHEN save or cleanup runs
- THEN current history is retrievable and expired entries are removed without changing configuration
