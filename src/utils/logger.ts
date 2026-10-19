import { config } from '@/config';
import path from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import fs from 'fs';
import { ensureFolderInPath } from '@/utils/folders';

// #################################################################
// # If logs folder does not exist, create it
// #################################################################

if (config.log.writeToFiles) {
  ensureFolderInPath(config.log.dir, { withNoFile: true });
}

// #################################################################
// # Transports targets
// #################################################################

const pinoStreams: Array<pino.DestinationStream | pino.StreamEntry> = [];

if (config.log.writeToFiles) {
  pinoStreams.push(
    // We always want level warn and above to be stored in error.log
    {
      level: 'warn',
      stream: fs.createWriteStream(path.join(config.log.dir, '/error.log'), { flags: 'a' }),
    }
  );

  // Info debug and trace ans above deserves their own files
  // take into account that the file created will store all logs from the level and ABOVE
  if (['info', 'debug', 'trace'].includes(config.log.level)) {
    pinoStreams.push({
      level: config.log.level as pino.Level,
      stream: fs.createWriteStream(path.join(config.log.dir, `/${config.log.level}.log`), {
        flags: 'a',
      }),
    });
  }
}

if (config.general.isDevEnv) {
  // Only if we are in development we want to print pretty logs to the stdout
  // destination 1 means stdout.
  pinoStreams.push({ level: 'trace', stream: pinoPretty({ destination: 1 }) });
}

// #################################################################
// # Logger
// #################################################################

const logger = pino(
  {
    enabled: config.log.enabled,
    level: config.log.level,
  },
  pino.multistream(pinoStreams)
);

// #################################################################
// # Main execution to test if running with `bun ./src/utils/logger/logger.ts`
// #################################################################

if (import.meta.main) {
  logger.trace('Logger Trace');
  logger.debug('Logger debug');
  logger.info('Logger info');
  logger.warn('Logger warn');
  logger.error('Logger error');
  logger.fatal('Logger fatal');
}

// #################################################################
// # Exports
// #################################################################

const consoleLogger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

const silentLogger = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  info: (msg: string) => {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  warn: (msg: string) => {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  error: (msg: string) => {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  debug: (msg: string) => {},
};

export { logger, consoleLogger, silentLogger };
