import path from 'path';

import type { KlineGap, KlineGapAnalysis } from './klineGapAnalysis';
import { analyzeKlineGaps } from './klineGapAnalysis';

type AnalyzeArgs = {
  dbPath: string;
  json: boolean;
};

function parseArgs(): AnalyzeArgs {
  const args = Bun.argv.slice(2);
  const json = args.includes('--json');
  const dbPathArg = args.find((arg) => !arg.startsWith('-')) ?? './data/klines.db';

  return {
    dbPath: path.resolve(dbPathArg),
    json,
  };
}

function formatTimestamp(timestamp: number): string {
  return `${new Date(timestamp).toISOString()} (${timestamp})`;
}

function formatGap(gap: KlineGap): string {
  if (gap.missingCount === 1) {
    return `falta ${formatTimestamp(gap.missingStart)}`;
  }

  return [
    `faltan ${gap.missingCount} timestamps`,
    `${formatTimestamp(gap.missingStart)} -> ${formatTimestamp(gap.missingEnd)}`,
  ].join(': ');
}

function printTextReport(analysis: KlineGapAnalysis): void {
  if (analysis.tables.length === 0) {
    console.log(`No hay tablas klines_* en ${analysis.dbPath}`);
    return;
  }

  console.log(`Analizando ${analysis.tables.length} tablas en ${analysis.dbPath}\n`);

  for (const result of analysis.tables) {
    const { table } = result;

    if (result.count === 0 || result.startDate === null || result.endDate === null) {
      console.log(`EMPTY ${table.name} (${table.pair} ${table.timeframe})`);
      continue;
    }

    const range = `${formatTimestamp(result.startDate)} -> ${formatTimestamp(result.endDate)}`;

    if (result.gaps.length === 0) {
      console.log(`OK ${table.name} (${table.pair} ${table.timeframe}) rows=${result.count} ${range}`);
      continue;
    }

    console.log(
      `GAPS ${table.name} (${table.pair} ${table.timeframe}) rows=${result.count} ` +
        `gaps=${result.gaps.length} missing=${result.missingCount} ${range}`
    );

    for (const gap of result.gaps) {
      console.log(
        `  - entre ${formatTimestamp(gap.afterTimestamp)} y ` +
          `${formatTimestamp(gap.beforeTimestamp)}: ${formatGap(gap)}`
      );
    }
  }

  console.log(
    `\nResumen: ${analysis.summary.tablesWithGaps}/${analysis.summary.tableCount} tablas con huecos, ` +
      `${analysis.summary.totalMissingTimestamps} timestamps faltantes.`
  );
}

function main(): void {
  const args = parseArgs();
  const analysis = analyzeKlineGaps(args.dbPath);

  if (args.json) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  printTextReport(analysis);
}

main();
