export type MarketScannerConfig = {
  enabled?: boolean;
  /**
   * Deprecated alias for sourceExchangeId. Kept so older configs keep working.
   */
  exchangeId?: string;
  sourceExchangeId?: string;
  tradableExchangeId?: string;
  marketTypes?: string[];
  quoteCurrencies?: string[];
  includeSymbols?: string[];
  excludeSymbols?: string[];
  maxSymbols?: number;
  statsWindowMs?: number;
  publishIntervalMs?: number;
  subscribeDelayMs?: number;
};

export type ResolvedMarketScannerConfig = Required<
  Pick<
    MarketScannerConfig,
    | 'enabled'
    | 'sourceExchangeId'
    | 'tradableExchangeId'
    | 'statsWindowMs'
    | 'publishIntervalMs'
    | 'subscribeDelayMs'
  >
> &
  Pick<
    MarketScannerConfig,
    'marketTypes' | 'quoteCurrencies' | 'includeSymbols' | 'excludeSymbols' | 'maxSymbols'
  >;

export const DEFAULT_MARKET_SCANNER_CONFIG: ResolvedMarketScannerConfig = {
  enabled: false,
  sourceExchangeId: 'binance',
  tradableExchangeId: 'phemex',
  marketTypes: ['swap', 'future'],
  statsWindowMs: 60_000,
  publishIntervalMs: 1_000,
  subscribeDelayMs: 25,
};

export type MarketScannerTrade = {
  exchangeId: string;
  symbol: string;
  side: 'buy' | 'sell' | 'unknown';
  price: number;
  amount: number;
  cost: number;
  timestamp: number;
};

export type MarketScannerSymbolStats = {
  exchangeId: string;
  symbol: string;
  timestamp: number;
  windowMs: number;
  lastPrice: number;
  lastTradeTimestamp: number;
  tradeCount: number;
  tradesPerSecond: number;
  buyCount: number;
  sellCount: number;
  buyCost: number;
  sellCost: number;
  buyVolume: number;
  sellVolume: number;
  totalCost: number;
  totalVolume: number;
  netCost: number;
  vwap: number;
  open: number;
  high: number;
  low: number;
  priceChangeAbs: number;
  priceChangePct: number;
  priceChange5mAbs: number;
  priceChange5mPct: number;
  priceChange15mAbs: number;
  priceChange15mPct: number;
  priceChange1hAbs: number;
  priceChange1hPct: number;
};

export type MarketScannerSnapshot = {
  type: 'market-scanner-snapshot';
  exchangeId: string;
  timestamp: number;
  windowMs: number;
  symbolsCount: number;
  activeSymbolsCount: number;
  totals: {
    tradeCount: number;
    tradesPerSecond: number;
    buyCost: number;
    sellCost: number;
    totalCost: number;
    totalVolume: number;
    netCost: number;
  };
  symbols: MarketScannerSymbolStats[];
};

export type MarketScannerWorkerConfigMessage = {
  type: 'config';
  config: ResolvedMarketScannerConfig;
};

export type MarketScannerWorkerStartedMessage = {
  type: 'started';
  exchangeId: string;
  sourceExchangeId: string;
  tradableExchangeId: string;
  symbols: string[];
  tradableSymbolsCount: number;
};

export type MarketScannerWorkerTradeMessage = {
  type: 'trade';
} & MarketScannerTrade;

export type MarketScannerWorkerErrorMessage = {
  type: 'error';
  exchangeId: string;
  symbol?: string;
  error: string;
};

export type MarketScannerWorkerMessage =
  | MarketScannerWorkerStartedMessage
  | MarketScannerWorkerTradeMessage
  | MarketScannerWorkerErrorMessage;
