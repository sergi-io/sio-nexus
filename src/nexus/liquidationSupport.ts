export function shouldWatchLiquidations(
  pairs: string[],
  capabilities: Record<string, unknown>
): boolean {
  if (pairs.length === 0) {
    return false;
  }

  return pairs.length === 1
    ? Boolean(capabilities.watchLiquidations)
    : Boolean(capabilities.watchLiquidationsForSymbols);
}
