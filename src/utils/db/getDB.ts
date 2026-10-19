import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import { registerGracefulShutdown } from '../gracefulShutdown';
import { ensureFolderInPath } from '../folders';

export function getDB(sqlitePath: string): Database {
  ensureFolderInPath(sqlitePath);
  const dbPath = path.resolve(sqlitePath);
  const firstOpen = !fs.existsSync(dbPath);

  const db = new Database(dbPath, { strict: true, create: true, readonly: false });
  const originalClose = db.close.bind(db);
  let closed = false;

  const closeDb = () => {
    if (closed) {
      return;
    }
    closed = true;
    originalClose();
  };

  const unregisterShutdown = registerGracefulShutdown(closeDb);

  // Preserve original close semantics while ensuring the shutdown hook is cleaned up.
  db.close = () => {
    closeDb();
    unregisterShutdown();
  };

  if (firstOpen) {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run('PRAGMA temp_store = MEMORY;');
    db.run('PRAGMA locking_mode = NORMAL;');
  }

  // Always set these pragmas for each connection (some are connection-scoped)

  db.run('PRAGMA busy_timeout = 30000;'); // Increased timeout for concurrent access
  db.run('PRAGMA cache_size = -64000;'); // 64MB cache for better read performance
  db.run('PRAGMA mmap_size = 268435456;'); // 256MB memory-mapped I/O for faster reads
  db.run('PRAGMA read_uncommitted = ON;'); // Allow reading without waiting for locks (safe for read-heavy workloads)

  return db;
}
