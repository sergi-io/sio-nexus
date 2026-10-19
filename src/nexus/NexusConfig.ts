import fs from 'fs';
import type { ExchangeAggregation } from './types';
import {
  DEFAULT_MARKET_SCANNER_CONFIG,
  type MarketScannerConfig,
  type ResolvedMarketScannerConfig,
} from './marketScanner/types';

export class NexusConfig {
  public static aggregatedPairs: Record<string, ExchangeAggregation> = {};
  public static secondsBufferFlushToDB: number = 60;
  public static sqliteKlinesDBPath: string = './data/klines.db';
  public static marketScanner: MarketScannerConfig = {};

  public static getResolvedMarketScannerConfig(): ResolvedMarketScannerConfig {
    const sourceExchangeId =
      this.marketScanner.sourceExchangeId ??
      this.marketScanner.exchangeId ??
      DEFAULT_MARKET_SCANNER_CONFIG.sourceExchangeId;

    return {
      ...DEFAULT_MARKET_SCANNER_CONFIG,
      ...this.marketScanner,
      sourceExchangeId,
      tradableExchangeId:
        this.marketScanner.tradableExchangeId ?? DEFAULT_MARKET_SCANNER_CONFIG.tradableExchangeId,
    };
  }

  // #################################################################
  // # LoadFromFile
  // #################################################################

  public static loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`NexusConfig loadFromFile: File does not exist: ${filePath}`);
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsedData = Bun.JSON5.parse(data) as Record<string, unknown>;

    if (
      parsedData.secondsBufferFlushToDB === undefined &&
      typeof parsedData.klinesBufferSizeToFlush === 'number'
    ) {
      parsedData.secondsBufferFlushToDB = parsedData.klinesBufferSizeToFlush;
    }

    Object.keys(parsedData).forEach((rawKey) => {
      const k = rawKey as keyof NexusConfig;
      const value = parsedData[rawKey];
      if (typeof this[k] !== 'function') {
        (this as any)[k] = value;
      }
    });
  }
}
