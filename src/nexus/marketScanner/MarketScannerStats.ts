import type { MarketScannerSnapshot, MarketScannerSymbolStats, MarketScannerTrade } from './types';

type TradeEntry = {
  side: 'buy' | 'sell' | 'unknown';
  price: number;
  amount: number;
  cost: number;
  timestamp: number;
};

type PriceSample = {
  price: number;
  timestamp: number;
};

type SymbolState = {
  exchangeId: string;
  symbol: string;
  trades: TradeEntry[];
  priceSamples: PriceSample[];
  lastPrice: number;
  lastTradeTimestamp: number;
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export class MarketScannerStats {
  private readonly symbols = new Map<string, SymbolState>();

  constructor(private readonly windowMs: number) {}

  setWatchedSymbols(exchangeId: string, symbols: string[]): void {
    for (const symbol of symbols) {
      this.getOrCreateSymbolState(exchangeId, symbol);
    }
  }

  processTrade(trade: MarketScannerTrade): void {
    if (
      !Number.isFinite(trade.price) ||
      !Number.isFinite(trade.amount) ||
      !Number.isFinite(trade.cost) ||
      !Number.isFinite(trade.timestamp) ||
      trade.price <= 0 ||
      trade.amount <= 0 ||
      trade.cost <= 0
    ) {
      return;
    }

    const state = this.getOrCreateSymbolState(trade.exchangeId, trade.symbol);
    state.trades.push({
      side: trade.side,
      price: trade.price,
      amount: trade.amount,
      cost: trade.cost,
      timestamp: trade.timestamp,
    });
    state.priceSamples.push({ price: trade.price, timestamp: trade.timestamp });
    state.lastPrice = trade.price;
    state.lastTradeTimestamp = trade.timestamp;
    this.prune(state, trade.timestamp);
  }

  getSnapshot(now = Date.now()): MarketScannerSnapshot {
    const symbols: MarketScannerSymbolStats[] = [];

    for (const state of this.symbols.values()) {
      this.prune(state, now);
      symbols.push(this.buildSymbolStats(state, now));
    }

    symbols.sort((a, b) => {
      if (b.totalCost !== a.totalCost) {
        return b.totalCost - a.totalCost;
      }
      return a.symbol.localeCompare(b.symbol);
    });

    const totals = symbols.reduce(
      (acc, stats) => {
        acc.tradeCount += stats.tradeCount;
        acc.buyCost += stats.buyCost;
        acc.sellCost += stats.sellCost;
        acc.totalCost += stats.totalCost;
        acc.totalVolume += stats.totalVolume;
        acc.netCost += stats.netCost;
        return acc;
      },
      {
        tradeCount: 0,
        tradesPerSecond: 0,
        buyCost: 0,
        sellCost: 0,
        totalCost: 0,
        totalVolume: 0,
        netCost: 0,
      }
    );
    totals.tradesPerSecond = totals.tradeCount / (this.windowMs / 1000);

    return {
      type: 'market-scanner-snapshot',
      exchangeId: symbols[0]?.exchangeId ?? '',
      timestamp: now,
      windowMs: this.windowMs,
      symbolsCount: symbols.length,
      activeSymbolsCount: symbols.filter((stats) => stats.tradeCount > 0).length,
      totals,
      symbols,
    };
  }

  private getOrCreateSymbolState(exchangeId: string, symbol: string): SymbolState {
    const key = `${exchangeId}:${symbol}`;
    let state = this.symbols.get(key);
    if (!state) {
      state = {
        exchangeId,
        symbol,
        trades: [],
        priceSamples: [],
        lastPrice: 0,
        lastTradeTimestamp: 0,
      };
      this.symbols.set(key, state);
    }
    return state;
  }

  private buildSymbolStats(state: SymbolState, now: number): MarketScannerSymbolStats {
    const trades = state.trades;
    const first = trades[0];
    const last = trades.at(-1);
    let buyCount = 0;
    let sellCount = 0;
    let buyCost = 0;
    let sellCost = 0;
    let buyVolume = 0;
    let sellVolume = 0;
    let totalCost = 0;
    let totalVolume = 0;
    let high = first?.price ?? state.lastPrice;
    let low = first?.price ?? state.lastPrice;

    for (const trade of trades) {
      totalCost += trade.cost;
      totalVolume += trade.amount;
      if (trade.price > high) {
        high = trade.price;
      }
      if (trade.price < low) {
        low = trade.price;
      }
      if (trade.side === 'buy') {
        buyCount++;
        buyCost += trade.cost;
        buyVolume += trade.amount;
      } else if (trade.side === 'sell') {
        sellCount++;
        sellCost += trade.cost;
        sellVolume += trade.amount;
      }
    }

    const open = first?.price ?? state.lastPrice;
    const close = last?.price ?? state.lastPrice;
    const priceChangeAbs = close - open;
    const priceChangePct = open > 0 ? (priceChangeAbs / open) * 100 : 0;
    const priceChange5m = this.getPriceChangeForWindow(state, close, now, FIVE_MINUTES_MS);
    const priceChange15m = this.getPriceChangeForWindow(state, close, now, FIFTEEN_MINUTES_MS);
    const priceChange1h = this.getPriceChangeForWindow(state, close, now, ONE_HOUR_MS);

    return {
      exchangeId: state.exchangeId,
      symbol: state.symbol,
      timestamp: now,
      windowMs: this.windowMs,
      lastPrice: close,
      lastTradeTimestamp: state.lastTradeTimestamp,
      tradeCount: trades.length,
      tradesPerSecond: trades.length / (this.windowMs / 1000),
      buyCount,
      sellCount,
      buyCost,
      sellCost,
      buyVolume,
      sellVolume,
      totalCost,
      totalVolume,
      netCost: buyCost - sellCost,
      vwap: totalVolume > 0 ? totalCost / totalVolume : close,
      open,
      high,
      low,
      priceChangeAbs,
      priceChangePct,
      priceChange5mAbs: priceChange5m.abs,
      priceChange5mPct: priceChange5m.pct,
      priceChange15mAbs: priceChange15m.abs,
      priceChange15mPct: priceChange15m.pct,
      priceChange1hAbs: priceChange1h.abs,
      priceChange1hPct: priceChange1h.pct,
    };
  }

  private getPriceChangeForWindow(
    state: SymbolState,
    close: number,
    now: number,
    windowMs: number
  ): { abs: number; pct: number } {
    if (close <= 0) {
      return { abs: 0, pct: 0 };
    }

    const cutoff = now - windowMs;
    const baseline = state.priceSamples.find((sample) => sample.timestamp >= cutoff);
    const open = baseline?.price ?? close;
    const abs = close - open;

    return {
      abs,
      pct: open > 0 ? (abs / open) * 100 : 0,
    };
  }

  private prune(state: SymbolState, now: number): void {
    const cutoff = now - this.windowMs;
    while (state.trades.length > 0 && state.trades[0]!.timestamp < cutoff) {
      state.trades.shift();
    }

    const priceCutoff = now - ONE_HOUR_MS;
    while (state.priceSamples.length > 0 && state.priceSamples[0]!.timestamp < priceCutoff) {
      state.priceSamples.shift();
    }
  }
}
