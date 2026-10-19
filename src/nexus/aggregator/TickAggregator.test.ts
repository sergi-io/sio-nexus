import { describe, expect, it } from 'bun:test';
import { SIOTimeFramesMsMap } from '@/domain/SIOTimeFrame';
import type { AggBucket } from './AggBucket';
import { AGGREGATION_TIMEFRAMES } from './AggBucket';
import { TickAggregator } from './TickAggregator';

describe('TickAggregator liquidation pricing', () => {
  it('emits full on bucket close and delta on partial updates', () => {
    const deltas: Array<{ timeframe: string; bucket: AggBucket }> = [];
    const closes: Array<{ timeframe: string; bucket: AggBucket }> = [];
    const originalNow = Date.now;
    const timeframe = AGGREGATION_TIMEFRAMES[0]!;
    const timeframeMs = SIOTimeFramesMsMap[timeframe];
    const baseNow = 1_700_000_000_000;
    const nextBucketNow = baseNow - (baseNow % timeframeMs) + timeframeMs;

    try {
      Date.now = () => baseNow; // fixed bucket base
      const aggregator = new TickAggregator(
        {
          BTCUSDT: [
            {
              exchangeId: 'binance',
              pairs: ['BTC/USDT:USDT'],
              watchLiquidations: true,
              mainPriceTracker: true,
            },
          ],
        },
        (pair, timeframe, bucket) => {
          if (pair !== 'BTCUSDT') return;
          closes.push({ timeframe, bucket: { ...bucket } });
        },
        (pair, timeframe, bucket) => {
          if (pair !== 'BTCUSDT') return;
          deltas.push({ timeframe, bucket: { ...bucket } });
        }
      );

      aggregator.processTrade({
        type: 'trade',
        exchangeId: 'binance',
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        price: 100,
        amount: 1,
        cost: 100,
      });

      const firstDelta = deltas.find((d) => d.timeframe === timeframe);
      expect(firstDelta).toBeDefined();
      expect(firstDelta?.bucket.type).toBe('delta');

      Date.now = () => nextBucketNow; // move into next configured bucket
      aggregator.processTrade({
        type: 'trade',
        exchangeId: 'binance',
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        price: 101,
        amount: 1,
        cost: 101,
      });

      const closedBucket = closes.find((c) => c.timeframe === timeframe);
      expect(closedBucket).toBeDefined();
      expect(closedBucket?.bucket.type).toBe('full');

      const lastDelta = deltas.filter((d) => d.timeframe === timeframe).at(-1);
      expect(lastDelta).toBeDefined();
      expect(lastDelta?.bucket.type).toBe('delta');
    } finally {
      Date.now = originalNow;
    }
  });

  it('sets OHLC from liquidation prices when a bucket has no trades', () => {
    const deltas: Array<{ timeframe: string; bucket: AggBucket }> = [];
    const aggregator = new TickAggregator(
      {
        BTCUSDT: [
          {
            exchangeId: 'binance',
            pairs: ['BTC/USDT:USDT'],
            watchLiquidations: true,
            mainPriceTracker: true,
          },
        ],
      },
      undefined,
      (pair, timeframe, bucket) => {
        if (pair !== 'BTCUSDT') return;
        deltas.push({ timeframe, bucket: { ...bucket } });
      }
    );

    const liqMsg = {
      type: 'liquidation' as const,
      exchangeId: 'binance',
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      price: 100,
      amount: 2,
      cost: 200,
    };

    aggregator.processLiquidation(liqMsg);

    const oneMinute = deltas.find((d) => d.timeframe === '1m');
    expect(oneMinute).toBeDefined();
    expect(oneMinute?.bucket.open).toBe(100);
    expect(oneMinute?.bucket.high).toBe(100);
    expect(oneMinute?.bucket.low).toBe(100);
    expect(oneMinute?.bucket.close).toBe(100);
    expect(oneMinute?.bucket.tradeCount).toBe(0);
    expect(oneMinute?.bucket.liqCount).toBe(1);
  });

  it('does not let liquidation overwrite OHLC once trades exist in the bucket', () => {
    const deltas: Array<{ timeframe: string; bucket: AggBucket }> = [];
    const aggregator = new TickAggregator(
      {
        BTCUSDT: [
          {
            exchangeId: 'binance',
            pairs: ['BTC/USDT:USDT'],
            watchLiquidations: true,
            mainPriceTracker: true,
          },
        ],
      },
      undefined,
      (pair, timeframe, bucket) => {
        if (pair !== 'BTCUSDT') return;
        deltas.push({ timeframe, bucket: { ...bucket } });
      }
    );

    aggregator.processTrade({
      type: 'trade',
      exchangeId: 'binance',
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      price: 150,
      amount: 1,
      cost: 150,
    });

    aggregator.processLiquidation({
      type: 'liquidation',
      exchangeId: 'binance',
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      price: 90,
      amount: 3,
      cost: 270,
    });

    const oneMinute = deltas.filter((d) => d.timeframe === '1m').at(-1);
    expect(oneMinute).toBeDefined();
    expect(oneMinute?.bucket.open).toBe(150);
    expect(oneMinute?.bucket.high).toBe(150);
    expect(oneMinute?.bucket.low).toBe(150);
    expect(oneMinute?.bucket.close).toBe(150);
    expect(oneMinute?.bucket.tradeCount).toBe(1);
    expect(oneMinute?.bucket.liqCount).toBe(1);
  });

  it('does not use non-main exchange price for OHLC updates', () => {
    const deltas: Array<{ timeframe: string; bucket: AggBucket }> = [];
    const aggregator = new TickAggregator(
      {
        BTCUSDT: [
          {
            exchangeId: 'coinbase',
            pairs: ['BTC/USD'],
            watchLiquidations: true,
          },
          {
            exchangeId: 'binance',
            pairs: ['BTC/USDT:USDT'],
            watchLiquidations: true,
            mainPriceTracker: true,
          },
        ],
      },
      undefined,
      (pair, timeframe, bucket) => {
        if (pair !== 'BTCUSDT') return;
        deltas.push({ timeframe, bucket: { ...bucket } });
      }
    );

    aggregator.processTrade({
      type: 'trade',
      exchangeId: 'coinbase',
      symbol: 'BTC/USD',
      side: 'buy',
      price: 120,
      amount: 1,
      cost: 120,
    });

    let oneMinute = deltas.filter((d) => d.timeframe === '1m').at(-1);
    expect(oneMinute).toBeUndefined();

    aggregator.processTrade({
      type: 'trade',
      exchangeId: 'binance',
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      price: 150,
      amount: 1,
      cost: 150,
    });

    oneMinute = deltas.filter((d) => d.timeframe === '1m').at(-1);
    expect(oneMinute).toBeDefined();
    expect(oneMinute?.bucket.open).toBe(150);
    expect(oneMinute?.bucket.high).toBe(150);
    expect(oneMinute?.bucket.low).toBe(150);
    expect(oneMinute?.bucket.close).toBe(150);
    expect(oneMinute?.bucket.tradeCount).toBeGreaterThanOrEqual(1);
  });
});
