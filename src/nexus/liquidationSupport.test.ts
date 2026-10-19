import { describe, expect, it } from 'bun:test';
import { shouldWatchLiquidations } from './liquidationSupport';

describe('shouldWatchLiquidations', () => {
  it('uses single-symbol liquidation support for single-pair workers', () => {
    expect(
      shouldWatchLiquidations(['SOL/USDT:USDT'], {
        watchLiquidations: true,
        watchLiquidationsForSymbols: false,
      })
    ).toBe(true);
  });

  it('uses multi-symbol liquidation support for multi-pair workers', () => {
    expect(
      shouldWatchLiquidations(['SOL/USDT:USDT', 'SOL/USDC:USDC'], {
        watchLiquidations: false,
        watchLiquidationsForSymbols: true,
      })
    ).toBe(true);
  });

  it('does not treat single-symbol support as multi-symbol support', () => {
    expect(
      shouldWatchLiquidations(['SOL/USDT:USDT', 'SOL/USDC:USDC'], {
        watchLiquidations: true,
        watchLiquidationsForSymbols: false,
      })
    ).toBe(false);
  });
});
