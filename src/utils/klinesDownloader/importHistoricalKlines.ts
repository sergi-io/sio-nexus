import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';
import { SIOTimeFramesMsMap } from '@/domain/SIOTimeFrame';
import type { AggBucket } from '@/nexus/aggregator/AggBucket';
import { AGGREGATION_TIMEFRAMES } from '@/nexus/aggregator/AggBucket';
import { closeKlinesDB } from '@/utils/db/klines/klinesDB';
import { insertKlinesToDB } from '@/utils/db/klines/insertKlinesToDB';

const NORMALIZED_HEADER = [
  'timestamp',
  'open',
  'high',
  'low',
  'close',
  'buyCost',
  'sellCost',
  'buyVolume',
  'sellVolume',
  'liqBuyCost',
  'liqSellCost',
  'liqBuyVolume',
  'liqSellVolume',
  'tradeCount',
  'liqCount',
] as const;

const BASE_TIMEFRAME = '1m' as const;
const IMPORT_BATCH_SIZE = 5_000;
const UPPER_TIMEFRAMES = AGGREGATION_TIMEFRAMES.filter(
  (timeframe): timeframe is Exclude<(typeof AGGREGATION_TIMEFRAMES)[number], typeof BASE_TIMEFRAME> =>
    timeframe !== BASE_TIMEFRAME
);

type HistoricalImportTimeframe = (typeof AGGREGATION_TIMEFRAMES)[number];

function getField(columns: string[], index: number, lineNumber: number, label: string): string {
  const value = columns[index];
  if (value === undefined) {
    throw new Error(`Missing ${label} on line ${lineNumber}`);
  }
  return value;
}

function parseNumberField(value: string, lineNumber: number, label: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label} on line ${lineNumber}: ${value}`);
  }
  return parsed;
}

function parseIntegerField(value: string, lineNumber: number, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label} on line ${lineNumber}: ${value}`);
  }
  return parsed;
}

function matchesHeader(columns: string[]): boolean {
  return (
    columns.length === NORMALIZED_HEADER.length &&
    columns.every((value, index) => value === NORMALIZED_HEADER[index])
  );
}

function parseNormalizedCsvLine(line: string, lineNumber: number): AggBucket {
  const columns = line.split(',');
  if (columns.length !== NORMALIZED_HEADER.length) {
    throw new Error(
      `Invalid historical CSV row on line ${lineNumber}. Expected ${NORMALIZED_HEADER.length} columns, got ${columns.length}.`
    );
  }

  return {
    type: 'full',
    timestamp: parseIntegerField(getField(columns, 0, lineNumber, 'timestamp'), lineNumber, 'timestamp'),
    open: parseNumberField(getField(columns, 1, lineNumber, 'open'), lineNumber, 'open'),
    high: parseNumberField(getField(columns, 2, lineNumber, 'high'), lineNumber, 'high'),
    low: parseNumberField(getField(columns, 3, lineNumber, 'low'), lineNumber, 'low'),
    close: parseNumberField(getField(columns, 4, lineNumber, 'close'), lineNumber, 'close'),
    buyCost: parseNumberField(getField(columns, 5, lineNumber, 'buyCost'), lineNumber, 'buyCost'),
    sellCost: parseNumberField(getField(columns, 6, lineNumber, 'sellCost'), lineNumber, 'sellCost'),
    buyVolume: parseNumberField(getField(columns, 7, lineNumber, 'buyVolume'), lineNumber, 'buyVolume'),
    sellVolume: parseNumberField(getField(columns, 8, lineNumber, 'sellVolume'), lineNumber, 'sellVolume'),
    liqBuyCost: parseNumberField(
      getField(columns, 9, lineNumber, 'liqBuyCost'),
      lineNumber,
      'liqBuyCost'
    ),
    liqSellCost: parseNumberField(
      getField(columns, 10, lineNumber, 'liqSellCost'),
      lineNumber,
      'liqSellCost'
    ),
    liqBuyVolume: parseNumberField(
      getField(columns, 11, lineNumber, 'liqBuyVolume'),
      lineNumber,
      'liqBuyVolume'
    ),
    liqSellVolume: parseNumberField(
      getField(columns, 12, lineNumber, 'liqSellVolume'),
      lineNumber,
      'liqSellVolume'
    ),
    tradeCount: parseIntegerField(
      getField(columns, 13, lineNumber, 'tradeCount'),
      lineNumber,
      'tradeCount'
    ),
    liqCount: parseIntegerField(getField(columns, 14, lineNumber, 'liqCount'), lineNumber, 'liqCount'),
  };
}

function alignTimestamp(timestamp: number, timeframe: SIOTimeFrame): number {
  const timeframeMs = SIOTimeFramesMsMap[timeframe];
  return timestamp - (timestamp % timeframeMs);
}

function createAggregatedBucket(source: AggBucket, timeframe: HistoricalImportTimeframe): AggBucket {
  return {
    ...source,
    type: 'full',
    timestamp: alignTimestamp(source.timestamp, timeframe),
  };
}

function mergeBucket(target: AggBucket, source: AggBucket): void {
  target.high = Math.max(target.high, source.high);
  target.low = Math.min(target.low, source.low);
  target.close = source.close;
  target.buyCost += source.buyCost;
  target.sellCost += source.sellCost;
  target.buyVolume += source.buyVolume;
  target.sellVolume += source.sellVolume;
  target.liqBuyCost += source.liqBuyCost;
  target.liqSellCost += source.liqSellCost;
  target.liqBuyVolume += source.liqBuyVolume;
  target.liqSellVolume += source.liqSellVolume;
  target.tradeCount += source.tradeCount;
  target.liqCount += source.liqCount;
}

