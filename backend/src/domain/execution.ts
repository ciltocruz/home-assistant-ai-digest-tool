export type ExecutionContext = {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  checkpoint(): void;
  dispose(): void;
};

export function createExecutionContext(timeoutMs?: number, now = Date.now): ExecutionContext {
  const controller = new AbortController();
  const deadlineAtMs = timeoutMs ? now() + timeoutMs : Number.POSITIVE_INFINITY;
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(new Error('ANALYSIS_DEADLINE_EXCEEDED')), timeoutMs)
    : undefined;

  return {
    signal: controller.signal,
    deadlineAtMs,
    checkpoint() {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('ANALYSIS_CANCELLED');
      }
    },
    dispose() {
      if (timer) clearTimeout(timer);
    }
  };
}

export function raceWithCancellation<T>(operation: Promise<T>, context: ExecutionContext): Promise<T> {
  const cancelled = new Promise<never>((_, reject) => {
    if (context.signal.aborted) return reject(context.signal.reason);
    context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
  });
  void cancelled.catch(() => undefined);
  return Promise.race([operation, cancelled]);
}

export function combineAbortSignals(parent: AbortSignal | undefined, timeoutMs?: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = timeoutMs ? setTimeout(() => controller.abort(new Error('ANALYSIS_DEADLINE_EXCEEDED')), timeoutMs) : undefined;
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    }
  };
}
