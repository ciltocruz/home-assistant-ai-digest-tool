export type HomeAssistantMode = 'docker_core';

export type UnsupportedSignal = {
  source: string;
  reason: string;
};

export type CollectedFact = {
  id: string;
  source: string;
  observedAt: string;
  summary: string;
  attributes?: Record<string, unknown>;
};

export type CollectionResult = {
  facts: CollectedFact[];
  unsupportedSignals: UnsupportedSignal[];
};

export interface Collector {
  readonly id: string;
  collect(context: ExecutionContext): Promise<CollectionResult>;
}
import type { ExecutionContext } from './execution.js';
