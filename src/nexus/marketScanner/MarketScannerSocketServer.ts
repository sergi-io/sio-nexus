import { existsSync, unlinkSync } from 'fs';
import type { Socket } from 'bun';
import { config } from '@/config';
import { registerGracefulShutdown } from '@/utils/gracefulShutdown';

export class MarketScannerSocketServer {
  private server: ReturnType<typeof Bun.listen> | null = null;
  private readonly clients = new Set<Socket<undefined>>();
  private readonly writeQueues = new Map<Socket<undefined>, string>();
  private unregisterShutdown: (() => void) | null = null;

  start(): void {
    const socketPath = config.socket.scannerSocketPath;

    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    this.server = Bun.listen<undefined>({
      unix: socketPath,
      socket: {
        open: (socket) => {
          this.clients.add(socket);
        },
        close: (socket) => {
          this.clients.delete(socket);
          this.writeQueues.delete(socket);
        },
        data: () => {},
        drain: (socket) => {
          this.flushWriteQueue(socket);
        },
        error: (socket) => {
          this.clients.delete(socket);
          this.writeQueues.delete(socket);
        },
      },
    });

    this.unregisterShutdown = registerGracefulShutdown(() => this.close());

    console.log(`[MarketScannerSocket] Listening on ${socketPath}`);
  }

  broadcast(data: object): void {
    if (this.clients.size === 0) return;

    const line = JSON.stringify(data) + '\n';
    for (const client of this.clients) {
      this.send(client, line);
    }
  }

  close(): void {
    this.unregisterShutdown?.();
    this.server?.stop(true);
    const socketPath = config.socket.scannerSocketPath;
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  }

  private send(socket: Socket<undefined>, line: string): void {
    try {
      const queued = this.writeQueues.get(socket);

      if (queued !== undefined) {
        this.writeQueues.set(socket, queued + line);
        return;
      }

      const written = socket.write(line);
      if (written < line.length) {
        this.writeQueues.set(socket, line.slice(written));
      }
    } catch {
      this.clients.delete(socket);
      this.writeQueues.delete(socket);
    }
  }

  private flushWriteQueue(socket: Socket<undefined>): void {
    const queued = this.writeQueues.get(socket);
    if (!queued) return;

    const written = socket.write(queued);
    if (written >= queued.length) {
      this.writeQueues.delete(socket);
    } else {
      this.writeQueues.set(socket, queued.slice(written));
    }
  }
}
