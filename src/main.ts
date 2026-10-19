import { Command, program } from 'commander';
import { config } from './config';
import { renderInitBanner } from './utils/banner';
import { logger } from './utils/logger';
import { sleep } from 'bun';
import fs from 'fs';
import { NexusServer } from './nexus/NexusServer';
import { NexusConfig } from './nexus/NexusConfig';
import { downloadHistoricalData } from './utils/klinesDownloader/downloadHistoricalData';
import { importHistoricalKlines } from './utils/klinesDownloader/importHistoricalKlines';
import { normalizeHistoricalData } from './utils/klinesDownloader/normalizeHistoricalData';
import { createDownloadHistoricalBinanceDataCommand } from './utils/klinesDownloader/downloadHistoricalBinanceData/downloadHistoricalBinanceDataCommand';

async function loadNexusConfig() {
  if (!fs.existsSync(config.general.nexusConfigFilePath)) {
    logger.error(
      `❌ No nexus configuration file found! Please create a nexus configuration file at: ${config.general.nexusConfigFilePath}`
    );
    process.exit(1);
  }

  NexusConfig.loadFromFile(config.general.nexusConfigFilePath);
  logger.info(`💾 Found nexus-config.json - Loaded initial nexus configuration!`);
  await sleep(1000); // small delay to ensure log order
}

// Main execution
async function main(): Promise<void> {
  program
    .name('sio-nexus')
    .description('SIO NEXUS Server')
    .addCommand(
      new Command('run')
        .description('Run the SIO Nexus Server')
        .option('--dashboard', 'Enable terminal dashboard UI', false)
        .option('--market-scanner', 'Enable market scanner regardless of config')
        .option('--no-market-scanner', 'Disable market scanner regardless of config')
        .action(async (options: { dashboard?: boolean; marketScanner?: boolean }) => {
          const dashboardEnabled = Boolean(options.dashboard);
          if (config.general.showInitBanner) {
            renderInitBanner();
          }

          console.log(`📝 Logger: ${config.log.enabled ? 'ENABLED' : 'DISABLED'}`);
          console.log(`🖥️  Dashboard: ${dashboardEnabled ? 'ENABLED' : 'DISABLED'}`);
          if (config.log.enabled) {
            console.log(`🐛 Log level: ${config.log.level}`);
            console.log(`📂 Log folder: ${config.log.dir}`);
          }

          logger.info('Starting SIO NEXUS server...');

          await loadNexusConfig();

          console.log(
            '-----------------------------------------------------------------------------'
          );
          console.log(
            `🗃️  Klines Buffer Flush Interval: ${NexusConfig.secondsBufferFlushToDB} seconds`
          );
          console.log(`🗃️  SQLite Klines DB Path: ${NexusConfig.sqliteKlinesDBPath}`);
          const marketScannerConfig = NexusConfig.getResolvedMarketScannerConfig();
          const marketScannerEnabled = options.marketScanner ?? marketScannerConfig.enabled;
          console.log(
            `📡 Market Scanner: ${marketScannerEnabled ? 'ENABLED' : 'DISABLED'} (${marketScannerConfig.sourceExchangeId} filtered by ${marketScannerConfig.tradableExchangeId})`
          );
          console.log(
            '-----------------------------------------------------------------------------'
          );

          const nexusServer = NexusServer.getInstance();
          await nexusServer.run({
            dashboard: dashboardEnabled,
            marketScanner: marketScannerEnabled,
          });
        })
    )
    .addCommand(
      new Command('market-scanner-dashboard')
        .description('Open the Market Scanner terminal dashboard')
        .action(async () => {
          const { runMarketScannerDashboard } = await import('./marketScannerDashboard');
          await runMarketScannerDashboard();
        })
    )
    .addCommand(
      new Command('import-historical-klines')
        .description(
          'Import normalized 1m historical klines into SQLite and aggregate higher timeframes'
        )
        .argument('<pair>', 'Symbol or pair name (for example SOLUSDT)')
        .argument('<csv>', 'Normalized 1m CSV file path')
        .action(async (pair: string, csv: string) => {
          logger.info(`Starting in Historical Klines Import mode...`);
          await loadNexusConfig();
          await importHistoricalKlines(pair, csv);
          return;
        })
    )
    .addCommand(
      new Command('normalize-historical-data')
        .description('Normalize historical data CSV file')
        .argument('<csv>', 'CSV file path')
        .action(async (csv: string) => {
          logger.info(`Starting in Historical Data Normalization mode...`);
          normalizeHistoricalData(csv);
          return;
        })
    )
    .addCommand(
      new Command('download-historical-data')
        .description('Download historical klines data from exchange')
        .argument('[startDate]', 'start date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)')
        .argument('[endDate]', 'end date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)')
        .action(async (startDate: string, endDate: string) => {
          if (!startDate || !endDate) {
            logger.error(
              'Please provide both startDate and endDate in the format YYYY-MM-DD or YYYY-MM-DD HH:MM:SS'
            );
            process.exit(1);
          }
          logger.info(`Starting in Historical Data Downloader mode...`);
          await downloadHistoricalData(startDate, endDate);
          return;
        })
    );

  program.addCommand(createDownloadHistoricalBinanceDataCommand());

  await program.parseAsync();
}
// Start the application
main().catch(console.error);
