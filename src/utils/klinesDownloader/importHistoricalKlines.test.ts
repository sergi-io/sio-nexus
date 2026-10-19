import { describe, expect, it } from 'bun:test';
import type { AggBucket } from '@/nexus/aggregator/AggBucket';
import { aggregateKlinesByTimeframe } from './importHistoricalKlines';

function createKline(
  timestamp: number,
  overrides: Partial<Omit<AggBucket, 'timestamp' | 'type'>> = {}
): AggBucket {
  return {
    type: 'full',
    timestamp,
    open: overrides.open ?? 100,
    high: overrides.high ?? 101,
    low: overrides.low ?? 99,
    close: overrides.close ?? 100.5,
    buyCost: overrides.buyCost ?? 10,
    sellCost: overrides.sellCost ?? 9,
    buyVolume: overrides.buyVolume ?? 1,
    sellVolume: overrides.sellVolume ?? 0.5,
    liqBuyCost: overrides.liqBuyCost ?? 0,
    liqSellCost: overrides.liqSellCost ?? 0,
    liqBuyVolume: overrides.liqBuyVolume ?? 0,
    liqSellVolume: overrides.liqSellVolume ?? 0,
    tradeCount: overrides.tradeCount ?? 1,
    liqCount: overrides.liqCount ?? 0,
  };
}

describe('aggregateKlinesByTimeframe', () => {
  it('aggregates 1m klines into 5m candles using OHLC and summed volume fields', () => {
    const baseTimestamp = Date.UTC(2024, 0, 1, 0, 0, 0);
    const klines = [
      createKline(baseTimestamp, { open: 100, high: 102, low: 99, close: 101, buyCost: 10, tradeCount: 2 }),
      createKline(baseTimestamp + 60_000, { open: 101, high: 104, low: 100, close: 103, buyCost: 11, tradeCount: 3 }),
      createKline(baseTimestamp + 120_000, { open: 103, high: 105, low: 101, close: 102, buyCost: 12, tradeCount: 4 }),
      createKline(baseTimestamp + 180_000, { open: 102, high: 106, low: 98, close: 104, buyCost: 13, tradeCount: 5 }),
      createKline(baseTimestamp + 240_000, { open: 104, high: 107, low: 103, close: 106, buyCost: 14, tradeCount: 6 }),
      createKline(baseTimestamp + 300_000, { open: 106, high: 108, low: 105, close: 107, buyCost: 15, tradeCount: 7 }),
    ];

    const aggregated = aggregateKlinesByTimeframe(klines, '5m');

    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]).toMatchObject({
      timestamp: baseTimestamp,
      open: 100,
      high: 107,
      low: 98,
      close: 106,
      buyCost: 60,
      sellCost: 45,
      buyVolume: 5,
      sellVolume: 2.5,
      tradeCount: 20,
      liqCount: 0,
    });
    expect(aggregated[1]).toMatchObject({
      timestamp: baseTimestamp + 300_000,
      open: 106,
      high: 108,
      low: 105,
      close: 107,
      buyCost: 15,
      tradeCount: 7,
    });
  });

  it('rejects out-of-order historical klines', () => {
    const baseTimestamp = Date.UTC(2024, 0, 1, 0, 0, 0);

    expect(() =>
      aggregateKlinesByTimeframe(
        [
          createKline(baseTimestamp + 60_000),
          createKline(baseTimestamp),
        ],
        '15m'
      )
    ).toThrow('Historical klines must be sorted in ascending timestamp order');
  });
});
