import { existsSync, unlinkSync } from 'fs';
import type { Database } from 'bun:sqlite';
import { type Socket } from 'bun';
import { config } from '@/config';
import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';
import { SIOTimeFramesMsMap } from '@/domain/SIOTimeFrame';
import { getKlinesDB, getKlinesTableName } from '@/utils/db/klines/klinesDB';
import { getDB } from '@/utils/db/getDB';
import { validateTableName } from '@/utils/db/validateTableName';
import { NexusConfig } from './NexusConfig';
import { registerGracefulShutdown } from '@/utils/gracefulShutdown';

interface BaseQueryRequest {
  pair: string;
  timeframes: SIOTimeFrame[];
}

interface RangeQueryRequest extends BaseQueryRequest {
  queryType: 'range';
  startDate: number;
  endDate: number;
  limit?: number;
}

interface LastQueryRequest extends BaseQueryRequest {
  queryType: 'last';
  limit: number;
}

interface InfoQueryRequest {
  queryType: 'info';
}

type QueryRequest = RangeQueryRequest | LastQueryRequest | InfoQueryRequest;

const VALID_TIMEFRAMES = new Set<string>(Object.keys(SIOTimeFramesMsMap));
const VALID_TIMEFRAMES_DESC = Object.keys(SIOTimeFramesMsMap).sort((a, b) => b.length - a.length);

interface InfoRange {
  tableName: string;
  pair: string;
  timeframe: SIOTimeFrame;
  range: {
    startDate: number | null;
    endDate: number | null;
  };
  count: number;
  noGapRanges: Array<{
    startDate: number;
    endDate: number;
    count: number;
  }>;
}

type TimestampedKlineRow = {
  timestamp: number;
} & Record<string, unknown>;

type KlineStream<T extends TimestampedKlineRow> = {
  timeframe: SIOTimeFrame;
  rows: Iterable<T>;
};

type KlineStreamState<T extends TimestampedKlineRow> = {
  timeframe: SIOTimeFrame;
  iterator: Iterator<T>;
  current: T;
};

function compareRealtimeKlineOrder(
  a: { timeframe: SIOTimeFrame; timestamp: number },
  b: { timeframe: SIOTimeFrame; timestamp: number }
): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }

  return SIOTimeFramesMsMap[a.timeframe] - SIOTimeFramesMsMap[b.timeframe];
}

export function* mergeKlineStreamsInRealtimeOrder<T extends TimestampedKlineRow>(
  streams: KlineStream<T>[]
): Generator<{ timeframe: SIOTimeFrame; row: T }> {
  const states: KlineStreamState<T>[] = [];

  for (const stream of streams) {
    const iterator = stream.rows[Symbol.iterator]();
    const first = iterator.next();
    if (!first.done) {
      states.push({
        timeframe: stream.timeframe,
        iterator,
        current: first.value,
      });
    }
  }

  while (states.length > 0) {
    let nextIndex = 0;

    for (let i = 1; i < states.length; i++) {
      const candidate = states[i];
      const currentBest = states[nextIndex];

      if (!candidate || !currentBest) {
        continue;
      }

      if (
        compareRealtimeKlineOrder(
          { timeframe: candidate.timeframe, timestamp: candidate.current.timestamp },
          { timeframe: currentBest.timeframe, timestamp: currentBest.current.timestamp }
        ) < 0
      ) {
        nextIndex = i;
      }
    }

    const nextState = states[nextIndex];
    if (!nextState) {
      break;
    }

    yield { timeframe: nextState.timeframe, row: nextState.current };

    const nextRow = nextState.iterator.next();
    if (nextRow.done) {
      states.splice(nextIndex, 1);
      continue;
    }

    nextState.current = nextRow.value;
  }
}

