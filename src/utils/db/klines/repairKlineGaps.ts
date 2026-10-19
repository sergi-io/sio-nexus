import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'csv-parse/sync';

import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';
import { SIOTimeFramesMsMap } from '@/domain/SIOTimeFrame';
import type { AggBucket } from '@/nexus/aggregator/AggBucket';
import { NexusConfig } from '@/nexus/NexusConfig';
import { closeKlinesDB, getKlinesTableName } from '@/utils/db/klines/klinesDB';
import { insertKlinesToDB } from '@/utils/db/klines/insertKlinesToDB';
import { downloadBinanceDataFile } from '@/utils/klinesDownloader/downloadHistoricalBinanceData/downloadHistoricalBinanceDataCommand';
import { normalizeHistoricalCsv } from '@/utils/klinesDownloader/normalizeHistoricalData';

import type { KlineTableGapAnalysis } from './klineGapAnalysis';
import { analyzeKlineGaps } from './klineGapAnalysis';

type RepairArgs = {
  dbPath: string;
  outputDir: string;
  product: 'usd-m' | 'coin-m' | 'spot';
  pair?: string;
  timeframe?: SIOTimeFrame;
  dryRun: boolean;
  json: boolean;
  keepDownloads: boolean;
};

type RepairJob = {
  pair: string;
  timeframe: SIOTimeFrame;
  timestamp: number;
  sourceMinuteTimestamps: number[];
};

type DayDownload = {
  pair: string;
  day: string;
  csvPath: string | null;
  status: 'cached' | 'downloaded' | 'no-data' | 'failed';
  error?: string;
};

type RepairResult = {
  dbPath: string;
  dryRun: boolean;
  jobsFound: number;
  inserted: number;
  skippedExisting: number;
  skippedUnsupported: number;
  downloadedMinutes: number;
  databaseMinutes: number;
  syntheticMinutes: number;
  downloads: DayDownload[];
  insertedByTable: Record<string, number>;
};

const BASE_TIMEFRAME = '1m' as const;
const BASE_TIMEFRAME_MS = SIOTimeFramesMsMap[BASE_TIMEFRAME];
const REPAIRABLE_TIMEFRAMES = new Set<SIOTimeFrame>(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
const NORMALIZED_HEADER_LENGTH = 15;

function parseArgs(): RepairArgs {
  const args = Bun.argv.slice(2);
  const getValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  const timeframe = getValue('--timeframe') as SIOTimeFrame | undefined;
  if (timeframe && !(timeframe in SIOTimeFramesMsMap)) {
    throw new Error(`Invalid --timeframe: ${timeframe}`);
  }

  const product = (getValue('--product') ?? 'usd-m') as RepairArgs['product'];
  if (!['usd-m', 'coin-m', 'spot'].includes(product)) {
    throw new Error(`Invalid --product: ${product}`);
  }

  return {
    dbPath: path.resolve(getValue('--db') ?? './data/klines.db'),
    outputDir: path.resolve(getValue('--output-dir') ?? './data/historical/gap-repair'),
    product,
    pair: getValue('--pair')?.toUpperCase(),
    timeframe,
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    keepDownloads: args.includes('--keep-downloads'),
  };
}

function makeBinanceDailyUrl(product: RepairArgs['product'], pair: string, day: string): string {
  const productPath = product === 'usd-m' ? 'futures/um' : product === 'coin-m' ? 'futures/cm' : 'spot';
  return [
    'https://data.binance.vision/data',
    productPath,
    'daily',
    'klines',
    pair,
    BASE_TIMEFRAME,
    `${pair}-${BASE_TIMEFRAME}-${day}.zip`,
  ].join('/');
}

function dateToBinanceDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function getCsvPath(outputDir: string, pair: string, day: string): string {
  return path.join(outputDir, `${pair}-${BASE_TIMEFRAME}-${day}.csv`);
}

function getZipPath(outputDir: string, pair: string, day: string): string {
  return path.join(outputDir, `${pair}-${BASE_TIMEFRAME}-${day}.zip`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function unzip(zipPath: string, outputDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', outputDir], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`unzip exited with code ${code}`));
    });
  });
}

