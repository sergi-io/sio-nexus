import { readFileSync, writeFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const TARGET_HEADER = [
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

const BINANCE_HEADER = [
  'open_time',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'close_time',
  'quote_volume',
  'count',
  'taker_buy_volume',
  'taker_buy_quote_volume',
  'ignore',
] as const;

export function normalizeHistoricalData(filePath: string): void {
  if (!filePath) {
    console.log('Usage: bun --normalize-historical-data <csv_file_path>');
    process.exit(1);
  }

  try {
    processCsv(filePath);
  } catch (error) {
    console.error('Error processing file:', filePath, error);
    process.exit(1);
  }
}

export function normalizeHistoricalCsv(rawCsv: string): string {
  const records = parse(rawCsv, { skipEmptyLines: true }) as unknown[][];

  if (records.length === 0) {
    return stringify([]);
  }

  const filtered: string[][] = [Array.from(TARGET_HEADER)];

  for (const record of records) {
    const row = normalizeRow(record);
    if (row.length === 0 || row.every((value) => value === '')) {
      continue;
    }

    if (isHeaderRow(row)) {
      continue;
    }

    filtered.push(normalizeDataRow(row));
  }

  return stringify(filtered);
}

function processCsv(filePath: string): void {
  console.log('Normalizing CSV file:', filePath);
  const rawCsv = readFileSync(filePath, 'utf8');
  const output = normalizeHistoricalCsv(rawCsv);
  writeFileSync(filePath, output, 'utf8');
}

function normalizeDataRow(row: string[]): string[] {
  if (row.length === TARGET_HEADER.length) {
    return row;
  }

  if (row.length < BINANCE_HEADER.length) {
    throw new Error(`Unexpected CSV row length ${row.length}. Expected ${BINANCE_HEADER.length}.`);
  }

  const timestamp = toIntegerString(row[0]!, 'timestamp');
  const open = toDecimalString(row[1]!, 'open');
  const high = toDecimalString(row[2]!, 'high');
  const low = toDecimalString(row[3]!, 'low');
  const close = toDecimalString(row[4]!, 'close');
  const totalVolume = toDecimalString(row[5]!, 'volume');
  const totalQuoteVolume = toDecimalString(row[7]!, 'quote_volume');
  const tradeCount = toIntegerString(row[8]!, 'tradeCount');
  const buyVolume = toDecimalString(row[9]!, 'taker_buy_volume');
  const buyCost = toDecimalString(row[10]!, 'taker_buy_quote_volume');
  const sellVolume = subtractDecimalStrings(totalVolume, buyVolume);
  const sellCost = subtractDecimalStrings(totalQuoteVolume, buyCost);

  return [
    timestamp,
    open,
    high,
    low,
    close,
    buyCost,
    sellCost,
    buyVolume,
    sellVolume,
    '0',
    '0',
    '0',
    '0',
    tradeCount,
    '0',
  ];
}

function isHeaderRow(row: string[]): boolean {
  return matchesHeader(row, TARGET_HEADER) || matchesHeader(row, BINANCE_HEADER);
}

function matchesHeader(row: string[], header: readonly string[]): boolean {
  return row.length === header.length && row.every((value, idx) => value === header[idx]);
}

function normalizeRow(row: unknown[]): string[] {
  return (row ?? []).map((value) => (value === undefined || value === null ? '' : String(value)));
}

function toIntegerString(value: string, label: string): string {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${label}: ${value}`);
  }
  return String(parsed);
}

function toDecimalString(value: string, label: string): string {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid decimal for ${label}: ${value}`);
  }
  return value;
}

function subtractDecimalStrings(total: string, part: string): string {
  const precision = Math.max(decimalPlaces(total), decimalPlaces(part));
  const multiplier = 10 ** precision;
  const diff = Math.round(Number.parseFloat(total) * multiplier - Number.parseFloat(part) * multiplier);
  const normalized = diff / multiplier;

  if (precision === 0) {
    return String(normalized);
  }

  return normalized.toFixed(precision);
}

function decimalPlaces(value: string): number {
  const [, fraction = ''] = value.split('.');
  return fraction.length;
}