export class QuerySocketServer {
  private server: ReturnType<typeof Bun.listen> | null = null;
  private readonly clientBuffers = new Map<Socket<undefined>, string>();
  private readonly writeQueues = new Map<Socket<undefined>, string>();
  private unregisterShutdown: (() => void) | null = null;
  private infoLogSink: ((message: string) => void) | null = null;

  public setInfoLogSink(sink: ((message: string) => void) | null): void {
    this.infoLogSink = sink;
  }

  start(): void {
    const socketPath = config.socket.querySocketPath;

    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    this.server = Bun.listen<undefined>({
      unix: socketPath,
      socket: {
        open: (socket) => {
          this.clientBuffers.set(socket, '');
        },
        close: (socket) => {
          this.clientBuffers.delete(socket);
          this.writeQueues.delete(socket);
        },
        data: (socket, data) => {
          this.handleData(socket, data);
        },
        drain: (socket) => {
          this.flushWriteQueue(socket);
        },
        error: (socket) => {
          this.clientBuffers.delete(socket);
          this.writeQueues.delete(socket);
        },
      },
    });

    this.unregisterShutdown = registerGracefulShutdown(() => this.close());

    console.log(`[QuerySocket] Listening on ${socketPath}`);
  }

  private handleData(socket: Socket<undefined>, data: Buffer): void {
    const buffer = (this.clientBuffers.get(socket) ?? '') + data.toString();
    const lines = buffer.split('\n');

    // Last element may be an incomplete line — keep it in the buffer
    this.clientBuffers.set(socket, lines.at(-1) ?? '');

    for (let i = 0; i < lines.length - 1; i++) {
      const line = (lines[i] ?? '').trim();
      if (line) {
        this.processQuery(socket, line);
      }
    }
  }

  private processQuery(socket: Socket<undefined>, line: string): void {
    let req: QueryRequest;

    try {
      req = JSON.parse(line) as QueryRequest;
    } catch {
      this.send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (req.queryType === 'info') {
      this.processInfoQuery(socket);
      return;
    }

    if (!('pair' in req) || !req.pair) {
      this.send(socket, { type: 'error', message: 'Missing required field: pair' });
      return;
    }

    if (!('timeframes' in req) || !req.timeframes) {
      this.send(socket, { type: 'error', message: 'Missing required field: timeframes' });
      return;
    }

    if (!Array.isArray(req.timeframes) || req.timeframes.length === 0) {
      this.send(socket, { type: 'error', message: 'timeframes must be a non-empty array' });
      return;
    }

    for (const tf of req.timeframes) {
      if (!VALID_TIMEFRAMES.has(tf)) {
        this.send(socket, { type: 'error', message: `Invalid timeframe: ${tf}` });
        return;
      }
    }

    if (req.queryType === 'last') {
      this.processLastQuery(socket, req);
    } else {
      this.processRangeQuery(socket, req);
    }
  }

  private processInfoQuery(socket: Socket<undefined>): void {
    const db = getDB(NexusConfig.sqliteKlinesDBPath);

    try {
      const tableRows = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'klines_%' ORDER BY name ASC"
        )
        .all() as Array<{ name: string }>;

      const ranges: InfoRange[] = [];
      const timeframes = new Set<SIOTimeFrame>();

      for (const row of tableRows) {
        const tableName = validateTableName(row.name, 'klines table name');
        const parsed = this.parseKlinesTableName(tableName);
        if (!parsed) {
          continue;
        }

        const stats = db
          .query(
            `SELECT MIN(timestamp) AS startDate, MAX(timestamp) AS endDate, COUNT(*) AS count FROM ${tableName}`
          )
          .get() as { startDate: number | null; endDate: number | null; count: number } | null;

        ranges.push({
          tableName,
          pair: parsed.pair,
          timeframe: parsed.timeframe,
          range: {
            startDate: stats?.startDate ?? null,
            endDate: stats?.endDate ?? null,
          },
          count: stats?.count ?? 0,
          noGapRanges: this.collectNoGapRanges(db, tableName, SIOTimeFramesMsMap[parsed.timeframe]),
        });
        timeframes.add(parsed.timeframe);
      }

      const timeframeList = Array.from(timeframes)
        .sort((a, b) => SIOTimeFramesMsMap[a] - SIOTimeFramesMsMap[b])
        .map((timeframe) => ({
          timeframe,
          label: this.formatTimeframeLabel(timeframe),
          milliseconds: SIOTimeFramesMsMap[timeframe],
        }));

      this.send(socket, {
        type: 'info',
        info: {
          ranges,
          timeframes: timeframeList,
        },
      });
    } catch (err) {
      this.send(socket, {
        type: 'error',
        message: `Database error for info query: ${String(err)}`,
      });
    } finally {
      db.close();
    }
  }

