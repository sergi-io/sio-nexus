import blessed from 'blessed';

type PriceEntry = {
  price: number;
  updatedAt: number;
};

const RENDER_INTERVAL_MS = 100;

export class TerminalPriceDashboard {
  private static readonly MIN_CARD_WIDTH = 34;
  private static readonly CARD_GAP = 2;
  private static readonly CARD_HEIGHT = 8;
  private static readonly MAX_SYMBOLS_PER_CARD = 6;
  private static readonly LOG_PANEL_HEIGHT = 8;
  private static readonly MAX_LOG_LINES = 200;
  private static readonly TPS_WINDOW_MS = 10_000;

  private readonly enabled: boolean;
  private readonly pricesByExchange = new Map<string, Map<string, PriceEntry>>();
  private readonly latestErrorByExchange = new Map<string, string>();
  private readonly tradeTimestampsByExchange = new Map<string, number[]>();
  private readonly allExchanges = new Set<string>();
  private readonly startedAt = Date.now();
  private screen: blessed.Widgets.Screen | null = null;
  private root: blessed.Widgets.BoxElement | null = null;
  private header: blessed.Widgets.BoxElement | null = null;
  private grid: blessed.Widgets.BoxElement | null = null;
  private logPanel: blessed.Widgets.BoxElement | null = null;
  private readonly exchangeCards = new Map<string, blessed.Widgets.BoxElement>();
  private readonly logLines: string[] = [];
  private renderInterval: ReturnType<typeof setInterval> | null = null;
  private needsRender = false;

  constructor() {
    this.enabled = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  }

  public get isActive(): boolean {
    return this.screen !== null;
  }

