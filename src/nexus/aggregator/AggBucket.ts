import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';

export type AggBucket = {
  type: 'full' | 'delta';
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyCost: number;
  sellCost: number;
  buyVolume: number;
  sellVolume: number;
  liqBuyCost: number;
  liqSellCost: number;
  liqBuyVolume: number;
  liqSellVolume: number;
  tradeCount: number;
  liqCount: number;
};

export const AGGREGATION_TIMEFRAMES: SIOTimeFrame[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function createEmptyBucket(timestamp: number): AggBucket {
  return {
    type: 'delta',
    timestamp,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    buyCost: 0,
    sellCost: 0,
    buyVolume: 0,
    sellVolume: 0,
    liqBuyCost: 0,
    liqSellCost: 0,
    liqBuyVolume: 0,
    liqSellVolume: 0,
    tradeCount: 0,
    liqCount: 0,
  };
}
