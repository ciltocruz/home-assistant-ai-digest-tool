import type { DigestKind } from '@ha-digest/shared';

export type DigestJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type DigestJob = {
  id: string;
  triggerWindowId: string;
  kind: DigestKind;
  status: DigestJobStatus;
  attempts: number;
  availableAt: string;
  leaseUntil?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type EnqueueDigestJobInput = {
  triggerWindowId: string;
  kind: DigestKind;
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
  complete(id: string): Promise<void>;
  retry(id: string, reason: string): Promise<void>;
}