  private parseKlinesTableName(
    tableName: string
  ): { pair: string; timeframe: SIOTimeFrame } | null {
    if (!tableName.startsWith('klines_')) {
      return null;
    }

    const suffix = tableName.slice('klines_'.length);

    for (const tf of VALID_TIMEFRAMES_DESC) {
      if (!suffix.endsWith(`_${tf}`)) {
        continue;
      }

      const pair = suffix.slice(0, -(tf.length + 1));
      if (!pair) {
        return null;
      }

      return { pair, timeframe: tf as SIOTimeFrame };
    }

    return null;
  }

  private formatTimeframeLabel(timeframe: SIOTimeFrame): string {
    const match = /^(\d+)([smhdwM])$/.exec(timeframe);
    if (!match) {
      return timeframe;
    }

    const amount = Number(match[1]);
    const unit = match[2];
    if (!unit) {
      return timeframe;
    }
    const unitNameByCode: Record<string, string> = {
      s: 'second',
      m: 'minute',
      h: 'hour',
      d: 'day',
      w: 'week',
      M: 'month',
    };
    const unitName = unitNameByCode[unit] ?? unit;
    const plural = amount === 1 ? '' : 's';
    return `${amount} ${unitName}${plural}`;
  }

  private collectNoGapRanges(
    db: Database,
    tableName: string,
    timeframeMs: number
  ): Array<{ startDate: number; endDate: number; count: number }> {
    const stmt = db.prepare(`SELECT timestamp FROM ${tableName} ORDER BY timestamp ASC`);
    const ranges: Array<{ startDate: number; endDate: number; count: number }> = [];
    const maxAllowedDeltaMs = this.getMaxAllowedDeltaMs(timeframeMs);

    let currentStart: number | null = null;
    let previousTimestamp: number | null = null;
    let currentCount = 0;

    for (const row of stmt.iterate() as Iterable<{ timestamp: number }>) {
      const timestamp = row.timestamp;

      if (currentStart === null || previousTimestamp === null) {
        currentStart = timestamp;
        previousTimestamp = timestamp;
        currentCount = 1;
        continue;
      }

      if (timestamp - previousTimestamp <= maxAllowedDeltaMs) {
        previousTimestamp = timestamp;
        currentCount++;
        continue;
      }

      ranges.push({ startDate: currentStart, endDate: previousTimestamp, count: currentCount });
      currentStart = timestamp;
      previousTimestamp = timestamp;
      currentCount = 1;
    }

    if (currentStart !== null && previousTimestamp !== null) {
      ranges.push({ startDate: currentStart, endDate: previousTimestamp, count: currentCount });
    }

    return ranges;
  }

  private getMaxAllowedDeltaMs(timeframeMs: number): number {
    // 1s data can arrive with occasional minor timing drift. Allow a 10s step to avoid
    // creating many tiny ranges for negligible gaps.
    if (timeframeMs === 1000) {
      return 10000;
    }

    return timeframeMs;
  }

