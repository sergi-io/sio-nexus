export type SIOKline = {
  timestamp: number; // Timestamp in milliseconds
  open: number; // Open price
  high: number; // High price
  low: number; // Low price
  close: number; // Close price
  buyCost: number; // Total cost of buy trades in this kline
  sellCost: number; // Total cost of sell trades in this kline
  buyVolume: number; // Total volume of buy trades in this kline
  sellVolume: number; // Total volume of sell trades in this kline
  liqBuyCost: number; // Total cost of buy liquidations in this kline
  liqSellCost: number; // Total cost of sell liquidations in this kline
  liqBuyVolume: number; // Total volume of buy liquidations in this kline
  liqSellVolume: number; // Total volume of sell liquidations in this kline
  tradeCount: number; // Number of trades in this kline
  liqCount: number; // Number of liquidations in this kline
};
