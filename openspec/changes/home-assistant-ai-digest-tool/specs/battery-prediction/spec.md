# Battery Prediction Specification

## Purpose
Battery attention.

## Requirements
### Requirement: Predict Battery Attention
The system MUST flag low batteries and SHOULD estimate depletion when history allows.

#### Scenario: Battery analysis
- GIVEN battery entities and history
- WHEN analysis runs
- THEN warnings include device, severity, and low/omitted confidence when history is insufficient
