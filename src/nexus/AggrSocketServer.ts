import { existsSync, unlinkSync } from 'fs';
import type { Socket } from 'bun';
import { config } from '@/config';

export class AggrSocketServer {
  private server: ReturnType<typeof Bun.listen> | null = null;
  private readonly clients = new Set<Socket<undefined>>();
  private readonly writeQueues = new Map<Socket<undefined>, string>();

  start(): void {
    const socketPath = config.socket.aggrSocketPath;

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

    console.log(`[UnixSocket] Listening on ${socketPath}`);
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

  broadcast(data: object): void {
    if (this.clients.size === 0) return;

    const line = JSON.stringify(data) + '\n';
    for (const client of this.clients) {
      this.send(client, line);
    }
  }

  close(): void {
    this.server?.stop(true);
    const socketPath = config.socket.aggrSocketPath;
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  }
}
