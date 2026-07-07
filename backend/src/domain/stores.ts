import type { DeliveryResult, DigestSummary, IgnoreRuleCreate, IgnoreRuleDto, NoteCreate, NoteDto } from '@ha-digest/shared';
import type { RenderedDigest } from './renderers.js';

export type SecretKind = 'home_assistant' | 'ai_provider' | 'notifier';

export type StoredSecretRef = {
  ref: string;
  kind: SecretKind;
  mask: string;
};

export interface SecretStore {
  put(kind: SecretKind, raw: string): Promise<StoredSecretRef>;
  resolve(ref: string): Promise<string>;
  mask(ref: string): Promise<StoredSecretRef>;
  rotate(ref: string, raw: string): Promise<void>;
}

export interface ReportStore {
  save(report: { id: string; rendered: RenderedDigest; summary: DigestSummary }): Promise<void>;
  list(): Promise<DigestSummary[]>;
}

export interface NoteStore {
  add(input: NoteCreate): Promise<NoteDto>;
  listWindow(window: { from: string; to: string }): Promise<NoteDto[]>;
}

export interface IgnoreRuleStore {
  add(input: IgnoreRuleCreate): Promise<IgnoreRuleDto>;
  remove(id: string): Promise<void>;
  listActive(at: string): Promise<IgnoreRuleDto[]>;
}

export interface DeliveryStore {
  record(delivery: DeliveryResult & { digestId: string }): Promise<void>;
}
