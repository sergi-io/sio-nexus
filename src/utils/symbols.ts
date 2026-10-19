export function normalizeSymbolString(symbol: string): string | null {
  const normalizedSymbol = symbol.replace('/', '');
  return normalizedSymbol.split(':')[0] ?? null;
}
