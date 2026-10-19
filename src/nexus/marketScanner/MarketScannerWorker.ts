import { sleep } from 'bun';
import { pro as ccxtpro, Exchange } from 'ccxt';
import WebSocket from 'ws';
import type {
  MarketScannerTrade,
  MarketScannerWorkerConfigMessage,
  ResolvedMarketScannerConfig,
} from './types';

export type MarketLike = {
  id?: string;
  symbol?: string;
  base?: string;
  active?: boolean;
  quote?: string;
  contract?: boolean;
  linear?: boolean;
  spot?: boolean;
  swap?: boolean;
  future?: boolean;
  option?: boolean;
  type?: string;
};

type SourceMarketSelection = {
  symbol: string;
  subscriptionGroup: string;
};

declare function postMessage(msg: unknown): void;

const BINANCE_WATCH_TRADES_FOR_SYMBOLS_LIMIT = 200;

let bunWsUpgradePatched = false;

const patchWsUpgradeListenerForBun = () => {
  if (bunWsUpgradePatched || typeof Bun === 'undefined') {
    return;
  }

  const originalOn = WebSocket.prototype.on as typeof WebSocket.prototype.on;
  if (typeof originalOn !== 'function') {
    return;
  }

  const patchedOn = function (this: WebSocket, event: unknown, listener: unknown) {
    if (event === 'upgrade') {
      return this;
    }
    return (originalOn as any).call(this, event, listener);
  } as typeof WebSocket.prototype.on;

  WebSocket.prototype.on = patchedOn;

  bunWsUpgradePatched = true;
};

const normalizeSide = (side: unknown): MarketScannerTrade['side'] => {
  return side === 'buy' || side === 'sell' ? side : 'unknown';
};

const wildcardToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
};

const matchesPattern = (symbol: string, pattern: string): boolean => {
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    return new RegExp(pattern.slice(1, -1), 'i').test(symbol);
  }
  if (pattern.includes('*')) {
    return wildcardToRegExp(pattern).test(symbol);
  }
  return symbol.toLowerCase() === pattern.toLowerCase();
};

const matchesAny = (symbol: string, patterns: string[] | undefined): boolean => {
  return patterns?.some((pattern) => matchesPattern(symbol, pattern)) ?? false;
};

const getMarketType = (market: MarketLike): string | null => {
  if (typeof market.type === 'string') {
    return market.type;
  }
  if (market.spot) return 'spot';
  if (market.swap) return 'swap';
  if (market.future) return 'future';
  if (market.option) return 'option';
  return null;
};

const isSelectedMarket = (market: MarketLike, config: ResolvedMarketScannerConfig): boolean => {
  const symbol = market.symbol;
  if (!symbol) {
    return false;
  }
  if (market.active === false) {
    return false;
  }
  if (config.marketTypes?.length) {
    const marketType = getMarketType(market);
    if (!marketType || !config.marketTypes.includes(marketType)) {
      return false;
    }
  }
  if (config.quoteCurrencies?.length) {
    const quote = market.quote?.toUpperCase();
    if (!quote || !config.quoteCurrencies.map((q) => q.toUpperCase()).includes(quote)) {
      return false;
    }
  }
  if (config.includeSymbols?.length && !matchesAny(symbol, config.includeSymbols)) {
    return false;
  }
  if (matchesAny(symbol, config.excludeSymbols)) {
    return false;
  }
  return true;
};

const isSelectedSourceMarket = (
  market: MarketLike,
  config: ResolvedMarketScannerConfig
): boolean => {
  const symbol = market.symbol;
  if (!symbol) {
    return false;
  }
  if (market.active === false) {
    return false;
  }
  if (config.marketTypes?.length) {
    const marketType = getMarketType(market);
    if (!marketType || !config.marketTypes.includes(marketType)) {
      return false;
    }
  }
  return true;
};

const getSubscriptionGroup = (market: MarketLike): string => {
  const marketType = getMarketType(market) ?? 'unknown';
  if (!market.contract) {
    return marketType;
  }
  const subtype =
    market.linear === true ? 'linear' : market.linear === false ? 'inverse' : 'unknown';
  return `${marketType}:${subtype}`;
};

