import path from 'path';
import type { WorkerMessage } from './ExchangeWorker';
import { NexusConfig } from './NexusConfig';
import type { ExchangeAggregation } from './types';
import { TickAggregator } from './aggregator/TickAggregator';
import { KlinesBuffer } from './aggregator/KlinesBuffer';
import { AggrSocketServer } from './AggrSocketServer';
import { QuerySocketServer } from './QuerySocketServer';
import type { TerminalPriceDashboard } from './TerminalPriceDashboard';
import { registerGracefulShutdown } from '@/utils/gracefulShutdown';
import { MarketScannerStats } from './marketScanner/MarketScannerStats';
import { MarketScannerSocketServer } from './marketScanner/MarketScannerSocketServer';
import type {
  MarketScannerSnapshot,
  MarketScannerWorkerMessage,
  ResolvedMarketScannerConfig,
} from './marketScanner/types';

export class NexusServer {
  private static instance: NexusServer;

  private aggregationsPairs = new Map<string, ExchangeAggregation>();
  private aggregator: TickAggregator;
  private readonly aggrSocketServer = new AggrSocketServer();
  private readonly querySocketServer = new QuerySocketServer();
  private readonly marketScannerSocketServer = new MarketScannerSocketServer();
  private readonly klinesBuffer = new KlinesBuffer();
  private readonly marketScannerConfig: ResolvedMarketScannerConfig;
  private readonly marketScannerStats: MarketScannerStats;
  private priceDashboard: TerminalPriceDashboard | null = null;
  private marketScannerSnapshotInterval: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    this.aggregationsPairs = new Map(Object.entries(NexusConfig.aggregatedPairs));
    this.marketScannerConfig = NexusConfig.getResolvedMarketScannerConfig();
    this.marketScannerStats = new MarketScannerStats(this.marketScannerConfig.statsWindowMs);
    this.aggregator = new TickAggregator(
      NexusConfig.aggregatedPairs,
      (pair, timeframe, bucket) => {
        this.aggrSocketServer.broadcast({ pair, timeframe, ...bucket });
        this.klinesBuffer.add(pair, timeframe, bucket);
      },
      (pair, timeframe, deltaBucket) => {
        this.aggrSocketServer.broadcast({ pair, timeframe, ...deltaBucket });
      }
    );
  }

  private getExchangesToInitialize(): string[] {
    const exchangesSet = new Set<string>();
    for (const aggregation of this.aggregationsPairs.values()) {
      for (const exchangePair of aggregation) {
        exchangesSet.add(exchangePair.exchangeId);
      }
    }
    return Array.from(exchangesSet);
  }

  private getPairsByExchange(exchangeId: string): string[] {
    const pairsSet = new Set<string>();
    for (const aggregation of this.aggregationsPairs.values()) {
      for (const exchangePair of aggregation) {
        if (exchangePair.exchangeId === exchangeId) {
          exchangePair.pairs.forEach((pair) => pairsSet.add(pair));
        }
      }
    }
    return Array.from(pairsSet);
  }

  private spawnExchangeWorker(
    exchangeId: string,
    pairs: string[],
    dashboardEnabled: boolean
  ): Worker {
    const workerRelativePath = './nexus/ExchangeWorker.ts';
    const workerUrl =
      process.env.SIO_NEXUS_IS_BINARY === 'true'
        ? workerRelativePath
        : path.resolve(__dirname, './ExchangeWorker.ts');
    const worker = new Worker(workerUrl, { type: 'module', name: `Worker-${exchangeId}` });

    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'started':
          if (dashboardEnabled && this.priceDashboard) {
            this.priceDashboard.markStarted(msg.exchangeId);
          }
          if (!this.priceDashboard?.isActive) {
            console.log(`[${msg.exchangeId}] Worker started for pairs: ${msg.pairs.join(', ')}`);
          }
          break;
        case 'trade':
          if (dashboardEnabled && this.priceDashboard) {
            this.priceDashboard.updatePrice(msg.exchangeId, msg.symbol, msg.price);
          }
          this.aggregator.processTrade(msg);
          break;
        case 'liquidation':
          this.aggregator.processLiquidation(msg);
          break;
        case 'error':
          if (dashboardEnabled && this.priceDashboard) {
            this.priceDashboard.markError(msg.exchangeId, msg.error);
          }
          if (!this.priceDashboard?.isActive) {
            console.error(`[${msg.exchangeId}] Worker error:`, msg.error);
          }
          break;
      }
    });

    worker.addEventListener('error', (event) => {
      if (dashboardEnabled && this.priceDashboard) {
        this.priceDashboard.markInfo(exchangeId, `worker thread crashed: ${String(event.message)}`);
      }
      console.error(`[${exchangeId}] Worker thread crashed:`, event);
    });

    // Send config to the worker to start processing
    worker.postMessage({ type: 'config', exchangeId, pairs });

    return worker;
  }

  private spawnMarketScannerWorker(): Worker {
    const workerRelativePath = './nexus/marketScanner/MarketScannerWorker.ts';
    const workerUrl =
      process.env.SIO_NEXUS_IS_BINARY === 'true'
        ? workerRelativePath
        : path.resolve(__dirname, './marketScanner/MarketScannerWorker.ts');
    const worker = new Worker(workerUrl, {
      type: 'module',
      name: `MarketScanner-${this.marketScannerConfig.sourceExchangeId}`,
    });

    worker.addEventListener('message', (event: MessageEvent<MarketScannerWorkerMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'started':
          console.log(
            `[MarketScanner] ${msg.exchangeId} started for ${msg.symbols.length} symbols`
          );
          this.marketScannerStats.setWatchedSymbols(msg.exchangeId, msg.symbols);
          this.marketScannerSocketServer.broadcast({
            type: 'market-scanner-started',
            exchangeId: msg.exchangeId,
            sourceExchangeId: msg.sourceExchangeId,
            tradableExchangeId: msg.tradableExchangeId,
            symbols: msg.symbols,
            symbolsCount: msg.symbols.length,
            tradableSymbolsCount: msg.tradableSymbolsCount,
          });
          break;
        case 'trade':
          this.marketScannerStats.processTrade(msg);
          break;
        case 'error':
          console.error(
            `[MarketScanner] ${msg.exchangeId}${msg.symbol ? ` ${msg.symbol}` : ''}: ${msg.error}`
          );
          this.marketScannerSocketServer.broadcast({
            type: 'market-scanner-error',
            exchangeId: msg.exchangeId,
            symbol: msg.symbol,
            error: msg.error,
          });
          break;
      }
    });

    worker.addEventListener('error', (event) => {
      console.error(`[MarketScanner] Worker thread crashed:`, event);
    });

    worker.postMessage({ type: 'config', config: this.marketScannerConfig });

    return worker;
  }

  private startMarketScanner(): void {
    this.marketScannerSocketServer.start();
    this.spawnMarketScannerWorker();
    this.marketScannerSnapshotInterval = setInterval(() => {
      const snapshot: MarketScannerSnapshot = this.marketScannerStats.getSnapshot();
      if (!snapshot.exchangeId) {
        snapshot.exchangeId = this.marketScannerConfig.sourceExchangeId;
      }
      this.marketScannerSocketServer.broadcast(snapshot);
    }, this.marketScannerConfig.publishIntervalMs);
  }

  private async tryStartDashboard(exchangeIds: string[]): Promise<boolean> {
    try {
      const { TerminalPriceDashboard } = await import('./TerminalPriceDashboard');
      this.priceDashboard = new TerminalPriceDashboard();
      this.priceDashboard.start(exchangeIds);
      return true;
    } catch (error) {
      console.error(
        '[dashboard] Terminal dashboard could not be initialized. Continuing without UI.'
      );
      console.error(error);
      this.priceDashboard = null;
      return false;
    }
  }

  private async watchExchanges(dashboardEnabled: boolean): Promise<void> {
    const exchangeIds = this.getExchangesToInitialize();
    let effectiveDashboardEnabled = dashboardEnabled;
    if (dashboardEnabled) {
      effectiveDashboardEnabled = await this.tryStartDashboard(exchangeIds);
    }

    this.querySocketServer.setInfoLogSink(
      effectiveDashboardEnabled && this.priceDashboard?.isActive
        ? (message) => this.priceDashboard?.markInfo('query-socket', message)
        : null
    );

    for (const exchangeId of exchangeIds) {
      const pairs = this.getPairsByExchange(exchangeId);
      this.spawnExchangeWorker(exchangeId, pairs, effectiveDashboardEnabled);
    }

    // Keep main thread alive while workers run
    await new Promise(() => {});
  }

  public static getInstance(): NexusServer {
    if (!NexusServer.instance) {
      NexusServer.instance = new NexusServer();
    }
    return NexusServer.instance;
  }

  public async run(options?: { dashboard?: boolean; marketScanner?: boolean }): Promise<void> {
    const dashboardEnabled = options?.dashboard ?? false;
    const marketScannerEnabled = options?.marketScanner ?? this.marketScannerConfig.enabled;
    registerGracefulShutdown(() => {
      this.klinesBuffer.stop();
      this.priceDashboard?.stop();
      if (this.marketScannerSnapshotInterval) {
        clearInterval(this.marketScannerSnapshotInterval);
        this.marketScannerSnapshotInterval = null;
      }
      this.marketScannerSocketServer.close();
    });
    this.aggrSocketServer.start();
    this.querySocketServer.start();
    if (marketScannerEnabled) {
      this.startMarketScanner();
    }
    await this.watchExchanges(dashboardEnabled);
  }
}
