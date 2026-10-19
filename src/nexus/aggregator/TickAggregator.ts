import type { SIOTimeFrame } from '@/domain/SIOTimeFrame';
import { SIOTimeFramesMsMap } from '@/domain/SIOTimeFrame';
import { formatMoney } from '@/utils/money';
import type { WorkerLiquidationMessage, WorkerTradeMessage } from '../ExchangeWorker';
import type { ExchangeAggregation } from '../types';
import { type AggBucket, AGGREGATION_TIMEFRAMES, createEmptyBucket } from './AggBucket';
import ansis from 'ansis';

const LOG_BUCKETS = false; // Set to true to log every closed bucket to console

export type BucketCloseCallback = (
  pair: string,
  timeframe: SIOTimeFrame,
  bucket: AggBucket
) => void;
export type BucketDeltaCallback = (
  pair: string,
  timeframe: SIOTimeFrame,
  bucket: AggBucket
) => void;

export class TickAggregator {
  /** Reverse lookup: "exchangeId:symbol" → aggregation group name */
  private readonly reverseLookup = new Map<string, string>();
  /** Lookup for symbols whose prices can drive OHLC updates */
  private readonly mainPriceTrackerLookup = new Map<string, boolean>();

  /** Current buckets: pair → timeframe → current AggBucket */
  private readonly buckets = new Map<string, Map<SIOTimeFrame, AggBucket>>();

  private readonly onBucketClose: BucketCloseCallback | null;
  private readonly onBucketDelta: BucketDeltaCallback | null;

  constructor(
    aggregatedPairs: Record<string, ExchangeAggregation>,
    onBucketClose?: BucketCloseCallback,
    onBucketDelta?: BucketDeltaCallback
  ) {
    this.onBucketClose = onBucketClose ?? null;
    this.onBucketDelta = onBucketDelta ?? null;
    this.buildReverseLookup(aggregatedPairs);
    this.initBuckets(Object.keys(aggregatedPairs));
  }

  private buildReverseLookup(aggregatedPairs: Record<string, ExchangeAggregation>): void {
    for (const [p, exchanges] of Object.entries(aggregatedPairs)) {
      for (const exchangePair of exchanges) {
        for (const pair of exchangePair.pairs) {
          const key = `${exchangePair.exchangeId}:${pair}`;
          this.reverseLookup.set(key, p);
          this.mainPriceTrackerLookup.set(key, exchangePair.mainPriceTracker === true);
        }
      }
    }
  }

  private initBuckets(pairs: string[]): void {
    const now = Date.now();
    for (const pair of pairs) {
      const tfMap = new Map<SIOTimeFrame, AggBucket>();
      for (const tf of AGGREGATION_TIMEFRAMES) {
        const ms = SIOTimeFramesMsMap[tf];
        tfMap.set(tf, createEmptyBucket(now - (now % ms)));
      }
      this.buckets.set(pair, tfMap);
    }
  }

  private resolveGroup(exchangeId: string, symbol: string): string | undefined {
    return this.reverseLookup.get(`${exchangeId}:${symbol}`);
  }

  private canUsePrice(exchangeId: string, symbol: string): boolean {
    return this.mainPriceTrackerLookup.get(`${exchangeId}:${symbol}`) === true;
  }

  private isPriceUnset(bucket: AggBucket): boolean {
    return bucket.open === 0 && bucket.high === 0 && bucket.low === 0 && bucket.close === 0;
  }

  private getOrRotateBucket(pair: string, timeframe: SIOTimeFrame, eventTime: number): AggBucket {
    const tfMap = this.buckets.get(pair)!;
    const ms = SIOTimeFramesMsMap[timeframe];
    const alignedTs = eventTime - (eventTime % ms);
    let bucket = tfMap.get(timeframe)!;

    if (bucket.timestamp !== alignedTs) {
      // Bucket closed — emit it if it had any activity
      if (bucket.close > 0) {
        this.emitBucketClose(pair, timeframe, bucket);
      }
      bucket = createEmptyBucket(alignedTs);
      tfMap.set(timeframe, bucket);
    }

    return bucket;
  }

  private emitBucketClose(pair: string, timeframe: SIOTimeFrame, bucket: AggBucket): void {
    bucket.type = 'full';
    if (LOG_BUCKETS) {
      this.logBucket(pair, timeframe, bucket);
    }
    this.onBucketClose?.(pair, timeframe, bucket);
  }

