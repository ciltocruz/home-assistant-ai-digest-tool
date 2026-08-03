import { fileURLToPath } from 'node:url';
import { createRuntimeLogger, type RuntimeLogger, type RuntimeStartupFailureEvent } from './runtime-logging.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createPersistentRuntimePreviewApp } from './runtime-preview.js';

type RuntimeServerDependencies = {
  createApp?: typeof createPersistentRuntimePreviewApp;
  createLogger?: (options: { dataDir: string; logDir: string }) => RuntimeLogger;
  registerSignalHandler?: (signal: NodeJS.Signals, handler: () => Promise<void>) => void;
  setExitCode?: (value: number) => void;
};

export async function startRuntimeServer(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeServerDependencies = {}
): Promise<void> {
  const dataDir = environment.DATA_DIR ?? '/data';
  const logDir = environment.LOG_DIR ?? `${dataDir}/logs`;
  const logger = (dependencies.createLogger ?? createRuntimeLogger)({ dataDir, logDir });

  try {
    const config = loadRuntimeConfig(environment);
    const app = await (dependencies.createApp ?? createPersistentRuntimePreviewApp)({
      frontendDistDir: config.frontendDistDir,
      dataDir: config.dataDir,
      haLogsDir: config.haLogsDir,
      adminToken: config.adminToken,
      setupToken: config.setupToken,
      secureCookies: config.secureCookies,
      trustProxy: config.trustProxy,
      haMaxStates: config.haMaxStates,
      haMaxLogLines: config.haMaxLogLines,
      haMaxResponseBytes: config.haMaxResponseBytes,
      haAnalysisTimeoutMs: config.haAnalysisTimeoutMs,
      failureReporter: logger.reportApiFailure
    });
    await app.listen({ host: config.host, port: config.port });

    let shutdownStarted = false;
    const closeServer = async (): Promise<void> => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      try {
        await app.close();
      } catch (error) {
        logger.reportStartupFailure(startupFailureEvent(error));
        (dependencies.setExitCode ?? setProcessExitCode)(1);
      }
    };
    const registerSignalHandler = dependencies.registerSignalHandler ?? registerProcessSignalHandler;
    registerSignalHandler('SIGTERM', closeServer);
    registerSignalHandler('SIGINT', closeServer);
  } catch (error) {
    logger.reportStartupFailure(startupFailureEvent(error));
    (dependencies.setExitCode ?? setProcessExitCode)(1);
  }
}

function startupFailureEvent(error: unknown): RuntimeStartupFailureEvent {
  return {
    event: 'runtime_startup_failure',
    reason: 'runtime_startup_failed',
    errorName: error instanceof TypeError ? 'TypeError' : 'Error'
  };
}

function registerProcessSignalHandler(signal: NodeJS.Signals, handler: () => Promise<void>): void {
  process.once(signal, () => {
    void handler();
  });
}

function setProcessExitCode(value: number): void {
  process.exitCode = value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startRuntimeServer();
}