function flushBuffer(
  pair: string,
  timeframe: HistoricalImportTimeframe,
  buffers: Map<HistoricalImportTimeframe, AggBucket[]>,
  insertedCounts: Map<HistoricalImportTimeframe, number>
): void {
  const buffer = buffers.get(timeframe);
  if (!buffer || buffer.length === 0) {
    return;
  }

  insertKlinesToDB(buffer, pair, timeframe);
  insertedCounts.set(timeframe, (insertedCounts.get(timeframe) ?? 0) + buffer.length);
  buffers.set(timeframe, []);
}

function queueBuffer(
  pair: string,
  timeframe: HistoricalImportTimeframe,
  bucket: AggBucket,
  buffers: Map<HistoricalImportTimeframe, AggBucket[]>,
  insertedCounts: Map<HistoricalImportTimeframe, number>
): void {
  const buffer = buffers.get(timeframe);
  if (!buffer) {
    throw new Error(`Missing import buffer for timeframe ${timeframe}`);
  }

  buffer.push(bucket);
  if (buffer.length >= IMPORT_BATCH_SIZE) {
    flushBuffer(pair, timeframe, buffers, insertedCounts);
  }
}

export function aggregateKlinesByTimeframe(
  klines: AggBucket[],
  timeframe: HistoricalImportTimeframe
): AggBucket[] {
  if (timeframe === BASE_TIMEFRAME) {
    return klines.map((kline) => ({ ...kline, type: 'full' }));
  }

  const aggregated: AggBucket[] = [];
  let current: AggBucket | null = null;
  let lastTimestamp = -Infinity;

  for (const kline of klines) {
    if (kline.timestamp < lastTimestamp) {
      throw new Error(`Historical klines must be sorted in ascending timestamp order`);
    }
    lastTimestamp = kline.timestamp;

    const alignedTimestamp = alignTimestamp(kline.timestamp, timeframe);
    if (!current || current.timestamp !== alignedTimestamp) {
      if (current) {
        aggregated.push(current);
      }
      current = createAggregatedBucket(kline, timeframe);
      continue;
    }

    mergeBucket(current, kline);
  }

  if (current) {
    aggregated.push(current);
  }

  return aggregated;
}

export async function importHistoricalKlines(pair: string, csvPath: string): Promise<void> {
  if (!pair) {
    throw new Error('Missing required pair argument');
  }
  if (!csvPath) {
    throw new Error('Missing required csv path argument');
  }

  const resolvedCsvPath = path.resolve(process.cwd(), csvPath);
  if (!existsSync(resolvedCsvPath)) {
    throw new Error(`Historical CSV file not found: ${resolvedCsvPath}`);
  }

  const buffers = new Map<HistoricalImportTimeframe, AggBucket[]>(
    AGGREGATION_TIMEFRAMES.map((timeframe) => [timeframe, []])
  );
  const insertedCounts = new Map<HistoricalImportTimeframe, number>(
    AGGREGATION_TIMEFRAMES.map((timeframe) => [timeframe, 0])
  );
  const activeUpperBuckets = new Map<Exclude<HistoricalImportTimeframe, typeof BASE_TIMEFRAME>, AggBucket | null>(
    UPPER_TIMEFRAMES.map((timeframe) => [timeframe, null])
  );

  let importedRows = 0;
  let lastTimestamp = -Infinity;
  let lineNumber = 0;

  try {
    const rl = createInterface({
      input: createReadStream(resolvedCsvPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const rawLine of rl) {
      lineNumber++;
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const columns = line.split(',');
      if (matchesHeader(columns)) {
        continue;
      }

      const kline = parseNormalizedCsvLine(line, lineNumber);
      if (kline.timestamp < lastTimestamp) {
        throw new Error(
          `Historical CSV must be ordered by ascending timestamp. Line ${lineNumber} is out of order.`
        );
      }
      lastTimestamp = kline.timestamp;

      queueBuffer(pair, BASE_TIMEFRAME, kline, buffers, insertedCounts);

      for (const timeframe of UPPER_TIMEFRAMES) {
        const alignedTimestamp = alignTimestamp(kline.timestamp, timeframe);
        const current = activeUpperBuckets.get(timeframe);

        if (!current || current.timestamp !== alignedTimestamp) {
          if (current) {
            queueBuffer(pair, timeframe, current, buffers, insertedCounts);
          }
          activeUpperBuckets.set(timeframe, createAggregatedBucket(kline, timeframe));
          continue;
        }

        mergeBucket(current, kline);
      }

      importedRows++;
    }

    for (const timeframe of UPPER_TIMEFRAMES) {
      const current = activeUpperBuckets.get(timeframe);
      if (current) {
        queueBuffer(pair, timeframe, current, buffers, insertedCounts);
      }
    }

    for (const timeframe of AGGREGATION_TIMEFRAMES) {
      flushBuffer(pair, timeframe, buffers, insertedCounts);
    }
  } finally {
    closeKlinesDB();
  }

  if (importedRows === 0) {
    console.warn(`No historical klines found in ${resolvedCsvPath}`);
    return;
  }

  const importedSummary = AGGREGATION_TIMEFRAMES.map((timeframe) => {
    return `${timeframe}:${insertedCounts.get(timeframe) ?? 0}`;
  }).join(', ');

  console.log(`Imported historical klines for ${pair} from ${resolvedCsvPath}`);
  console.log(`Inserted candles by timeframe -> ${importedSummary}`);
}
