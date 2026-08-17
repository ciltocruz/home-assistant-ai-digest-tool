import type { DigestJobStore } from '../domain/jobs.js';
import type { DigestJob } from '../domain/jobs.js';
import { redactProviderError } from '../domain/safe-error.js';

type WorkerJobs = Pick<DigestJobStore, 'leaseNext' | 'setStage' | 'complete' | 'fail'>;
type WorkerAnalysis = { runWithStages(onStage: (stage: Exclude<DigestJob['stage'], 'queued' | 'completed' | 'failed'>) => void | Promise<void>, job?: DigestJob): Promise<{ status: 'completed'; reportId: string }> };
export type DigestWorkerFailureEvent = { jobId: string; stage: 'provider' | 'source' | 'processing' | 'storage'; errorCode: string; errorMessage: string };
export type DigestWorkerEvent =
  | { event: 'job_started'; jobId: string; retryCount: number }
  | { event: 'job_retry'; jobId: string; retryCount: number }
  | { event: 'job_stage'; jobId: string; stage: Exclude<DigestJob['stage'], 'queued' | 'completed' | 'failed'> }
  | { event: 'job_completed'; jobId: string; reportId: string }
  | { event: 'job_failed'; jobId: string; errorCode: string };

export class DigestWorker {
  private active: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly dependencies: { jobs: WorkerJobs; analysis: WorkerAnalysis; language?: () => Promise<'en' | 'es'>; failureReporter?: (event: DigestWorkerFailureEvent) => void; eventReporter?: (event: DigestWorkerEvent) => void }) {}

  start(): void { this.stopping = false; this.wake(); }

  wake(): void {
    if (this.stopping || this.active) return;
    this.active = this.drain().finally(() => { this.active = null; });
  }

  async runOnce(): Promise<void> {
    if (this.active) return this.active;
    const active = this.processOne().then(() => undefined).finally(() => { this.active = null; });
    this.active = active;
    return active;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.active;
  }

  private async drain(): Promise<void> {
    while (!this.stopping && await this.processOne()) { /* drain available persisted work */ }
  }

  private async processOne(): Promise<boolean> {
    const job = await this.dependencies.jobs.leaseNext();
    if (!job) return false;
    this.report({ event: 'job_started', jobId: job.id, retryCount: job.retryCount });
    if (job.retryCount > 0) this.report({ event: 'job_retry', jobId: job.id, retryCount: job.retryCount });
    try {
      const result = await this.dependencies.analysis.runWithStages(async (stage) => {
        this.report({ event: 'job_stage', jobId: job.id, stage });
        await this.dependencies.jobs.setStage(job.id, stage);
      }, job);
      await this.dependencies.jobs.complete(job.id, result.reportId);
      this.report({ event: 'job_completed', jobId: job.id, reportId: result.reportId });
    } catch (error) {
      const language = await this.dependencies.language?.() ?? 'en';
      const failure = safeFailure(error, language);
      await this.dependencies.jobs.fail(job.id, failure.code, failure.message);
      this.report({ event: 'job_failed', jobId: job.id, errorCode: failure.code });
      try {
        this.dependencies.failureReporter?.({ jobId: job.id, stage: failureStage(failure.code), errorCode: failure.code, errorMessage: failure.message });
      } catch {
        // Logging failures must not change the persisted job outcome.
      }
    }
    return true;
  }

  private report(event: DigestWorkerEvent): void {
    try { this.dependencies.eventReporter?.(event); } catch { /* Logging failures must not change job execution. */ }
  }
}

function safeFailure(error: unknown, language: 'en' | 'es'): { code: string; message: string } {
  const rawMessage = error instanceof Error ? error.message : '';
  const code = rawMessage.split(':')[0];
  const spanish = language === 'es';
  if (code === 'ANALYSIS_SOURCE_FAILED') return { code: 'HOME_ASSISTANT_UNAVAILABLE', message: spanish ? 'No se pudieron recopilar datos de Home Assistant. Revise la conexión y el token.' : 'Home Assistant data could not be collected. Check the connection and token.' };
  if (code === 'ANALYSIS_PROCESSING_FAILED') return { code: 'AI_PROVIDER_UNAVAILABLE', message: detailedFailureMessage(rawMessage, code, spanish ? 'No se pudo generar el informe con el proveedor de IA. Revise la configuración e inténtelo de nuevo.' : 'The report could not be generated with the AI provider. Check the configuration and try again.') };
  if (code === 'AI_ANALYSIS_UNAVAILABLE') return { code: 'AI_PROVIDER_UNAVAILABLE', message: detailedFailureMessage(rawMessage, code, spanish ? 'No se pudo generar el informe con el proveedor de IA. Revise la configuración e inténtelo de nuevo.' : 'The report could not be generated with the AI provider. Check the configuration and try again.') };
  if (code === 'ANALYSIS_SAVE_FAILED') return { code: 'REPORT_STORAGE_UNAVAILABLE', message: spanish ? 'El informe se generó, pero no se pudo guardar. Revise el almacenamiento e inténtelo de nuevo.' : 'The report was generated, but could not be saved. Check storage and try again.' };
  if (code === 'ANALYSIS_DEADLINE_EXCEEDED') return { code: 'ANALYSIS_TIMEOUT', message: spanish ? 'El análisis superó el tiempo límite. Reduzca el alcance e inténtelo de nuevo.' : 'The analysis exceeded the time limit. Reduce the scope and try again.' };
  return { code: 'ANALYSIS_FAILED', message: spanish ? 'No se pudo completar el análisis. Revise la configuración e inténtelo de nuevo.' : 'The analysis could not be completed. Check the configuration and try again.' };
}

function detailedFailureMessage(rawMessage: string, code: string, fallback: string): string {
  const detail = rawMessage.slice(code.length).replace(/^:\s*/, '').trim();
  return redactProviderError(detail || fallback);
}

function failureStage(code: string): DigestWorkerFailureEvent['stage'] {
  if (code === 'AI_PROVIDER_UNAVAILABLE') return 'provider';
  if (code === 'HOME_ASSISTANT_UNAVAILABLE') return 'source';
  if (code === 'REPORT_STORAGE_UNAVAILABLE') return 'storage';
  return 'processing';
}