  private emitBucketPartial(pair: string, timeframe: SIOTimeFrame, bucket: AggBucket): void {
    bucket.type = 'delta';
    this.onBucketDelta?.(pair, timeframe, bucket);
  }

  private logBucket(pair: string, timeframe: SIOTimeFrame, bucket: AggBucket): void {
    const netCost = bucket.buyCost - bucket.sellCost;
    const totalVolume = bucket.buyVolume + bucket.sellVolume;
    const date = new Date(bucket.timestamp).toISOString();

    const parts = [
      ansis.cyan(`[${pair}]`),
      ansis.yellow(`[${timeframe.padStart(3)}]`),
      date,
      `O:${bucket.open.toFixed(2)} H:${bucket.high.toFixed(2)} L:${bucket.low.toFixed(2)} C:${bucket.close.toFixed(2)}`,
      `trades:${bucket.tradeCount}`,
      `vol:${totalVolume.toFixed(2)}`,
      `net:${formatMoney(netCost, { withIcon: true })}`,
      `buy:${formatMoney(bucket.buyCost, { colorize: false, withIcon: false })}`,
      `sell:${formatMoney(bucket.sellCost, { colorize: false, withIcon: false })}`,
    ];

    if (bucket.liqCount > 0) {
      const netLiq = bucket.liqBuyCost - bucket.liqSellCost;
      parts.push(
        ansis.red(`liq:${bucket.liqCount}`),
        `liqNet:${formatMoney(netLiq, { withIcon: false })}`
      );
    }

    console.log(parts.join(' '));
  }

  processTrade(msg: WorkerTradeMessage): void {
    const pair = this.resolveGroup(msg.exchangeId, msg.symbol);
    if (!pair) return;
    const canUsePrice = this.canUsePrice(msg.exchangeId, msg.symbol);

    const now = Date.now();
    const isBuy = msg.side === 'buy';
    for (const tf of AGGREGATION_TIMEFRAMES) {
      const bucket = this.getOrRotateBucket(pair, tf, now);

      if (canUsePrice) {
        if (this.isPriceUnset(bucket)) {
          bucket.open = msg.price;
          bucket.high = msg.price;
          bucket.low = msg.price;
        } else {
          if (msg.price > bucket.high) bucket.high = msg.price;
          if (msg.price < bucket.low) bucket.low = msg.price;
        }
        bucket.close = msg.price;
      }

      if (isBuy) {
        bucket.buyCost += msg.cost;
        bucket.buyVolume += msg.amount;
      } else {
        bucket.sellCost += msg.cost;
        bucket.sellVolume += msg.amount;
      }
      bucket.tradeCount++;

      // No need to emit partial updates for empty buckets, as they won't be sent to clients until they have activity.
      if (bucket.close === 0) {
        return;
      }

      this.emitBucketPartial(pair, tf, bucket);
    }
  }

  processLiquidation(msg: WorkerLiquidationMessage): void {
    const pair = this.resolveGroup(msg.exchangeId, msg.symbol);
    if (!pair) return;
    const canUsePrice = this.canUsePrice(msg.exchangeId, msg.symbol);

    const now = Date.now();
    const isBuy = msg.side === 'buy';

    for (const tf of AGGREGATION_TIMEFRAMES) {
      const bucket = this.getOrRotateBucket(pair, tf, now);

      // Liquidation-only buckets still need a price context so OHLC doesn't remain zero.
      if (canUsePrice && bucket.tradeCount === 0) {
        if (this.isPriceUnset(bucket)) {
          bucket.open = msg.price;
          bucket.high = msg.price;
          bucket.low = msg.price;
        } else {
          if (msg.price > bucket.high) bucket.high = msg.price;
          if (msg.price < bucket.low) bucket.low = msg.price;
        }
        bucket.close = msg.price;
      }

      if (isBuy) {
        bucket.liqBuyCost += msg.cost;
        bucket.liqBuyVolume += msg.amount;
      } else {
        bucket.liqSellCost += msg.cost;
        bucket.liqSellVolume += msg.amount;
      }
      bucket.liqCount++;

      // No need to emit partial updates for empty buckets, as they won't be sent to clients until they have activity.
      if (bucket.close === 0) {
        return;
      }
      this.emitBucketPartial(pair, tf, bucket);
    }
  }
}
