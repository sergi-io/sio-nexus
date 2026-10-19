import { getKlinesDB, getKlinesTableName } from './klinesDB';
import type { AggBucket } from '@/nexus/aggregator/AggBucket';
import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';

export function insertKlinesToDB(klines: AggBucket[], pair: string, timeframe: SIOTimeFrame): void {
  if (klines.length === 0) return;

  const tableName = getKlinesTableName(pair, timeframe);
  const db = getKlinesDB(pair, timeframe);

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${tableName}
      (timestamp, open, high, low, close, buyCost, sellCost, buyVolume, sellVolume,
       liqBuyCost, liqSellCost, liqBuyVolume, liqSellVolume, tradeCount, liqCount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
  );

  const insertMany = db.transaction((rows: AggBucket[]) => {
    for (const row of rows) {
      stmt.run(
        row.timestamp,
        row.open,
        row.high,
        row.low,
        row.close,
        row.buyCost,
        row.sellCost,
        row.buyVolume,
        row.sellVolume,
        row.liqBuyCost,
        row.liqSellCost,
        row.liqBuyVolume,
        row.liqSellVolume,
        row.tradeCount,
        row.liqCount
      );
    }
  });

  insertMany(klines);
}
