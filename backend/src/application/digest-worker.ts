import type { DigestJobStore } from '../domain/jobs.js';
import type { DigestJob } from '../domain/jobs.js';
import { redactProviderError } from '../domain/safe-error.js';

type WorkerJobs = Pick<DigestJobStore, 'leaseNext' | 'setStage' | 'complete' | 'fail'>;
type WorkerAnalysis = { runWithStages(onStage: (stage: Exclude<DigestJob['stage'], 'queued' | 'completed' | 'failed'>) => void | Promise<void>, job?: DigestJob): Promise<{ status: 'completed'; reportId: string }> };
export type DigestWorkerFailureEvent = { jobId: string; stage: 'provider' | 'source' | 'processing' | 'storage'; errorCode: string; errorMessage: string };

export class DigestWorker {
  private active: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly dependencies: { jobs: WorkerJobs; analysis: WorkerAnalysis; failureReporter?: (event: DigestWorkerFailureEvent) => void }) {}

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
    try {
      const result = await this.dependencies.analysis.runWithStages((stage) => this.dependencies.jobs.setStage(job.id, stage), job);
      await this.dependencies.jobs.complete(job.id, result.reportId);
    } catch (error) {
      const failure = safeFailure(error);
      await this.dependencies.jobs.fail(job.id, failure.code, failure.message);
      try {
        this.dependencies.failureReporter?.({ jobId: job.id, stage: failureStage(failure.code), errorCode: failure.code, errorMessage: failure.message });
      } catch {
        // Logging failures must not change the persisted job outcome.
      }
    }
    return true;
  }
}

function safeFailure(error: unknown): { code: string; message: string } {
  const rawMessage = error instanceof Error ? error.message : '';
  const code = rawMessage.split(':')[0];
  if (code === 'ANALYSIS_SOURCE_FAILED') return { code: 'HOME_ASSISTANT_UNAVAILABLE', message: 'No se pudieron recopilar datos de Home Assistant. Revise la conexión y el token.' };
  if (code === 'ANALYSIS_PROCESSING_FAILED') return { code: 'AI_PROVIDER_UNAVAILABLE', message: detailedFailureMessage(rawMessage, code, 'No se pudo generar el informe con el proveedor de IA. Revise la configuración e inténtelo de nuevo.') };
  if (code === 'AI_ANALYSIS_UNAVAILABLE') return { code: 'AI_PROVIDER_UNAVAILABLE', message: detailedFailureMessage(rawMessage, code, 'No se pudo generar el informe con el proveedor de IA. Revise la configuración e inténtelo de nuevo.') };
  if (code === 'ANALYSIS_SAVE_FAILED') return { code: 'REPORT_STORAGE_UNAVAILABLE', message: 'El informe se generó, pero no se pudo guardar. Revise el almacenamiento e inténtelo de nuevo.' };
  if (code === 'ANALYSIS_DEADLINE_EXCEEDED') return { code: 'ANALYSIS_TIMEOUT', message: 'El análisis superó el tiempo límite. Reduzca el alcance e inténtelo de nuevo.' };
  return { code: 'ANALYSIS_FAILED', message: 'No se pudo completar el análisis. Revise la configuración e inténtelo de nuevo.' };
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
