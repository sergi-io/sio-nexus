import blessed from 'blessed';
import { config } from '@/config';

type AggrSocketEvent = {
  pair: string;
  timeframe: string;
  type: 'delta' | 'full';
  timestamp: number;
  close: number;
  tradeCount: number;
  buyCost: number;
  sellCost: number;
};

type PairEntry = {
  close: number;
  tradeCount: number;
  timestamp: number;
  updatedAt: number;
  buyCost: number;
  sellCost: number;
};

class AggregationDashboard {
  private static readonly MIN_CARD_WIDTH = 36;
  private static readonly CARD_GAP = 2;
  private static readonly CARD_HEIGHT = 7;

  private readonly pairs = new Map<string, PairEntry>();
  private screen: blessed.Widgets.Screen | null = null;
  private viewport: blessed.Widgets.BoxElement | null = null;
  private needsRender = false;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private connectionState = 'disconnected';
  private connectionMessage = '';
  private readonly startedAt = Date.now();

  start(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: 'SIO NEXUS Dashboard',
    });

    this.viewport = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: 'line',
      style: {
        border: { fg: 'cyan' },
      },
      content: '',
    });

    this.screen.key(['C-c', 'q'], () => process.kill(process.pid, 'SIGINT'));
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
    this.viewport = null;
    this.screen?.destroy();
    this.screen = null;
  }

  setConnection(state: 'connecting' | 'connected' | 'disconnected', message = ''): void {
    this.connectionState = state;
    this.connectionMessage = message;
    this.needsRender = true;
  }

  update(event: AggrSocketEvent): void {
    if (event.timeframe !== '10s') {
      return;
    }

    this.pairs.set(event.pair, {
      close: event.close,
      tradeCount: event.tradeCount,
      timestamp: event.timestamp,
      updatedAt: Date.now(),
      buyCost: event.buyCost,
      sellCost: event.sellCost,
    });
    this.needsRender = true;
  }

  private render(): void {
    if (!this.screen || !this.viewport) {
      return;
    }

    const now = Date.now();
    const uptimeSec = Math.floor((now - this.startedAt) / 1000);
    const lines: string[] = [
      'SIO NEXUS - Aggregation Dashboard',
      `Socket: ${this.connectionState} ${this.connectionMessage} | Uptime: ${uptimeSec}s | Pairs: ${this.pairs.size} | q/Ctrl+C exit`,
      '',
    ];

    const width = Number(this.screen.width) || 120;
    const columns = Math.max(
      1,
      Math.floor(
        (width + AggregationDashboard.CARD_GAP) /
          (AggregationDashboard.MIN_CARD_WIDTH + AggregationDashboard.CARD_GAP)
      )
    );
    const cardWidth = Math.max(
      AggregationDashboard.MIN_CARD_WIDTH,
      Math.floor((width - AggregationDashboard.CARD_GAP * (columns - 1)) / columns)
    );

    const cards = Array.from(this.pairs.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pair, entry]) => this.formatCard(pair, entry, now, cardWidth));

    for (let i = 0; i < cards.length; i += columns) {
      const row = cards.slice(i, i + columns);
      const rowHeight = row.reduce((max, card) => Math.max(max, card.length), 0);
      for (let line = 0; line < rowHeight; line += 1) {
        lines.push(
          row
            .map((card) => card[line] ?? ' '.repeat(cardWidth))
            .join(' '.repeat(AggregationDashboard.CARD_GAP))
        );
      }
      lines.push('');
    }

    this.viewport.setContent(lines.join('\n'));
    this.screen.render();
    this.needsRender = false;
  }

  private formatCard(pair: string, entry: PairEntry, now: number, cardWidth: number): string[] {
    const contentWidth = cardWidth - 4;
    const border = `+${'-'.repeat(cardWidth - 2)}+`;
    const ageSec = Math.floor((now - entry.updatedAt) / 1000);
    const tps = (entry.tradeCount / 10).toFixed(2);
    const netCost = entry.buyCost - entry.sellCost;
    const line = (value: string): string =>
      `| ${this.truncate(value, contentWidth).padEnd(contentWidth)} |`;

    return [
      border,
      line(`${pair} | T/S ${tps}`),
      line(`Close: ${this.formatPrice(entry.close)}`),
      line(`Trades(10s): ${entry.tradeCount}`),
      line(`Net Cost: ${this.formatSigned(netCost)}`),
      line(`Age: ${ageSec}s`),
      border,
    ];
  }

  private formatPrice(value: number): string {
    if (!Number.isFinite(value)) return 'n/a';
    if (value >= 1000) return value.toFixed(2);
    if (value >= 1) return value.toFixed(4);
    return value.toFixed(8);
  }

  private formatSigned(value: number): string {
    if (!Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    const formatted = abs >= 1000 ? abs.toFixed(2) : abs.toFixed(4);
    return value >= 0 ? `+${formatted}` : `-${formatted}`;
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    if (maxLength <= 3) return value.slice(0, maxLength);
    return `${value.slice(0, maxLength - 3)}...`;
  }
}

class AggrSocketDashboardApp {
  private readonly socketPath = config.socket.aggrSocketPath;
  private readonly dashboard = new AggregationDashboard();
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
      const parsed = JSON.parse(line) as Partial<AggrSocketEvent>;
      if (
        typeof parsed.pair !== 'string' ||
        typeof parsed.timeframe !== 'string' ||
        typeof parsed.type !== 'string' ||
        typeof parsed.timestamp !== 'number' ||
        typeof parsed.close !== 'number' ||
        typeof parsed.tradeCount !== 'number' ||
        typeof parsed.buyCost !== 'number' ||
        typeof parsed.sellCost !== 'number'
      ) {
        return;
      }

      this.dashboard.update(parsed as AggrSocketEvent);
    } catch {
      // Ignore malformed lines.
    }
  }
}

async function main(): Promise<void> {
  const app = new AggrSocketDashboardApp();
  const shutdown = () => app.stop();

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.start();
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