async function ensureDailyCsv(args: RepairArgs, pair: string, day: string): Promise<DayDownload> {
  await mkdir(args.outputDir, { recursive: true });

  const csvPath = getCsvPath(args.outputDir, pair, day);
  if (await exists(csvPath)) {
    return { pair, day, csvPath, status: 'cached' };
  }

  const zipPath = getZipPath(args.outputDir, pair, day);
  if (!(await exists(zipPath))) {
    const result = await downloadBinanceDataFile(makeBinanceDailyUrl(args.product, pair, day), args.outputDir);
    if (result.status === 'noData') {
      return { pair, day, csvPath: null, status: 'no-data', error: result.error };
    }
    if (result.status === 'fail') {
      return { pair, day, csvPath: null, status: 'failed', error: result.error };
    }
  }

  await unzip(zipPath, args.outputDir);
  if (!args.keepDownloads) {
    await rm(zipPath, { force: true });
  }

  return { pair, day, csvPath, status: 'downloaded' };
}

function collectRepairJobs(analysis: KlineTableGapAnalysis[], args: RepairArgs): RepairJob[] {
  const jobs: RepairJob[] = [];

  for (const table of analysis) {
    if (args.pair && table.table.pair.toUpperCase() !== args.pair) {
      continue;
    }
    if (args.timeframe && table.table.timeframe !== args.timeframe) {
      continue;
    }
    if (!REPAIRABLE_TIMEFRAMES.has(table.table.timeframe)) {
      continue;
    }

    for (const gap of table.gaps) {
      for (const timestamp of gap.missingTimestamps) {
        jobs.push({
          pair: table.table.pair,
          timeframe: table.table.timeframe,
          timestamp,
          sourceMinuteTimestamps: collectSourceMinuteTimestamps(timestamp, table.table.timeframe),
        });
      }
    }
  }

  return jobs;
}

function collectSourceMinuteTimestamps(timestamp: number, timeframe: SIOTimeFrame): number[] {
  const timeframeMs = SIOTimeFramesMsMap[timeframe];
  const timestamps: number[] = [];
  for (let minuteTs = timestamp; minuteTs < timestamp + timeframeMs; minuteTs += BASE_TIMEFRAME_MS) {
    timestamps.push(minuteTs);
  }
  return timestamps;
}

async function loadNeededDownloadedMinutes(
  downloads: DayDownload[],
  neededMinutes: Map<string, Set<number>>
): Promise<Map<string, AggBucket>> {
  const buckets = new Map<string, AggBucket>();

  for (const download of downloads) {
    if (!download.csvPath || (download.status !== 'cached' && download.status !== 'downloaded')) {
      continue;
    }

    const neededForPair = neededMinutes.get(download.pair);
    if (!neededForPair || neededForPair.size === 0) {
      continue;
    }

    const rawCsv = await readFile(download.csvPath, 'utf8');
    const normalizedCsv = normalizeHistoricalCsv(rawCsv);
    const records = parse(normalizedCsv, { skipEmptyLines: true }) as string[][];

    for (const row of records) {
      if (row.length !== NORMALIZED_HEADER_LENGTH || row[0] === 'timestamp') {
        continue;
      }

      const timestamp = Number.parseInt(row[0]!, 10);
      if (!neededForPair.has(timestamp)) {
        continue;
      }

      buckets.set(getMinuteKey(download.pair, timestamp), parseNormalizedRow(row));
    }
  }

  return buckets;
}

function parseNormalizedRow(row: string[]): AggBucket {
  return {
    type: 'full',
    timestamp: Number.parseInt(row[0]!, 10),
    open: Number.parseFloat(row[1]!),
    high: Number.parseFloat(row[2]!),
    low: Number.parseFloat(row[3]!),
    close: Number.parseFloat(row[4]!),
    buyCost: Number.parseFloat(row[5]!),
    sellCost: Number.parseFloat(row[6]!),
    buyVolume: Number.parseFloat(row[7]!),
    sellVolume: Number.parseFloat(row[8]!),
    liqBuyCost: Number.parseFloat(row[9]!),
    liqSellCost: Number.parseFloat(row[10]!),
    liqBuyVolume: Number.parseFloat(row[11]!),
    liqSellVolume: Number.parseFloat(row[12]!),
    tradeCount: Number.parseInt(row[13]!, 10),
    liqCount: Number.parseInt(row[14]!, 10),
  };
}

