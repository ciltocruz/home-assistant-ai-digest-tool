import type { CollectedFact } from './collectors.js';

export type IncidentSeverity = 'critical' | 'warning' | 'info';

export type Incident = {
  id: string;
  type: string;
  severity: IncidentSeverity;
  area?: string;
  summary: string;
  redactedEvidence: string[];
  detectedAt: string;
};

export interface IncidentDetector {
  readonly id: string;
  detect(facts: CollectedFact[]): Promise<Incident[]>;
}
