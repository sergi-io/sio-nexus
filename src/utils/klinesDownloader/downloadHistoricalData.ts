import { config } from '@/config';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

export async function downloadHistoricalData(startDate?: string, endDate?: string): Promise<void> {
  const projectRoot = process.cwd();

  const symbol = 'SOLUSDT'; // botConfig.assetSymbol;
  const timeframe = '1m';

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate must be provided');
  }

  if (!symbol || !timeframe) {
    throw new Error(`assetSymbol or assetTimeFrame is missing `);
  }

  const outputDir = path.join(projectRoot, `data/historical/${symbol}-${timeframe}`);

  if (config.general.isBinary) {
    const currentBinary = process.execPath;
    await run(
      currentBinary,
      [
        'download-historical-binance-data',
        '--parallel',
        '10',
        '-d',
        startDate,
        endDate,
        '-p',
        'usd-m',
        '-t',
        'klines',
        '-s',
        symbol,
        '-i',
        timeframe,
        '-o',
        outputDir,
      ],
      projectRoot
    );
  } else {
    await run(
      'bun',
      [
        './src/main.ts',
        'download-historical-binance-data',
        '--parallel',
        '10',
        '-d',
        startDate,
        endDate,
        '-p',
        'usd-m',
        '-t',
        'klines',
        '-s',
        symbol,
        '-i',
        timeframe,
        '-o',
        outputDir,
      ],
      projectRoot
    );
  }

  const historicalDir = outputDir;
  const finalCsvPath = path.join(historicalDir, `${symbol}.csv`);
  await rm(finalCsvPath, { force: true });

  const zipFiles = (await readdir(historicalDir)).filter((file) => file.endsWith('.zip'));
  for (const zip of zipFiles) {
    await run('unzip', ['-o', zip], historicalDir);
  }
  for (const zip of zipFiles) {
    await rm(path.join(historicalDir, zip), { force: true });
  }

  const partialCsvs = (await readdir(historicalDir))
    .filter((file) => file.startsWith(`${symbol}-${timeframe}-`) && file.endsWith('.csv'))
    .sort();

  if (partialCsvs.length === 0) {
    throw new Error(`No CSV parts found for ${symbol}-${timeframe}`);
  }

  const tempCsvPath = path.join(historicalDir, `${symbol}.new`);
  await rm(tempCsvPath, { force: true });

  for (const partial of partialCsvs) {
    await pipeline(
      createReadStream(path.join(historicalDir, partial)),
      createWriteStream(tempCsvPath, { flags: 'a' })
    );
  }

  await Promise.all(partialCsvs.map((file) => rm(path.join(historicalDir, file), { force: true })));
  await rename(tempCsvPath, finalCsvPath);
  const csvRelativePath = path.join('data/historical', `${symbol}-${timeframe}`, `${symbol}.csv`);
  if (config.general.isBinary) {
    // Take current binary name
    const currentBinary = process.execPath;
    await run(currentBinary, ['normalize-historical-data', csvRelativePath], projectRoot);
    await run(currentBinary, ['import-historical-klines', symbol, csvRelativePath], projectRoot);
  } else {
    await run('bun', ['src/main.ts', 'normalize-historical-data', csvRelativePath], projectRoot);
    await run('bun', ['src/main.ts', 'import-historical-klines', symbol, csvRelativePath], projectRoot);
  }
}