function getMinuteKey(pair: string, timestamp: number): string {
  return `${pair}:${timestamp}`;
}

function getNeededMinutesByPair(jobs: RepairJob[]): Map<string, Set<number>> {
  const needed = new Map<string, Set<number>>();

  for (const job of jobs) {
    const pairNeeded = needed.get(job.pair) ?? new Set<number>();
    for (const timestamp of job.sourceMinuteTimestamps) {
      pairNeeded.add(timestamp);
    }
    needed.set(job.pair, pairNeeded);
  }

  return needed;
}

function getNeededDays(jobs: RepairJob[]): Map<string, Set<string>> {
  const days = new Map<string, Set<string>>();

  for (const job of jobs) {
    const pairDays = days.get(job.pair) ?? new Set<string>();
    for (const timestamp of job.sourceMinuteTimestamps) {
      pairDays.add(dateToBinanceDay(timestamp));
    }
    days.set(job.pair, pairDays);
  }

  return days;
}

function createSyntheticMinute(db: Database, pair: string, timestamp: number): AggBucket {
  const price = findReferencePrice(db, pair, timestamp);
  return {
    type: 'full',
    timestamp,
    open: price,
    high: price,
    low: price,
    close: price,
    buyCost: 0,
    sellCost: 0,
    buyVolume: 0,
    sellVolume: 0,
    liqBuyCost: 0,
    liqSellCost: 0,
    liqBuyVolume: 0,
    liqSellVolume: 0,
    tradeCount: 0,
    liqCount: 0,
  };
}

function getExistingMinute(db: Database, pair: string, timestamp: number): AggBucket | null {
  const tableName = getKlinesTableName(pair, BASE_TIMEFRAME);
  const row = db.query<AggBucket, [number]>(`SELECT * FROM ${tableName} WHERE timestamp = ? LIMIT 1`).get(timestamp);
  return row ? { ...row, type: 'full' } : null;
}

function findReferencePrice(db: Database, pair: string, timestamp: number): number {
  const tableName = getKlinesTableName(pair, BASE_TIMEFRAME);
  const previous = db
    .query<{ close: number }, [number]>(`SELECT close FROM ${tableName} WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1`)
    .get(timestamp);
  if (previous) {
    return previous.close;
  }

  const next = db
    .query<{ open: number }, [number]>(`SELECT open FROM ${tableName} WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 1`)
    .get(timestamp);
  return next?.open ?? 0;
}

function buildBucket(
  db: Database,
  job: RepairJob,
  downloadedMinutes: Map<string, AggBucket>
): {
  bucket: AggBucket;
  downloadedMinuteCount: number;
  databaseMinuteCount: number;
  syntheticMinuteCount: number;
} {
  let downloadedMinuteCount = 0;
  let databaseMinuteCount = 0;
  let syntheticMinuteCount = 0;
  let bucket: AggBucket | null = null;

  for (const minuteTimestamp of job.sourceMinuteTimestamps) {
    const downloaded = downloadedMinutes.get(getMinuteKey(job.pair, minuteTimestamp));
    const existing = downloaded ? null : getExistingMinute(db, job.pair, minuteTimestamp);
    const minute = downloaded ?? existing ?? createSyntheticMinute(db, job.pair, minuteTimestamp);

    if (downloaded) {
      downloadedMinuteCount++;
    } else if (existing) {
      databaseMinuteCount++;
    } else {
      syntheticMinuteCount++;
    }

    if (!bucket) {
      bucket = { ...minute, timestamp: job.timestamp };
      continue;
    }

    bucket.high = Math.max(bucket.high, minute.high);
    bucket.low = Math.min(bucket.low, minute.low);
    bucket.close = minute.close;
    bucket.buyCost += minute.buyCost;
    bucket.sellCost += minute.sellCost;
    bucket.buyVolume += minute.buyVolume;
    bucket.sellVolume += minute.sellVolume;
    bucket.liqBuyCost += minute.liqBuyCost;
    bucket.liqSellCost += minute.liqSellCost;
    bucket.liqBuyVolume += minute.liqBuyVolume;
    bucket.liqSellVolume += minute.liqSellVolume;
    bucket.tradeCount += minute.tradeCount;
    bucket.liqCount += minute.liqCount;
  }

  if (!bucket) {
    throw new Error(`No source minutes for ${job.pair} ${job.timeframe} ${job.timestamp}`);
  }

  return { bucket, downloadedMinuteCount, databaseMinuteCount, syntheticMinuteCount };
}

