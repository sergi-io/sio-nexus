import type { AggBucket } from './AggBucket';
import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';
import { insertKlinesToDB } from '@/utils/db/klines/insertKlinesToDB';
import { NexusConfig } from '../NexusConfig';

/**
 * Buffers closed klines per pair × timeframe and batch-inserts them into SQLite
 * on a fixed time interval.
 */
export class KlinesBuffer {
  private readonly buffers = new Map<string, AggBucket[]>();
  private totalPending = 0;
  private readonly flushTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly insertToDB: typeof insertKlinesToDB = insertKlinesToDB,
    private readonly scheduleFlush: typeof setInterval = setInterval,
    private readonly clearFlushSchedule: typeof clearInterval = clearInterval
  ) {
    const flushIntervalMs = Math.max(1, NexusConfig.secondsBufferFlushToDB) * 1000;
    this.flushTimer = this.scheduleFlush(() => {
      this.flushAll();
    }, flushIntervalMs);
  }

  add(pair: string, timeframe: SIOTimeFrame, bucket: AggBucket): void {
    const key = `${pair}:${timeframe}`;
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = [];
      this.buffers.set(key, buf);
    }

    buf.push(bucket);
    this.totalPending++;
  }

  flushAll(): void {
    if (this.totalPending === 0) {
      return;
    }

    for (const [key, buf] of this.buffers) {
      if (buf.length === 0) continue;
      const [pair, timeframe] = key.split(':') as [string, SIOTimeFrame];
      this.insertToDB(buf, pair, timeframe);
      this.buffers.set(key, []);
    }
    this.totalPending = 0;
  }

  stop(): void {
    this.clearFlushSchedule(this.flushTimer);
    this.flushAll();
  }
}