const getMarketKey = (market: MarketLike): string | null => {
  const base = market.base?.toUpperCase();
  const quote = market.quote?.toUpperCase();
  if (base && quote) {
    return `${base}/${quote}`;
  }

  const symbol = market.symbol;
  if (!symbol) {
    return null;
  }

  const [basePart, rawQuotePart] = symbol.split('/');
  const quotePart = rawQuotePart?.split(':')[0];
  if (!basePart || !quotePart) {
    return null;
  }

  return `${basePart.toUpperCase()}/${quotePart.toUpperCase()}`;
};

const getExchangeClass = (exchangeId: string): typeof Exchange | null => {
  return (ccxtpro as Record<string, typeof Exchange>)[exchangeId] ?? null;
};

const createExchange = (exchangeId: string): Exchange | null => {
  const exchangeClass = getExchangeClass(exchangeId);
  return exchangeClass ? new exchangeClass({ enableRateLimit: true }) : null;
};

const getMarkets = async (exchange: Exchange): Promise<MarketLike[]> => {
  await exchange.loadMarkets();
  return Object.values(exchange.markets as Record<string, MarketLike>);
};

const resolveSourceSymbols = async (
  sourceExchange: Exchange,
  tradableExchange: Exchange,
  config: ResolvedMarketScannerConfig
): Promise<{
  sourceSymbols: string[];
  sourceMarkets: SourceMarketSelection[];
  tradableSymbolsCount: number;
}> => {
  const tradableMarkets = await getMarkets(tradableExchange);
  const sourceMarkets = await getMarkets(sourceExchange);

  return resolveSourceSymbolsFromMarkets(sourceMarkets, tradableMarkets, config);
};

export const resolveSourceSymbolsFromMarkets = (
  sourceMarkets: MarketLike[],
  tradableMarkets: MarketLike[],
  config: ResolvedMarketScannerConfig
): {
  sourceSymbols: string[];
  sourceMarkets: SourceMarketSelection[];
  tradableSymbolsCount: number;
} => {
  const tradableMarketKeys = new Set(
    tradableMarkets
      .filter((market) => isSelectedMarket(market, config))
      .map((market) => getMarketKey(market))
      .filter((key): key is string => key !== null)
  );

  const selectedSourceMarkets = sourceMarkets
    .filter((market) => isSelectedSourceMarket(market, config))
    .filter((market) => {
      const marketKey = getMarketKey(market);
      return marketKey !== null && tradableMarketKeys.has(marketKey);
    })
    .flatMap((market) => {
      if (!market.symbol) {
        return [];
      }
      return [{ symbol: market.symbol, subscriptionGroup: getSubscriptionGroup(market) }];
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const cappedSourceMarkets =
    typeof config.maxSymbols === 'number' && config.maxSymbols > 0
      ? selectedSourceMarkets.slice(0, config.maxSymbols)
      : selectedSourceMarkets;

  return {
    sourceSymbols: cappedSourceMarkets.map((market) => market.symbol),
    sourceMarkets: cappedSourceMarkets,
    tradableSymbolsCount: tradableMarketKeys.size,
  };
};

const postTrades = (
  trades: Awaited<ReturnType<Exchange['watchTrades']>>,
  exchangeId: string,
  fallbackSymbol?: string
): void => {
  for (const trade of trades) {
    const symbol = trade.symbol ?? fallbackSymbol;
    if (!symbol) {
      continue;
    }

    const price = Number(trade.price);
    const amount = Number(trade.amount);
    if (!Number.isFinite(price) || !Number.isFinite(amount) || price <= 0 || amount <= 0) {
      continue;
    }

    const rawCost = Number(trade.cost);
    const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : price * amount;
    const rawTimestamp = Number(trade.timestamp);
    const timestamp = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp : Date.now();

    postMessage({
      type: 'trade',
      exchangeId,
      symbol,
      side: normalizeSide(trade.side),
      price,
      amount,
      cost,
      timestamp,
    });
  }
};

const watchSymbolTrades = async (
  exchange: Exchange,
  exchangeId: string,
  symbol: string
): Promise<void> => {
  while (true) {
    try {
      const trades = await exchange.watchTrades(symbol);
      postTrades(trades, exchangeId, symbol);
    } catch (error) {
      postMessage({ type: 'error', exchangeId, symbol, error: String(error) });
      await sleep(1000);
    }
  }
};

const watchSymbolsTrades = async (
  exchange: Exchange,
  exchangeId: string,
  symbols: string[]
): Promise<void> => {
  while (true) {
    try {
      const trades = await exchange.watchTradesForSymbols(symbols);
      postTrades(trades, exchangeId);
    } catch (error) {
      postMessage({
        type: 'error',
        exchangeId,
        error: `watchTradesForSymbols failed for ${symbols.length} symbols: ${String(error)}`,
      });
      await sleep(1000);
    }
  }
};

const chunkSymbols = (symbols: string[], chunkSize: number): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }
  return chunks;
};

