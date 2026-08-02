import type { DigestJobStage, DigestKind } from '@ha-digest/shared';

export type DigestJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type DigestJob = {
  id: string;
  triggerWindowId: string;
  kind: DigestKind;
  status: DigestJobStatus;
  stage: DigestJobStage;
  attempts: number;
  retryCount: number;
  availableAt: string;
  leaseUntil?: string;
  lastError?: string;
  errorCode?: string;
  errorMessage?: string;
  reportId?: string;
  retryAvailable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EnqueueDigestJobInput = {
  triggerWindowId: string;
  kind: DigestKind;
  settingsSnapshot?: object;
};

export type EnqueueResult = { status: 'queued'; jobId: string } | { status: 'already_queued'; jobId: string };

export type DigestJobRetryPolicy = {
  maxAttempts: number;
  baseDelaySeconds: number;
  backoffMultiplier: number;
};

export interface DigestJobStore {
  enqueue(input: EnqueueDigestJobInput): Promise<EnqueueResult>;
  leaseNext(options?: { leaseSeconds?: number }): Promise<DigestJob | null>;
  retry(id: string, reason: string): Promise<void>;
  get(id: string): Promise<DigestJob | null>;
  setStage(id: string, stage: Exclude<DigestJobStage, 'queued' | 'completed' | 'failed'>): Promise<void>;
  complete(id: string, reportId?: string): Promise<void>;
  fail(id: string, errorCode: string, errorMessage: string): Promise<void>;
  retryFailed(id: string): Promise<DigestJob | null>;
}