function rowExists(db: Database, pair: string, timeframe: SIOTimeFrame, timestamp: number): boolean {
  const tableName = getKlinesTableName(pair, timeframe);
  const row = db
    .query<{ timestamp: number }, [number]>(`SELECT timestamp FROM ${tableName} WHERE timestamp = ? LIMIT 1`)
    .get(timestamp);
  return Boolean(row);
}

function incrementInserted(result: RepairResult, pair: string, timeframe: SIOTimeFrame): void {
  const tableName = getKlinesTableName(pair, timeframe);
  result.insertedByTable[tableName] = (result.insertedByTable[tableName] ?? 0) + 1;
}

function printTextResult(result: RepairResult): void {
  console.log(
    `Repair jobs=${result.jobsFound}, inserted=${result.inserted}, ` +
      `skippedExisting=${result.skippedExisting}, skippedUnsupported=${result.skippedUnsupported}`
  );
  console.log(
    `Source minutes: downloaded=${result.downloadedMinutes}, ` +
      `database=${result.databaseMinutes}, synthetic=${result.syntheticMinutes}`
  );
  for (const [tableName, count] of Object.entries(result.insertedByTable)) {
    console.log(`  - ${tableName}: ${count}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const analysis = analyzeKlineGaps(args.dbPath);
  const jobs = collectRepairJobs(analysis.tables, args);
  const skippedUnsupported = analysis.tables
    .filter((table) => table.gaps.length > 0 && !REPAIRABLE_TIMEFRAMES.has(table.table.timeframe))
    .reduce((sum, table) => sum + table.missingCount, 0);

  const result: RepairResult = {
    dbPath: args.dbPath,
    dryRun: args.dryRun,
    jobsFound: jobs.length,
    inserted: 0,
    skippedExisting: 0,
    skippedUnsupported,
    downloadedMinutes: 0,
    databaseMinutes: 0,
    syntheticMinutes: 0,
    downloads: [],
    insertedByTable: {},
  };

  if (jobs.length === 0) {
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printTextResult(result);
    }
    return;
  }

  const neededDays = getNeededDays(jobs);
  for (const [pair, days] of neededDays) {
    for (const day of [...days].sort()) {
      result.downloads.push(await ensureDailyCsv(args, pair, day));
    }
  }

  const neededMinutes = getNeededMinutesByPair(jobs);
  const downloadedMinutes = await loadNeededDownloadedMinutes(result.downloads, neededMinutes);
  const db = new Database(args.dbPath, { readonly: true, strict: true });
  NexusConfig.sqliteKlinesDBPath = args.dbPath;

  try {
    for (const job of jobs) {
      if (rowExists(db, job.pair, job.timeframe, job.timestamp)) {
        result.skippedExisting++;
        continue;
      }

      const built = buildBucket(db, job, downloadedMinutes);
      result.downloadedMinutes += built.downloadedMinuteCount;
      result.databaseMinutes += built.databaseMinuteCount;
      result.syntheticMinutes += built.syntheticMinuteCount;

      if (!args.dryRun) {
        insertKlinesToDB([built.bucket], job.pair, job.timeframe);
      }

      result.inserted++;
      incrementInserted(result, job.pair, job.timeframe);
    }
  } finally {
    db.close();
    closeKlinesDB();
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printTextResult(result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
