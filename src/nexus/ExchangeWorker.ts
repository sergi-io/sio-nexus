import { sleep } from 'bun';
import { pro as ccxtpro, Exchange } from 'ccxt';
import WebSocket from 'ws';
import { shouldWatchLiquidations } from './liquidationSupport';

export type WorkerConfig = {
  type: 'config';
  exchangeId: string;
  pairs: string[];
};

export type WorkerTradeMessage = {
  type: 'trade';
  exchangeId: string;
  side: string;
  symbol: string;
  price: number;
  amount: number;
  cost: number;
};

export type WorkerStartedMessage = {
  type: 'started';
  exchangeId: string;
  pairs: string[];
};

export type WorkerLiquidationMessage = {
  type: 'liquidation';
  exchangeId: string;
  side: string;
  symbol: string;
  price: number;
  amount: number;
  cost: number;
};

export type WorkerErrorMessage = {
  type: 'error';
  exchangeId: string;
  error: string;
};

export type WorkerMessage =
  | WorkerTradeMessage
  | WorkerLiquidationMessage
  | WorkerStartedMessage
  | WorkerErrorMessage;

declare function postMessage(msg: unknown): void;

let bunWsUpgradePatched = false;

const patchWsUpgradeListenerForBun = () => {
  if (bunWsUpgradePatched || typeof Bun === 'undefined') {
    return;
  }

  const originalOn = WebSocket.prototype.on as typeof WebSocket.prototype.on;
  if (typeof originalOn !== 'function') {
    return;
  }

  const patchedOn = function (this: WebSocket, event: unknown, listener: unknown) {
    if (event === 'upgrade') {
      return this;
    }
    return (originalOn as any).call(this, event, listener);
  } as typeof WebSocket.prototype.on;

  WebSocket.prototype.on = patchedOn;

  bunWsUpgradePatched = true;
};

const watchTrades = async (exchange: Exchange, exchangeId: string, pairs: string[]) => {
  while (true) {
    try {
      const trades =
        pairs.length === 1
          ? await exchange.watchTrades(pairs[0]!)
          : await exchange.watchTradesForSymbols(pairs);

      for (const trade of trades) {
        const price = Number(trade.price);
        const amount = Number(trade.amount);
        if (!Number.isFinite(price) || !Number.isFinite(amount) || price <= 0 || amount <= 0) {
          continue;
        }

        const rawCost = Number(trade.cost);
        const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : price * amount;

        postMessage({
          type: 'trade',
          exchangeId,
          side: trade.side,
          symbol: trade.symbol,
          price,
          amount,
          cost,
        });
      }
    } catch (error) {
      postMessage({ type: 'error', exchangeId, error: String(error) });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

const watchLiquidations = async (exchange: any, exchangeId: string, pairs: string[]) => {
  try {
    while (true) {
      const liquidations =
        pairs.length === 1
          ? await exchange.watchLiquidations(pairs[0]!)
          : await exchange.watchLiquidationsForSymbols(pairs);

      for (const liq of liquidations) {
        postMessage({
          type: 'liquidation',
          exchangeId,
          side: liq.side,
          symbol: liq.symbol,
          price: liq.price,
          amount: liq.contracts,
          cost: liq.price * liq.contracts,
        });
      }
    }
  } catch (error) {
    // Not all exchanges support liquidation watching — log and stop silently
    postMessage({
      type: 'error',
      exchangeId,
      error: `Liquidations not supported: ${String(error)}`,
    });
  }
};

const runWorker = async (exchangeId: string, pairs: string[]) => {
  const exchangeClass = (ccxtpro as Record<string, typeof Exchange>)[exchangeId];
  if (!exchangeClass) {
    postMessage({ type: 'error', exchangeId, error: `Unknown exchange: ${exchangeId}` });
    return;
  }

  const exchange = new exchangeClass();

  // For debug.
  // const m = await exchange.loadMarkets();
  // console.log(Object.keys(m).filter((s) => s.includes('SOL')));

  postMessage({ type: 'started', exchangeId, pairs });

  const toRun: Promise<void>[] = [watchTrades(exchange, exchangeId, pairs)];
  if (shouldWatchLiquidations(pairs, exchange.has as Record<string, unknown>)) {
    toRun.push(watchLiquidations(exchange, exchangeId, pairs));
  }

  await Promise.all(toRun);
};

// Wait for config from main thread, then start
addEventListener('message', (event: MessageEvent<WorkerConfig>) => {
  patchWsUpgradeListenerForBun();
  const { exchangeId, pairs } = event.data;
  void runWorker(exchangeId, pairs).catch(async (error) => {
    postMessage({
      type: 'error',
      exchangeId,
      error: `Worker fatal error, restarting in 5000ms: ${String(error)}`,
    });
    await sleep(5000);
    void runWorker(exchangeId, pairs);
  });
});
