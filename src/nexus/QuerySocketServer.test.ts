import { describe, expect, it } from 'bun:test';
import { mergeKlineStreamsInRealtimeOrder } from './QuerySocketServer';

describe('mergeKlineStreamsInRealtimeOrder', () => {
  it('returns range-query klines in the same order as realtime bucket closes', () => {
    const merged = Array.from(
      mergeKlineStreamsInRealtimeOrder([
        {
          timeframe: '1m',
          rows: [
            { timestamp: 60_000, id: '1m-1' },
            { timestamp: 120_000, id: '1m-2' },
            { timestamp: 180_000, id: '1m-3' },
            { timestamp: 240_000, id: '1m-4' },
            { timestamp: 300_000, id: '1m-5' },
            { timestamp: 360_000, id: '1m-6' },
          ],
        },
        {
          timeframe: '5m',
          rows: [
            { timestamp: 300_000, id: '5m-1' },
            { timestamp: 600_000, id: '5m-2' },
          ],
        },
        {
          timeframe: '15m',
          rows: [{ timestamp: 900_000, id: '15m-1' }],
        },
      ])
    );

    expect(merged.map(({ timeframe, row }) => `${timeframe}:${row.id}`)).toEqual([
      '1m:1m-1',
      '1m:1m-2',
      '1m:1m-3',
      '1m:1m-4',
      '1m:1m-5',
      '5m:5m-1',
      '1m:1m-6',
      '5m:5m-2',
      '15m:15m-1',
    ]);
  });

  it('prefers shorter timeframes when multiple klines share the same timestamp', () => {
    const merged = Array.from(
      mergeKlineStreamsInRealtimeOrder([
        {
          timeframe: '15m',
          rows: [{ timestamp: 900_000, id: '15m' }],
        },
        {
          timeframe: '1m',
          rows: [{ timestamp: 900_000, id: '1m' }],
        },
        {
          timeframe: '5m',
          rows: [{ timestamp: 900_000, id: '5m' }],
        },
      ])
    );

    expect(merged.map(({ timeframe }) => timeframe)).toEqual(['1m', '5m', '15m']);
  });
});
