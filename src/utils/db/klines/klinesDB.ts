import { Database } from 'bun:sqlite';
import { getDB } from '../getDB';
import { validateTableName } from '../validateTableName';
import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';
import { NexusConfig } from '@/nexus/NexusConfig';

// Singleton DB connection — prevents repeated open/close cycles that cause SQLite concurrency issues.
let klinesDBInstance: Database | null = null;

// Tracks which tables have already been created in this process.
const initializedTables = new Set<string>();

/** Replace characters invalid in SQLite identifiers (e.g. '/' in 'BTC/USDT'). */
export function sanitizePair(pair: string): string {
  return pair.replace(/\//g, '_');
}

/** Returns the validated table name for a given pair + timeframe, e.g. klines_BTC_USDT_1h */
export function getKlinesTableName(pair: string, timeframe: SIOTimeFrame): string {
  return validateTableName(`klines_${sanitizePair(pair)}_${timeframe}`, 'klines table name');
}

export function getKlinesDB(pair: string, timeframe: SIOTimeFrame): Database {
  if (!klinesDBInstance) {
    klinesDBInstance = getDB(NexusConfig.sqliteKlinesDBPath);
  }

  const tableName = getKlinesTableName(pair, timeframe);

  if (!initializedTables.has(tableName)) {
    klinesDBInstance.run(
      `CREATE TABLE IF NOT EXISTS ${tableName} (
        timestamp INTEGER PRIMARY KEY,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        buyCost REAL NOT NULL,
        sellCost REAL NOT NULL,
        buyVolume REAL NOT NULL,
        sellVolume REAL NOT NULL,
        liqBuyCost REAL NOT NULL,
        liqSellCost REAL NOT NULL,
        liqBuyVolume REAL NOT NULL,
        liqSellVolume REAL NOT NULL,
        tradeCount INTEGER NOT NULL,
        liqCount INTEGER NOT NULL
      ) WITHOUT ROWID;`
    );
    initializedTables.add(tableName);
  }

  return klinesDBInstance;
}

/**
 * Explicitly close the klines database connection.
 * Should only be called during process shutdown.
 */
export function closeKlinesDB(): void {
  if (klinesDBInstance) {
    try {
      klinesDBInstance.close();
    } catch {
      // Ignore close errors — connection may already be closed
    }
    klinesDBInstance = null;
    initializedTables.clear();
  }
}