  public start(exchangeIds: string[]): void {
    if (!this.enabled || this.screen) {
      return;
    }

    for (const exchangeId of exchangeIds) {
      this.allExchanges.add(exchangeId);
    }

    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      dockBorders: true,
      title: 'SIO NEXUS - Real-time Prices',
    });

    this.root = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'blue',
        },
      },
    });

    this.header = blessed.box({
      parent: this.root,
      top: 0,
      left: 0,
      width: '100%-2',
      height: 3,
      tags: true,
      padding: { left: 1, right: 1 },
      style: {
        fg: 'white',
        bg: 'blue',
      },
      content: '',
    });

    this.grid = blessed.box({
      parent: this.root,
      top: 3,
      left: 0,
      width: '100%-2',
      height: `100%-${TerminalPriceDashboard.LOG_PANEL_HEIGHT + 5}`,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      style: {
        bg: 'black',
        scrollbar: {
          bg: 'gray',
        },
      },
    });

    this.logPanel = blessed.box({
      parent: this.root,
      bottom: 0,
      left: 0,
      width: '100%-2',
      height: TerminalPriceDashboard.LOG_PANEL_HEIGHT,
      tags: false,
      label: ' Log ',
      border: { type: 'line' },
      padding: { left: 1, right: 1 },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'red',
        },
        scrollbar: {
          bg: 'gray',
        },
      },
      content: '',
    });

    this.screen.key(['C-c', 'q'], () => {
      process.kill(process.pid, 'SIGINT');
    });
    this.screen.key(['up', 'k'], () => this.grid?.scroll(-2));
    this.screen.key(['down', 'j'], () => this.grid?.scroll(2));
    this.screen.key(['S-up', 'S-k'], () => this.logPanel?.scroll(-2));
    this.screen.key(['S-down', 'S-j'], () => this.logPanel?.scroll(2));
    this.screen.on('resize', () => {
      this.needsRender = true;
    });

    this.renderInterval = setInterval(() => {
      if (!this.needsRender) {
        return;
      }
      this.render();
    }, RENDER_INTERVAL_MS);

    this.needsRender = true;
    this.render();
  }

  public updatePrice(exchangeId: string, symbol: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }

    this.allExchanges.add(exchangeId);
    this.trackTrade(exchangeId);
    this.clearErrorOnRecovery(exchangeId, 'trade stream resumed');
    const exchangePrices = this.getOrCreateExchangePrices(exchangeId);
    exchangePrices.set(symbol, { price, updatedAt: Date.now() });
    this.needsRender = true;
  }

  public markStarted(exchangeId: string): void {
    this.allExchanges.add(exchangeId);
    this.appendLog(exchangeId, 'info', 'worker started');
    this.clearErrorOnRecovery(exchangeId, 'worker started');
    this.needsRender = true;
  }

  public markError(exchangeId: string, error: string): void {
    this.allExchanges.add(exchangeId);
    this.latestErrorByExchange.set(exchangeId, error);
    this.appendLog(exchangeId, 'error', error);
    this.needsRender = true;
  }

  public markInfo(exchangeId: string, message: string): void {
    this.allExchanges.add(exchangeId);
    this.appendLog(exchangeId, 'info', message);
    this.needsRender = true;
  }

  public stop(): void {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    for (const card of this.exchangeCards.values()) {
      card.destroy();
    }
    this.exchangeCards.clear();
    this.logPanel = null;
    this.grid = null;
    this.header = null;
    this.root = null;
    this.screen?.destroy();
    this.screen = null;
    this.needsRender = false;
  }

  private render(): void {
    if (!this.screen || !this.header || !this.grid || !this.logPanel) {
      return;
    }

    const now = Date.now();
    const uptimeSec = Math.floor((now - this.startedAt) / 1000);
    this.header.setContent(
      `{bold}SIO NEXUS{/bold}  {black-fg}{white-bg} LIVE {/white-bg}{/black-fg}\n` +
        `Uptime {bold}${uptimeSec}s{/bold}  |  Exchanges {bold}${this.allExchanges.size}{/bold}  |  Scroll j/k or arrows`
    );

    const terminalWidth = Math.max(60, Number(this.screen.width) || 120);
    const maxColumns = Math.max(
      1,
      Math.floor(
        (terminalWidth + TerminalPriceDashboard.CARD_GAP) /
          (TerminalPriceDashboard.MIN_CARD_WIDTH + TerminalPriceDashboard.CARD_GAP)
      )
    );
    const cardWidth = Math.max(
      TerminalPriceDashboard.MIN_CARD_WIDTH,
      Math.floor((terminalWidth - TerminalPriceDashboard.CARD_GAP * (maxColumns - 1)) / maxColumns)
    );
    const exchangeCards = Array.from(this.allExchanges)
      .sort()
      .map((exchangeId) => {
        const card = this.getOrCreateExchangeCard(exchangeId);
        card.width = cardWidth;
        card.height = TerminalPriceDashboard.CARD_HEIGHT;
        return { exchangeId, card };
      });

    const activeExchangeIds = new Set(exchangeCards.map((entry) => entry.exchangeId));
    for (const [exchangeId, card] of this.exchangeCards.entries()) {
      if (!activeExchangeIds.has(exchangeId)) {
        card.destroy();
        this.exchangeCards.delete(exchangeId);
      }
    }

    for (const [i, exchangeCard] of exchangeCards.entries()) {
      const { exchangeId, card } = exchangeCard;
      const column = i % maxColumns;
      const row = Math.floor(i / maxColumns);
      const top = row * (TerminalPriceDashboard.CARD_HEIGHT + 1);
      const left = column * (cardWidth + TerminalPriceDashboard.CARD_GAP);
      card.top = top;
      card.left = left;

      const { content, borderColor, label } = this.formatExchangeCard(exchangeId, now, cardWidth);
      card.setLabel(` ${label} `);
      card.style.border = { fg: borderColor };
      card.setContent(content);
    }

    this.grid.height = Math.max(
      3,
      Number(this.screen.height) - (TerminalPriceDashboard.LOG_PANEL_HEIGHT + 5)
    );
    this.grid.setLabel('');
    this.logPanel.setContent(this.logLines.length === 0 ? 'No logs yet.' : this.logLines.join('\n'));
    this.logPanel.setScrollPerc(100);

    this.screen.render();
    this.needsRender = false;
  }

  private appendLog(exchangeId: string, level: 'info' | 'error', message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    const lines = String(message)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const prefix = `[${timestamp}] [${exchangeId}] [${level}]`;

    if (lines.length === 0) {
      this.logLines.push(`${prefix} <empty message>`);
    } else {
      const [firstLine, ...rest] = lines;
      this.logLines.push(`${prefix} ${firstLine}`);
      for (const line of rest) {
        this.logLines.push(`  ${line}`);
      }
    }

    if (this.logLines.length > TerminalPriceDashboard.MAX_LOG_LINES) {
      this.logLines.splice(
        0,
        this.logLines.length - TerminalPriceDashboard.MAX_LOG_LINES
      );
    }
  }

  private clearErrorOnRecovery(exchangeId: string, reason: string): void {
    if (!this.latestErrorByExchange.has(exchangeId)) {
      return;
    }
    this.latestErrorByExchange.delete(exchangeId);
    this.appendLog(exchangeId, 'info', `recovered: ${reason}`);
  }

  private getOrCreateExchangeCard(exchangeId: string): blessed.Widgets.BoxElement {
    const existing = this.exchangeCards.get(exchangeId);
    if (existing) {
      return existing;
    }

    if (!this.grid) {
      throw new Error('Grid not initialized');
    }

    const card = blessed.box({
      parent: this.grid,
      top: 0,
      left: 0,
      width: TerminalPriceDashboard.MIN_CARD_WIDTH,
      height: TerminalPriceDashboard.CARD_HEIGHT,
      tags: true,
      border: { type: 'line' },
      padding: { left: 1, right: 1 },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'gray',
        },
      },
      content: '',
    });

    this.exchangeCards.set(exchangeId, card);
    return card;
  }

  private formatExchangeCard(
    exchangeId: string,
    now: number,
    cardWidth: number
  ): { content: string; borderColor: string; label: string } {
    const contentWidth = cardWidth - 4;
    const bodyLines: string[] = [];
    const line = (value: string): string => this.truncate(value, contentWidth).padEnd(contentWidth);
    let borderColor = 'yellow';

    const prices = this.pricesByExchange.get(exchangeId);
    const totalPrices = prices?.size ?? 0;
    bodyLines.push(line(`Symbols: ${totalPrices}`));

    const error = this.latestErrorByExchange.get(exchangeId);
    if (error) {
      borderColor = 'red';
      bodyLines.push(`{red-fg}${line(`Error: ${error}`)}{/red-fg}`);
    }

    if (!prices || prices.size === 0) {
      bodyLines.push(`{yellow-fg}${line('Waiting for trades...')}{/yellow-fg}`);
    } else {
      if (!error) {
        borderColor = 'green';
      }
      const sortedPrices = Array.from(prices.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [symbol, entry] of sortedPrices.slice(
        0,
        TerminalPriceDashboard.MAX_SYMBOLS_PER_CARD
      )) {
        const ageSec = Math.floor((now - entry.updatedAt) / 1000);
        const symbolLabel = this.truncate(symbol, 12).padEnd(12);
        const priceLabel = this.formatPrice(entry.price).padStart(11);
        const ageColor = ageSec < 3 ? 'green' : ageSec < 10 ? 'yellow' : 'red';
        const row = line(`${symbolLabel} ${priceLabel} ${ageSec}s`);
        bodyLines.push(`{${ageColor}-fg}${row}{/${ageColor}-fg}`);
      }

      if (sortedPrices.length > TerminalPriceDashboard.MAX_SYMBOLS_PER_CARD) {
        bodyLines.push(
          `{cyan-fg}${line(`+${sortedPrices.length - TerminalPriceDashboard.MAX_SYMBOLS_PER_CARD} more`)}{/cyan-fg}`
        );
      }
    }

    while (bodyLines.length < TerminalPriceDashboard.CARD_HEIGHT - 2) {
      bodyLines.push(line(''));
    }

    return {
      content: bodyLines.slice(0, TerminalPriceDashboard.CARD_HEIGHT - 2).join('\n'),
      borderColor,
      label: `${exchangeId.toUpperCase()} | t/s ${this.formatTradesPerSecond(exchangeId, now)}`,
    };
  }

  private getOrCreateExchangePrices(exchangeId: string): Map<string, PriceEntry> {
    let exchangePrices = this.pricesByExchange.get(exchangeId);
    if (!exchangePrices) {
      exchangePrices = new Map<string, PriceEntry>();
      this.pricesByExchange.set(exchangeId, exchangePrices);
    }
    return exchangePrices;
  }

  private formatPrice(price: number): string {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(8);
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    if (maxLength <= 3) {
      return value.slice(0, maxLength);
    }
    return `${value.slice(0, maxLength - 3)}...`;
  }

  private trackTrade(exchangeId: string): void {
    const now = Date.now();
    const timestamps = this.tradeTimestampsByExchange.get(exchangeId) ?? [];
    timestamps.push(now);
    this.pruneTradeTimestamps(timestamps, now);
    this.tradeTimestampsByExchange.set(exchangeId, timestamps);
  }

  private formatTradesPerSecond(exchangeId: string, now: number): string {
    const timestamps = this.tradeTimestampsByExchange.get(exchangeId);
    if (!timestamps || timestamps.length === 0) {
      return '0.00';
    }

    this.pruneTradeTimestamps(timestamps, now);
    const tps = timestamps.length / (TerminalPriceDashboard.TPS_WINDOW_MS / 1000);
    return tps.toFixed(2);
  }

  private pruneTradeTimestamps(timestamps: number[], now: number): void {
    const cutoff = now - TerminalPriceDashboard.TPS_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
  }
}
