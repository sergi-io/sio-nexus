import { describe, expect, it } from 'bun:test';
import { normalizeHistoricalCsv } from './normalizeHistoricalData';

describe('normalizeHistoricalCsv', () => {
  it('converts Binance kline CSV rows into the DB schema', () => {
    const input = [
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1772323200000,84.2900,84.5800,84.2900,84.5200,40499.90,1772323259999,3421025.732200,3506,27670.56,2337372.725900,0',
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1772323260000,84.5100,84.5300,84.4600,84.4700,12313.37,1772323319999,1040377.832000,1354,4293.08,362747.290600,0',
    ].join('\n');

    const output = normalizeHistoricalCsv(input);

    expect(output).toBe(
      [
        'timestamp,open,high,low,close,buyCost,sellCost,buyVolume,sellVolume,liqBuyCost,liqSellCost,liqBuyVolume,liqSellVolume,tradeCount,liqCount',
        '1772323200000,84.2900,84.5800,84.2900,84.5200,2337372.725900,1083653.006300,27670.56,12829.34,0,0,0,0,3506,0',
        '1772323260000,84.5100,84.5300,84.4600,84.4700,362747.290600,677630.541400,4293.08,8020.29,0,0,0,0,1354,0',
        '',
      ].join('\n')
    );
  });

  it('keeps already normalized CSV rows intact', () => {
    const input = [
      'timestamp,open,high,low,close,buyCost,sellCost,buyVolume,sellVolume,liqBuyCost,liqSellCost,liqBuyVolume,liqSellVolume,tradeCount,liqCount',
      '1772323200000,84.2900,84.5800,84.2900,84.5200,2337372.725900,1083653.006300,27670.56,12829.34,0,0,0,0,3506,0',
    ].join('\n');

    const output = normalizeHistoricalCsv(input);

    expect(output).toBe(`${input}\n`);
  });
});
