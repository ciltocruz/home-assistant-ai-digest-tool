# AI Digest Generation Specification

## Purpose
Provider digesting.

## Requirements
### Requirement: Generate Structured Digests
The system MUST create structured digests through interchangeable Gemini/OpenAI providers.

#### Scenario: Generation result
- GIVEN redacted incident context and a configured provider
- WHEN generation runs
- THEN severity, summary, and attention items are returned, or provider errors preserve collected incidents
