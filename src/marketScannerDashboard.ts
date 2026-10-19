import blessed from 'blessed';
import { config } from '@/config';
import type { MarketScannerSnapshot, MarketScannerSymbolStats } from './nexus/marketScanner/types';

type ScannerDashboardMessage =
  | MarketScannerSnapshot
  | {
      type: 'market-scanner-started';
      exchangeId: string;
      sourceExchangeId?: string;
      tradableExchangeId?: string;
      symbolsCount: number;
      tradableSymbolsCount?: number;
      symbols: string[];
    }
  | {
      type: 'market-scanner-error';
      exchangeId: string;
      symbol?: string;
      error: string;
    };

class MarketScannerDashboard {
  private static readonly PANEL_GAP = 2;
  private static readonly MAX_PANEL_ENTRIES = 50;
  private static readonly MAX_LOG_LINES = 80;

  private screen: blessed.Widgets.Screen | null = null;
  private root: blessed.Widgets.BoxElement | null = null;
  private header: blessed.Widgets.BoxElement | null = null;
  private viewport: blessed.Widgets.BoxElement | null = null;
  private logPanel: blessed.Widgets.BoxElement | null = null;
  private snapshot: MarketScannerSnapshot | null = null;
  private connectionState = 'disconnected';
  private connectionMessage = '';
  private startedSymbolsCount = 0;
  private readonly startedAt = Date.now();
  private readonly logLines: string[] = [];
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private needsRender = false;

