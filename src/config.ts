import path from 'path';

export const config = {
  general: {
    isBinary: /true/i.test(process.env.SIO_NEXUS_IS_BINARY ?? 'false'),
    env: process.env.SIO_NEXUS_ENV ?? 'prod',
    get isDevEnv() {
      return this.env === 'dev';
    },
    get isProdEnv() {
      return this.env === 'prod';
    },
    projectName: process.env.SIO_NEXUS_PROJECT_NAME ?? '<Project Name>',
    showInitBanner: /true/i.test(process.env.SIO_NEXUS_SHOW_INIT_BANNER ?? 'false'),
    nexusConfigFilePath:
      process.env.SIO_NEXUS_CONFIG_FILE_PATH ?? path.resolve(process.cwd(), 'nexus-config.json'),
  },
  log: {
    enabled: /true/i.test(process.env.SIO_NEXUS_LOG_ENABLED ?? 'false'),
    level: process.env.SIO_NEXUS_LOG_LEVEL ?? 'warn',
    dir: process.env.SIO_NEXUS_LOG_DIR ?? path.resolve(process.cwd(), 'logs'),
    writeToFiles: /true/i.test(process.env.SIO_NEXUS_WRITE_LOG_TO_FILES ?? 'false'),
  },
  socket: {
    aggrSocketPath: process.env.SIO_NEXUS_AGGR_SOCKET_PATH ?? '/tmp/sio-nexus-aggr.sock',
    querySocketPath: process.env.SIO_NEXUS_QUERY_SOCKET_PATH ?? '/tmp/sio-nexus-query.sock',
    scannerSocketPath:
      process.env.SIO_NEXUS_SCANNER_SOCKET_PATH ?? '/tmp/sio-nexus-scanner.sock',
  },
};
