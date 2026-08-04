import type { PrivacyLevel } from '@ha-digest/shared';
import type { Incident } from './detectors.js';
import type { ExecutionContext } from './execution.js';

export type RedactedDigestInput = {
  window: { from: string; to: string };
  privacyLevel: PrivacyLevel;
  incidents: Incident[];
  entityStats: Record<string, unknown>;
  notes: Array<{ id: string; text: string; occurredAt: string }>;
  unsupportedSignals: Array<{ source: string; reason: string }>;
  redactionReport: string[];
};

export type StructuredDigest = {
  severity: 'critical' | 'warning' | 'info';
  summary: string;
  attentionItems: Array<{ title: string; severity: 'critical' | 'warning' | 'info'; detail: string }>;
};

export interface AIProvider {
  readonly id: 'openai' | 'gemini' | string;
  generate(input: RedactedDigestInput, context: ExecutionContext): Promise<StructuredDigest>;
}
