import { consoleLogger as logger } from './logger';

/**
 * Lightweight signal/exit handler registry to coordinate graceful shutdowns.
 * Register cleanup tasks once and they will run when SIGINT/SIGTERM/SIGQUIT,
 * unhandled errors, or process shutdown events occur.
 */
type SignalReason = 'SIGINT' | 'SIGTERM' | 'SIGQUIT';
export type ShutdownReason =
  | SignalReason
  | 'beforeExit'
  | 'uncaughtException'
  | 'unhandledRejection';
type CleanupTask = () => void | Promise<void>;

const cleanupTasks: Set<CleanupTask> = new Set();
let handlersInstalled = false;
let shutdownRunning = false;

export function registerGracefulShutdown(task: CleanupTask): () => void {
  cleanupTasks.add(task);
  installHandlers();
  return () => cleanupTasks.delete(task);
}

async function handleShutdown(reason: ShutdownReason): Promise<void> {
  if (shutdownRunning) {
    return;
  }
  shutdownRunning = true;

  logger.info(`[graceful-exit] Received ${reason}. Running cleanup tasks...`);

  for (const task of Array.from(cleanupTasks)) {
    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[graceful-exit] Cleanup task failed: ${message}`);
    }
  }
}

function installHandlers() {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  const signals: SignalReason[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

  signals.forEach((signal) => {
    process.once(signal, () => {
      void handleShutdown(signal).finally(() => process.exit(0));
    });
  });

  process.once('beforeExit', () => {
    void handleShutdown('beforeExit');
  });

  process.once('uncaughtException', (error) => {
    logger.error('[graceful-exit] Uncaught exception:', error);
    void handleShutdown('uncaughtException').finally(() => process.exit(1));
  });

  process.once('unhandledRejection', (reason) => {
    logger.error('[graceful-exit] Unhandled rejection:', reason);
    void handleShutdown('unhandledRejection').finally(() => process.exit(1));
  });
}
