import { describe, expect, it } from 'bun:test';
import type { AggBucket } from './AggBucket';
import { KlinesBuffer } from './KlinesBuffer';
import { NexusConfig } from '../NexusConfig';

describe('KlinesBuffer', () => {
  it('flushes buffered klines on the configured time interval', () => {
    const originalFlushSeconds = NexusConfig.secondsBufferFlushToDB;
    const insertCalls: Array<{ klines: AggBucket[]; pair: string; timeframe: string }> = [];
    let scheduledDelayMs = 0;
    let flushCallback: (() => void) | undefined;

    try {
      NexusConfig.secondsBufferFlushToDB = 7;

      const buffer = new KlinesBuffer(
        (klines, pair, timeframe) => {
          insertCalls.push({ klines: [...klines], pair, timeframe });
        },
        ((callback: Parameters<typeof setInterval>[0], delay?: number) => {
          flushCallback = callback as () => void;
          scheduledDelayMs = delay ?? 0;
          return 1 as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        (() => {}) as typeof clearInterval
      );

      const bucket: AggBucket = {
        timestamp: 1_700_000_000_000,
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        buyCost: 10,
        sellCost: 8,
        buyVolume: 1,
        sellVolume: 1,
        liqBuyCost: 0,
        liqSellCost: 0,
        liqBuyVolume: 0,
        liqSellVolume: 0,
        tradeCount: 2,
        liqCount: 0,
        type: 'full',
      };

      buffer.add('BTCUSDT', '1m', bucket);

      expect(scheduledDelayMs).toBe(7_000);
      expect(insertCalls).toHaveLength(0);
      expect(flushCallback).toBeDefined();

      if (!flushCallback) {
        throw new Error('Expected flush callback to be scheduled');
      }
      flushCallback();

      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0]).toEqual({
        klines: [bucket],
        pair: 'BTCUSDT',
        timeframe: '1m',
      });
    } finally {
      NexusConfig.secondsBufferFlushToDB = originalFlushSeconds;
    }
  });

  it('flushes pending klines when stopped', () => {
    const originalFlushSeconds = NexusConfig.secondsBufferFlushToDB;
    const insertCalls: Array<{ klines: AggBucket[]; pair: string; timeframe: string }> = [];
    let clearCalled = false;

    try {
      NexusConfig.secondsBufferFlushToDB = 60;

      const buffer = new KlinesBuffer(
        (klines, pair, timeframe) => {
          insertCalls.push({ klines: [...klines], pair, timeframe });
        },
        ((() => 1) as unknown) as typeof setInterval,
        (() => {
          clearCalled = true;
        }) as typeof clearInterval
      );

      const bucket: AggBucket = {
        timestamp: 1_700_000_000_000,
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        buyCost: 10,
        sellCost: 8,
        buyVolume: 1,
        sellVolume: 1,
        liqBuyCost: 0,
        liqSellCost: 0,
        liqBuyVolume: 0,
        liqSellVolume: 0,
        tradeCount: 2,
        liqCount: 0,
        type: 'full',
      };

      buffer.add('ETHUSDT', '5m', bucket);
      buffer.stop();

      expect(clearCalled).toBe(true);
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0]?.pair).toBe('ETHUSDT');
      expect(insertCalls[0]?.timeframe).toBe('5m');
    } finally {
      NexusConfig.secondsBufferFlushToDB = originalFlushSeconds;
    }
  });
});
