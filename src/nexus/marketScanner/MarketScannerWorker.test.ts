import { describe, expect, it } from 'bun:test';
import { type MarketLike, resolveSourceSymbolsFromMarkets } from './MarketScannerWorker';
import { DEFAULT_MARKET_SCANNER_CONFIG } from './types';

describe('resolveSourceSymbolsFromMarkets', () => {
  it('selects Binance derivatives only when they are tradeable on Phemex', () => {
    const sourceMarkets: MarketLike[] = [
      {
        symbol: 'SOL/USDT',
        base: 'SOL',
        quote: 'USDT',
        active: true,
        type: 'spot',
        spot: true,
      },
      {
        symbol: 'SOL/USDT:USDT',
        base: 'SOL',
        quote: 'USDT',
        active: true,
        type: 'swap',
        swap: true,
        contract: true,
        linear: true,
      },
      {
        symbol: 'BTC/USD:BTC',
        base: 'BTC',
        quote: 'USD',
        active: true,
        type: 'swap',
        swap: true,
        contract: true,
        linear: false,
      },
      {
        symbol: 'DOGE/USDT:USDT',
        base: 'DOGE',
        quote: 'USDT',
        active: true,
        type: 'swap',
        swap: true,
        contract: true,
        linear: true,
      },
    ];
    const tradableMarkets: MarketLike[] = [
      {
        symbol: 'SOL/USDT:USDT',
        base: 'SOL',
        quote: 'USDT',
        active: true,
        type: 'swap',
        swap: true,
      },
      {
        symbol: 'BTC/USD:BTC',
        base: 'BTC',
        quote: 'USD',
        active: true,
        type: 'swap',
        swap: true,
      },
    ];

    const result = resolveSourceSymbolsFromMarkets(sourceMarkets, tradableMarkets, {
      ...DEFAULT_MARKET_SCANNER_CONFIG,
      enabled: true,
      marketTypes: ['swap', 'future'],
    });

    expect(result.sourceSymbols).toEqual(['BTC/USD:BTC', 'SOL/USDT:USDT']);
    expect(result.sourceMarkets).toEqual([
      { symbol: 'BTC/USD:BTC', subscriptionGroup: 'swap:inverse' },
      { symbol: 'SOL/USDT:USDT', subscriptionGroup: 'swap:linear' },
    ]);
    expect(result.tradableSymbolsCount).toBe(2);
  });
});
