import ansis from 'ansis';

type FormatMoneyOptions = {
  currency: string;
  colorize: boolean;
  withIcon: boolean;
};

export function formatMoney(amount: number, options?: Partial<FormatMoneyOptions>): string {
  const defaultOptions: FormatMoneyOptions = {
    currency: 'USD',
    colorize: true,
    withIcon: true,
  };

  options = { ...defaultOptions, ...options };

  const money = Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: options.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  if (options.colorize) {
    if (amount > 0) {
      return `${options.withIcon ? '💵' : ''} ${ansis.green(money)}`;
    } else if (amount < 0) {
      return `${options.withIcon ? '💵' : ''} ${ansis.red(money)}`;
    }
  }
  return `${options.withIcon ? '💵' : ''} ${money}`;
}
