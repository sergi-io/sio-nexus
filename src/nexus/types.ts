export type ExchangePair = {
  exchangeId: string;
  pairs: string[];
  watchLiquidations: boolean;
  mainPriceTracker?: boolean;
};

export type ExchangeAggregation = ExchangePair[];
