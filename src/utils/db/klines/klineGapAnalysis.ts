import { Database } from 'bun:sqlite';

import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';
import { SIOTimeFramesMsMap } from '@/domain/SIOTimeFrame';
import { validateTableName } from '@/utils/db/validateTableName';

export type KlineGapTableInfo = {
  name: string;
  pair: string;
  timeframe: SIOTimeFrame;
  timeframeMs: number;
};

export type KlineGap = {
  afterTimestamp: number;
  beforeTimestamp: number;
  missingStart: number;
  missingEnd: number;
  missingCount: number;
  missingTimestamps: number[];
};

export type KlineTableGapAnalysis = {
  table: KlineGapTableInfo;
  count: number;
  startDate: number | null;
  endDate: number | null;
  gaps: KlineGap[];
  missingCount: number;
};

export type KlineGapAnalysis = {
  dbPath: string;
  tables: KlineTableGapAnalysis[];
  summary: {
    tableCount: number;
    tablesWithGaps: number;
    totalMissingTimestamps: number;
  };
};

type TimestampRow = {
  timestamp: number;
};

type TableStats = {
  count: number;
  startDate: number | null;
  endDate: number | null;
};

const validTimeframes = Object.keys(SIOTimeFramesMsMap) as SIOTimeFrame[];
const validTimeframesDesc = [...validTimeframes].sort((a, b) => b.length - a.length);

export function parseKlinesTableName(tableName: string): KlineGapTableInfo | null {
  if (!tableName.startsWith('klines_')) {
    return null;
  }

  const suffix = tableName.slice('klines_'.length);

  for (const timeframe of validTimeframesDesc) {
    if (!suffix.endsWith(`_${timeframe}`)) {
      continue;
    }

    const pair = suffix.slice(0, -(timeframe.length + 1));
    if (!pair) {
      return null;
    }

    return {
      name: validateTableName(tableName, 'klines table name'),
      pair,
      timeframe,
      timeframeMs: SIOTimeFramesMsMap[timeframe],
    };
  }

  return null;
}

export function getKlinesTables(db: Database): KlineGapTableInfo[] {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'klines_%' ORDER BY name ASC"
    )
    .all();

  return rows.flatMap((row) => {
    const parsed = parseKlinesTableName(row.name);
    return parsed ? [parsed] : [];
  });
}

export function analyzeKlineGaps(dbPath: string): KlineGapAnalysis {
  const db = new Database(dbPath, { readonly: true, strict: true });

  try {
    const tables = getKlinesTables(db).map((table) => {
      const stats = getTableStats(db, table.name);
      const gaps = stats.count === 0 ? [] : findGaps(db, table);
      const missingCount = gaps.reduce((sum, gap) => sum + gap.missingCount, 0);

      return {
        table,
        count: stats.count,
        startDate: stats.startDate,
        endDate: stats.endDate,
        gaps,
        missingCount,
      };
    });

    const tablesWithGaps = tables.filter((table) => table.gaps.length > 0).length;
    const totalMissingTimestamps = tables.reduce((sum, table) => sum + table.missingCount, 0);

    return {
      dbPath,
      tables,
      summary: {
        tableCount: tables.length,
        tablesWithGaps,
        totalMissingTimestamps,
      },
    };
  } finally {
    db.close();
  }
}

function getTableStats(db: Database, tableName: string): TableStats {
  return db
    .query<TableStats, []>(
      `SELECT COUNT(*) AS count, MIN(timestamp) AS startDate, MAX(timestamp) AS endDate FROM ${tableName}`
    )
    .get()!;
}

function findGaps(db: Database, table: KlineGapTableInfo): KlineGap[] {
  const gaps: KlineGap[] = [];
  const stmt = db.query<TimestampRow, []>(`SELECT timestamp FROM ${table.name} ORDER BY timestamp ASC`);
  let previousTimestamp: number | null = null;

  for (const row of stmt.iterate()) {
    if (previousTimestamp === null) {
      previousTimestamp = row.timestamp;
      continue;
    }

    const expectedTimestamp = previousTimestamp + table.timeframeMs;

    if (row.timestamp > expectedTimestamp) {
      const missingTimestamps = collectMissingTimestamps(
        expectedTimestamp,
        row.timestamp,
        table.timeframeMs
      );
      gaps.push({
        afterTimestamp: previousTimestamp,
        beforeTimestamp: row.timestamp,
        missingStart: missingTimestamps[0]!,
        missingEnd: missingTimestamps.at(-1)!,
        missingCount: missingTimestamps.length,
        missingTimestamps,
      });
    }

    previousTimestamp = row.timestamp;
  }

  return gaps;
}

function collectMissingTimestamps(start: number, before: number, step: number): number[] {
  const timestamps: number[] = [];
  for (let timestamp = start; timestamp < before; timestamp += step) {
    timestamps.push(timestamp);
  }
  return timestamps;
}