  start(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      dockBorders: true,
      title: 'SIO NEXUS - Market Scanner',
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
        border: { fg: 'green' },
      },
    });

    this.header = blessed.box({
      parent: this.root,
      top: 0,
      left: 0,
      width: '100%-2',
      height: 4,
      tags: true,
      padding: { left: 1, right: 1 },
      style: {
        fg: 'white',
        bg: 'green',
      },
      content: '',
    });

    this.viewport = blessed.box({
      parent: this.root,
      top: 4,
      left: 0,
      width: '100%-2',
      height: '100%-12',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      wrap: false,
      style: {
        bg: 'black',
        scrollbar: { bg: 'gray' },
      },
      content: '',
    });

    this.logPanel = blessed.box({
      parent: this.root,
      bottom: 0,
      left: 0,
      width: '100%-2',
      height: 8,
      tags: false,
      label: ' Events ',
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
        border: { fg: 'yellow' },
        scrollbar: { bg: 'gray' },
      },
      content: '',
    });

    this.screen.key(['C-c', 'q'], () => process.kill(process.pid, 'SIGINT'));
    this.screen.key(['up', 'k'], () => this.viewport?.scroll(-2));
    this.screen.key(['down', 'j'], () => this.viewport?.scroll(2));
    this.screen.on('resize', () => {
      this.needsRender = true;
    });

    this.renderTimer = setInterval(() => {
      if (this.needsRender) {
        this.render();
      }
    }, 250);

    this.needsRender = true;
    this.render();
  }

  stop(): void {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this.logPanel = null;
    this.viewport = null;
    this.header = null;
    this.root = null;
    this.screen?.destroy();
    this.screen = null;
  }

  setConnection(state: 'connecting' | 'connected' | 'disconnected', message = ''): void {
    this.connectionState = state;
    this.connectionMessage = message;
    this.needsRender = true;
  }

  handleMessage(message: ScannerDashboardMessage): void {
    if (message.type === 'market-scanner-snapshot') {
      this.snapshot = message;
    } else if (message.type === 'market-scanner-started') {
      this.startedSymbolsCount = message.symbolsCount;
      const tradableLabel =
        message.tradableExchangeId && message.tradableSymbolsCount !== undefined
          ? ` filtered by ${message.tradableExchangeId} (${message.tradableSymbolsCount} tradable)`
          : '';
      this.appendLog(
        `${message.sourceExchangeId ?? message.exchangeId}${tradableLabel} started with ${message.symbolsCount} source symbols`
      );
    } else if (message.type === 'market-scanner-error') {
      this.appendLog(
        `${message.exchangeId}${message.symbol ? ` ${message.symbol}` : ''}: ${message.error}`
      );
    }
    this.needsRender = true;
  }

  private render(): void {
    if (!this.screen || !this.header || !this.viewport || !this.logPanel) {
      return;
    }

    const now = Date.now();
    const uptimeSec = Math.floor((now - this.startedAt) / 1000);
    const snapshot = this.snapshot;
    const exchangeId = snapshot?.exchangeId || 'market scanner';
    const symbolsCount = Math.max(snapshot?.symbolsCount ?? 0, this.startedSymbolsCount);
    const activeCount = snapshot?.activeSymbolsCount ?? 0;
    const totalFlow = this.formatCompactMoney(snapshot?.totals.totalCost ?? 0);
    const tps = snapshot?.totals.tradesPerSecond.toFixed(2) ?? '0.00';

    this.header.setContent(
      `{bold}SIO NEXUS MARKET SCANNER{/bold}  {black-fg}{white-bg} ${exchangeId.toUpperCase()} {/white-bg}{/black-fg}\n` +
        `Socket ${this.connectionState} ${this.connectionMessage} | Uptime ${uptimeSec}s\n` +
        `Symbols ${symbolsCount} | Active ${activeCount} | T/S ${tps} | Flow ${totalFlow}`
    );

    const width = Math.max(90, (Number(this.screen.width) || 120) - 4);
    this.viewport.setContent(this.formatSnapshot(snapshot, width));
    this.logPanel.setContent(
      this.logLines.length === 0 ? 'No events yet.' : this.logLines.join('\n')
    );
    this.logPanel.setScrollPerc(100);
    this.screen.render();
    this.needsRender = false;
  }

  private formatSnapshot(snapshot: MarketScannerSnapshot | null, width: number): string {
    if (!snapshot) {
      return 'Waiting for scanner snapshots...';
    }

    const panelWidth = Math.max(42, Math.floor((width - MarketScannerDashboard.PANEL_GAP) / 2));
    const gainers = [...snapshot.symbols]
      .filter((stats) => stats.tradeCount > 0)
      .sort((a, b) => b.priceChange5mPct - a.priceChange5mPct)
      .slice(0, MarketScannerDashboard.MAX_PANEL_ENTRIES);
    const losers = [...snapshot.symbols]
      .filter((stats) => stats.tradeCount > 0)
      .sort((a, b) => a.priceChange5mPct - b.priceChange5mPct)
      .slice(0, MarketScannerDashboard.MAX_PANEL_ENTRIES);

    const panels = [
      this.formatPanel('Gainers 5m', gainers, panelWidth),
      this.formatPanel('Losers 5m', losers, panelWidth),
    ];
    const lines: string[] = [];
    const rows = Math.max(...panels.map((panel) => panel.length));

    for (let i = 0; i < rows; i++) {
      lines.push(
        panels
          .map((panel) => panel[i] ?? ' '.repeat(panelWidth))
          .join(' '.repeat(MarketScannerDashboard.PANEL_GAP))
      );
    }

    lines.push('');
    lines.push(
      `Window ${Math.round(snapshot.windowMs / 1000)}s | Buy ${this.formatCompactMoney(snapshot.totals.buyCost)} | Sell ${this.formatCompactMoney(snapshot.totals.sellCost)} | Net ${this.formatSignedMoney(snapshot.totals.netCost)}`
    );

    return lines.join('\n');
  }

  private formatPanel(title: string, symbols: MarketScannerSymbolStats[], width: number): string[] {
    const contentWidth = width - 4;
    const border = `+${'-'.repeat(width - 2)}+`;
    const pctWidth = contentWidth >= 70 ? 7 : 5;
    const priceWidth = contentWidth >= 70 ? 12 : 8;
    const tpsWidth = contentWidth >= 70 ? 7 : 5;
    const deltaVolumeWidth = contentWidth >= 70 ? 10 : 7;
    const symbolWidth = Math.max(
      4,
      contentWidth - priceWidth - pctWidth * 4 - tpsWidth - deltaVolumeWidth - 7
    );
    const lines = [
      border,
      `| ${this.truncate(title, contentWidth).padEnd(contentWidth)} |`,
      border,
      `| ${this.formatHeaderRow(symbolWidth, priceWidth, pctWidth, tpsWidth, deltaVolumeWidth).padEnd(contentWidth)} |`,
    ];

    for (const stats of symbols) {
      const deltaVolume = stats.buyVolume - stats.sellVolume;
      const row = [
        this.truncate(stats.symbol, symbolWidth).padEnd(symbolWidth),
        this.truncate(this.formatPriceCell(stats.lastPrice), priceWidth).padStart(priceWidth),
        this.formatPctCell(stats.priceChangePct, pctWidth),
        this.formatPctCell(stats.priceChange5mPct, pctWidth),
        this.formatPctCell(stats.priceChange15mPct, pctWidth),
        this.formatPctCell(stats.priceChange1hPct, pctWidth),
        this.formatTradesPerSecondCell(stats.tradesPerSecond, tpsWidth),
        this.truncate(this.formatSignedCompactNumber(deltaVolume), deltaVolumeWidth).padStart(
          deltaVolumeWidth
        ),
      ].join(' ');
      lines.push(`| ${this.truncate(row, contentWidth).padEnd(contentWidth)} |`);
    }

    if (symbols.length === 0) {
      lines.push(`| ${'No trades in window'.padEnd(contentWidth)} |`);
    }

    lines.push(border);
    return lines;
  }

  private formatHeaderRow(
    symbolWidth: number,
    priceWidth: number,
    pctWidth: number,
    tpsWidth: number,
    deltaVolumeWidth: number
  ): string {
    return [
      'Symbol'.padEnd(symbolWidth),
      'Price'.padStart(priceWidth),
      'RT'.padStart(pctWidth),
      '5m'.padStart(pctWidth),
      '15m'.padStart(pctWidth),
      '1h'.padStart(pctWidth),
      'T/S'.padStart(tpsWidth),
      'dVol'.padStart(deltaVolumeWidth),
    ].join(' ');
  }

  private appendLog(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    this.logLines.push(`[${timestamp}] ${message}`);
    if (this.logLines.length > MarketScannerDashboard.MAX_LOG_LINES) {
      this.logLines.splice(0, this.logLines.length - MarketScannerDashboard.MAX_LOG_LINES);
    }
  }

  private formatPrice(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return 'n/a';
    if (value >= 1000) return value.toFixed(2);
    if (value >= 1) return value.toFixed(4);
    return value.toFixed(8);
  }

  private formatPriceCell(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return 'n/a';
    if (value >= 100_000) return `${(value / 1_000).toFixed(0)}K`;
    if (value >= 10_000) return value.toFixed(0);
    if (value >= 1000) return value.toFixed(1);
    if (value >= 1) return value.toFixed(2);
    return value.toPrecision(3);
  }

  private formatPctCell(value: number, width: number): string {
    if (!Number.isFinite(value)) return 'n/a'.padStart(width);
    if (value >= 100) return '999+'.padStart(width);
    if (value <= -100) return '-999'.padStart(width);
    const decimals = width >= 7 && Math.abs(value) < 10 ? 2 : 1;
    const formatted = `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}`;
    return this.truncate(formatted, width).padStart(width);
  }

  private formatTradesPerSecondCell(value: number, width: number): string {
    if (!Number.isFinite(value)) return 'n/a'.padStart(width);
    const formatted = value >= 100 ? value.toFixed(0) : value.toFixed(1);
    return this.truncate(formatted, width).padStart(width);
  }

  private formatSignedCompactNumber(value: number): string {
    if (!Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    let formatted: string;
    if (abs >= 1_000_000_000) {
      formatted = `${(abs / 1_000_000_000).toFixed(2)}B`;
    } else if (abs >= 1_000_000) {
      formatted = `${(abs / 1_000_000).toFixed(2)}M`;
    } else if (abs >= 1_000) {
      formatted = `${(abs / 1_000).toFixed(2)}K`;
    } else if (abs >= 100) {
      formatted = abs.toFixed(0);
    } else if (abs >= 1) {
      formatted = abs.toFixed(2);
    } else {
      formatted = abs.toPrecision(3);
    }
    return value >= 0 ? `+${formatted}` : `-${formatted}`;
  }

  private formatCompactMoney(value: number): string {
    if (!Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return value.toFixed(2);
  }

  private formatSignedMoney(value: number): string {
    const formatted = this.formatCompactMoney(Math.abs(value));
    return value >= 0 ? `+${formatted}` : `-${formatted}`;
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    if (maxLength <= 3) return value.slice(0, maxLength);
    return `${value.slice(0, maxLength - 3)}...`;
  }
}

class MarketScannerDashboardApp {
  private readonly socketPath = config.socket.scannerSocketPath;
  private readonly dashboard = new MarketScannerDashboard();
  private readonly decoder = new TextDecoder();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private buffer = '';
  private stopped = false;
  private socket: Bun.Socket<undefined> | null = null;

  async start(): Promise<void> {
    this.dashboard.start();
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.end();
    this.socket = null;
    this.dashboard.stop();
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.dashboard.setConnection('connecting', `(${this.socketPath})`);

    try {
      this.socket = await Bun.connect<undefined>({
        unix: this.socketPath,
        socket: {
          open: () => {
            this.dashboard.setConnection('connected', `(${this.socketPath})`);
          },
          data: (_socket, data) => {
            this.onData(data);
          },
          close: () => {
            this.dashboard.setConnection('disconnected', '(socket closed)');
            this.scheduleReconnect();
          },
          error: () => {
            this.dashboard.setConnection('disconnected', '(socket error)');
            this.scheduleReconnect();
          },
        },
      });
    } catch (error) {
      this.dashboard.setConnection('disconnected', `(connect failed: ${String(error)})`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
  }

  private onData(data: Buffer | Uint8Array): void {
    this.buffer += this.decoder.decode(data);
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as ScannerDashboardMessage;
      if (typeof parsed.type !== 'string') {
        return;
      }
      this.dashboard.handleMessage(parsed);
    } catch {
      // Ignore malformed lines.
    }
  }
}

export async function runMarketScannerDashboard(): Promise<void> {
  const app = new MarketScannerDashboardApp();
  const shutdown = () => app.stop();

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.start();
  await new Promise(() => {});
}

if (import.meta.main) {
  runMarketScannerDashboard().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
