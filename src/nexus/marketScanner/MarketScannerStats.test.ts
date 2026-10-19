import { describe, expect, it } from 'bun:test';
import { MarketScannerStats } from './MarketScannerStats';

describe('MarketScannerStats', () => {
  it('builds rolling per-symbol flow stats', () => {
    const stats = new MarketScannerStats(60_000);

    stats.processTrade({
      exchangeId: 'phemex',
      symbol: 'SOL/USDT:USDT',
      side: 'buy',
      price: 100,
      amount: 2,
      cost: 200,
      timestamp: 1_000,
    });
    stats.processTrade({
      exchangeId: 'phemex',
      symbol: 'SOL/USDT:USDT',
      side: 'sell',
      price: 110,
      amount: 1,
      cost: 110,
      timestamp: 2_000,
    });

    const snapshot = stats.getSnapshot(3_000);
    const symbol = snapshot.symbols[0];

    expect(snapshot.type).toBe('market-scanner-snapshot');
    expect(snapshot.activeSymbolsCount).toBe(1);
    expect(snapshot.totals.tradeCount).toBe(2);
    expect(symbol?.symbol).toBe('SOL/USDT:USDT');
    expect(symbol?.lastPrice).toBe(110);
    expect(symbol?.tradeCount).toBe(2);
    expect(symbol?.buyCost).toBe(200);
    expect(symbol?.sellCost).toBe(110);
    expect(symbol?.netCost).toBe(90);
    expect(symbol?.totalVolume).toBe(3);
    expect(symbol?.vwap).toBeCloseTo(310 / 3);
    expect(symbol?.priceChangePct).toBe(10);
  });

  it('keeps last price but removes stale trades from the active window', () => {
    const stats = new MarketScannerStats(1_000);

    stats.processTrade({
      exchangeId: 'phemex',
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      price: 100,
      amount: 1,
      cost: 100,
      timestamp: 1_000,
    });

    const snapshot = stats.getSnapshot(3_000);
    const symbol = snapshot.symbols[0];

    expect(snapshot.activeSymbolsCount).toBe(0);
    expect(symbol?.lastPrice).toBe(100);
    expect(symbol?.tradeCount).toBe(0);
    expect(symbol?.totalCost).toBe(0);
  });

  it('includes watched symbols before their first trade', () => {
    const stats = new MarketScannerStats(60_000);

    stats.setWatchedSymbols('phemex', ['BTC/USDT:USDT', 'SOL/USDT:USDT']);

    const snapshot = stats.getSnapshot(1_000);

    expect(snapshot.symbolsCount).toBe(2);
    expect(snapshot.activeSymbolsCount).toBe(0);
    expect(snapshot.symbols.map((symbol) => symbol.symbol).sort()).toEqual([
      'BTC/USDT:USDT',
      'SOL/USDT:USDT',
    ]);
  });

  it('counts unknown-side trades in total flow without changing net flow', () => {
    const stats = new MarketScannerStats(60_000);

    stats.processTrade({
      exchangeId: 'phemex',
      symbol: 'ETH/USDT:USDT',
      side: 'unknown',
      price: 100,
      amount: 2,
      cost: 200,
      timestamp: 1_000,
    });

    const symbol = stats.getSnapshot(2_000).symbols[0];

    expect(symbol?.tradeCount).toBe(1);
    expect(symbol?.totalCost).toBe(200);
    expect(symbol?.totalVolume).toBe(2);
    expect(symbol?.netCost).toBe(0);
  });

  it('publishes price changes for 5m, 15m, and 1h windows', () => {
    const stats = new MarketScannerStats(60_000);
    const minute = 60_000;
    const baseTrade = {
      exchangeId: 'phemex',
      symbol: 'SOL/USDT:USDT',
      side: 'buy' as const,
      amount: 1,
    };

    stats.processTrade({ ...baseTrade, price: 100, cost: 100, timestamp: 2 * minute });
    stats.processTrade({ ...baseTrade, price: 120, cost: 120, timestamp: 50 * minute });
    stats.processTrade({ ...baseTrade, price: 140, cost: 140, timestamp: 58 * minute });
    stats.processTrade({ ...baseTrade, price: 150, cost: 150, timestamp: 61 * minute });

    const symbol = stats.getSnapshot(61 * minute).symbols[0];

    expect(symbol?.priceChangePct).toBe(0);
    expect(symbol?.priceChange5mPct).toBeCloseTo((10 / 140) * 100);
    expect(symbol?.priceChange15mPct).toBe(25);
    expect(symbol?.priceChange1hPct).toBe(50);
  });
});
