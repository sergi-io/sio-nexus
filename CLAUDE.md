# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SIO-Nexus is a cryptocurrency tick/klines data aggregator backend server that ingests real-time trading data from multiple crypto exchanges (Binance, Coinbase, OKEx, MEXC, Huobi, Phemex) and provides unified data access.

**Runtime**: Bun (not Node.js) - always use `bun` instead of `npm`

## Commands

```bash
# Development (hot-reload)
bun run --watch src/main.ts run

# Build Linux x64 binary
bun build --compile --minify --target=bun-linux-x64 --bytecode --root src --outfile build/x64/sio-nexus ./src/main.ts

# Type check
tsc --noEmit

# Lint (zero warnings policy)
eslint ./src --max-warnings=0

# Test
bun test

# Deploy to remote server
sh scripts/deploy.sh
```

## Architecture

### Master-Worker Model

The system uses a master-worker threading model for concurrent exchange monitoring:

- **Main Thread (NexusServer)**: Singleton that coordinates worker threads, processes aggregated messages, and manages configuration
- **Worker Threads**: Each exchange runs in its own isolated Bun Worker for true parallelism
- **Communication**: Workers send structured messages (trade events, errors, status) to main thread via `postMessage()`

### Data Flow

```
Crypto Exchanges → Worker Threads (CCXT Pro) → Main Thread → SQLite / Console
```

### Key Components

- **`src/nexus/NexusServer.ts`**: Main orchestrator, spawns workers per exchange, processes incoming trade messages
- **`src/nexus/NexusConfig.ts`**: Dynamic configuration loader from `nexus-config.json`
- **`src/domain/`**: Core types (SIOKline for candlestick data, SIOTimeFrame for intervals, SIOExchange abstract base)
- **`src/utils/db/`**: SQLite with Bun native binding, optimized with WAL mode and memory mapping
- **`src/exchanges/`**: Reserved for exchange implementations (currently empty)

### Database

- SQLite with performance pragmas (WAL, memory mapping, caching)
- Table naming convention: `{symbol}_{timeframe}` (e.g., `SOL/USDT_1h`)
- Batch insertion with transaction support
- Connections auto-register with graceful shutdown handler

## Configuration

Environment variables (see `.env-sample`):

- `SIO_NEXUS_ENV`: dev|prod
- `SIO_NEXUS_LOG_LEVEL`: fatal|error|warn|info|debug|trace
- `SIO_NEXUS_WRITE_LOG_TO_FILES`: true|false

Runtime config via `nexus-config.json` loaded at startup.

## Path Aliases

TypeScript path alias configured: `@/*` → `./src/*`