const groupSourceMarkets = (sourceMarkets: SourceMarketSelection[]): string[][] => {
  const groups = new Map<string, string[]>();
  for (const market of sourceMarkets) {
    const symbols = groups.get(market.subscriptionGroup) ?? [];
    symbols.push(market.symbol);
    groups.set(market.subscriptionGroup, symbols);
  }

  return Array.from(groups.values()).flatMap((symbols) =>
    chunkSymbols(symbols, BINANCE_WATCH_TRADES_FOR_SYMBOLS_LIMIT)
  );
};

const watchSourceTrades = async (
  exchange: Exchange,
  exchangeId: string,
  sourceMarkets: SourceMarketSelection[],
  subscribeDelayMs: number
): Promise<void> => {
  const canWatchTradesForSymbols =
    (exchange.has as Record<string, unknown>).watchTradesForSymbols === true &&
    typeof exchange.watchTradesForSymbols === 'function';

  if (canWatchTradesForSymbols) {
    for (const chunk of groupSourceMarkets(sourceMarkets)) {
      void watchSymbolsTrades(exchange, exchangeId, chunk);
      if (subscribeDelayMs > 0) {
        await sleep(subscribeDelayMs);
      }
    }
    return;
  }

  for (const market of sourceMarkets) {
    void watchSymbolTrades(exchange, exchangeId, market.symbol);
    if (subscribeDelayMs > 0) {
      await sleep(subscribeDelayMs);
    }
  }
};

const runWorker = async (config: ResolvedMarketScannerConfig) => {
  const { sourceExchangeId, tradableExchangeId } = config;
  const sourceExchange = createExchange(sourceExchangeId);
  if (!sourceExchange) {
    postMessage({
      type: 'error',
      exchangeId: sourceExchangeId,
      error: `Unknown exchange: ${sourceExchangeId}`,
    });
    return;
  }

  const tradableExchange = createExchange(tradableExchangeId);
  if (!tradableExchange) {
    postMessage({
      type: 'error',
      exchangeId: tradableExchangeId,
      error: `Unknown exchange: ${tradableExchangeId}`,
    });
    return;
  }

  const { sourceSymbols, sourceMarkets, tradableSymbolsCount } = await resolveSourceSymbols(
    sourceExchange,
    tradableExchange,
    config
  );
  postMessage({
    type: 'started',
    exchangeId: sourceExchangeId,
    sourceExchangeId,
    tradableExchangeId,
    symbols: sourceSymbols,
    tradableSymbolsCount,
  });

  await watchSourceTrades(sourceExchange, sourceExchangeId, sourceMarkets, config.subscribeDelayMs);
  await new Promise(() => {});
};

addEventListener('message', (event: MessageEvent<MarketScannerWorkerConfigMessage>) => {
  patchWsUpgradeListenerForBun();
  if (event.data.type !== 'config') {
    return;
  }

  const scannerConfig = event.data.config;
  void runWorker(scannerConfig).catch(async (error) => {
    postMessage({
      type: 'error',
      exchangeId: scannerConfig.sourceExchangeId,
      error: `Market scanner fatal error, restarting in 5000ms: ${String(error)}`,
    });
    await sleep(5000);
    void runWorker(scannerConfig);
  });
});