  private processRangeQuery(socket: Socket<undefined>, req: RangeQueryRequest): void {
    if (typeof req.startDate !== 'number') {
      this.send(socket, {
        type: 'error',
        message: 'Missing required field: startDate (number ms)',
      });
      return;
    }

    if (typeof req.endDate !== 'number') {
      this.send(socket, { type: 'error', message: 'Missing required field: endDate (number ms)' });
      return;
    }

    if (req.endDate < req.startDate) {
      this.send(socket, { type: 'error', message: 'endDate must be >= startDate' });
      return;
    }

    if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit <= 0)) {
      this.send(socket, { type: 'error', message: 'limit must be a positive integer' });
      return;
    }

    let totalCount = 0;
    const streams: KlineStream<TimestampedKlineRow>[] = [];

    for (const tf of req.timeframes) {
      try {
        const db = getKlinesDB(req.pair, tf);
        const tableName = getKlinesTableName(req.pair, tf);
        const sql =
          req.limit !== undefined
            ? `SELECT * FROM ${tableName} WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT ?`
            : `SELECT * FROM ${tableName} WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`;
        const stmt = db.prepare(sql);
        const args =
          req.limit !== undefined
            ? [req.startDate, req.endDate, req.limit]
            : [req.startDate, req.endDate];

        streams.push({
          timeframe: tf,
          rows: stmt.iterate(...args) as Iterable<TimestampedKlineRow>,
        });
      } catch (err) {
        this.send(socket, { type: 'error', message: `Database error for ${tf}: ${String(err)}` });
        return;
      }
    }

    for (const { timeframe, row } of mergeKlineStreamsInRealtimeOrder(streams)) {
      this.send(socket, {
        type: 'kline',
        kline: { type: 'full', pair: req.pair, timeframe, ...(row as object) },
      });
      totalCount++;
    }

    this.infoLogSink?.(
      `[QuerySocket] Finished range query for ${req.pair} (${totalCount} klines)`
    );

    this.send(socket, { type: 'end', count: totalCount });
  }

  private processLastQuery(socket: Socket<undefined>, req: LastQueryRequest): void {
    if (!Number.isInteger(req.limit) || req.limit <= 0) {
      this.send(socket, { type: 'error', message: 'limit must be a positive integer' });
      return;
    }

    let totalCount = 0;

    for (const tf of req.timeframes) {
      try {
        const db = getKlinesDB(req.pair, tf);
        const tableName = getKlinesTableName(req.pair, tf);
        const sql = `SELECT * FROM (SELECT * FROM ${tableName} ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`;
        const stmt = db.prepare(sql);

        for (const row of stmt.iterate(req.limit)) {
          this.send(socket, {
            type: 'kline',
            kline: { type: 'full', pair: req.pair, timeframe: tf, ...(row as object) },
          });
          totalCount++;
        }
      } catch (err) {
        this.send(socket, { type: 'error', message: `Database error for ${tf}: ${String(err)}` });
        return;
      }
    }

    this.send(socket, { type: 'end', count: totalCount });
  }

  private send(socket: Socket<undefined>, data: object): void {
    try {
      const line = JSON.stringify(data) + '\n';
      const queued = this.writeQueues.get(socket);

      // If there's already queued data, append to maintain order
      if (queued !== undefined) {
        this.writeQueues.set(socket, queued + line);
        return;
      }

      const written = socket.write(line);
      if (written < line.length) {
        // Buffer was full — queue the unwritten remainder
        this.writeQueues.set(socket, line.slice(written));
      }
    } catch {
      this.clientBuffers.delete(socket);
      this.writeQueues.delete(socket);
    }
  }

  private flushWriteQueue(socket: Socket<undefined>): void {
    const queued = this.writeQueues.get(socket);
    if (!queued) return;

    const written = socket.write(queued);
    if (written >= queued.length) {
      this.writeQueues.delete(socket);
    } else {
      this.writeQueues.set(socket, queued.slice(written));
    }
  }

  close(): void {
    this.unregisterShutdown?.();
    this.server?.stop(true);
    const socketPath = config.socket.querySocketPath;
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  }
}
