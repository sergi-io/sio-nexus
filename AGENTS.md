# Repository Guidelines

## Project Structure & Module Organization
- `src/main.ts`: CLI entrypoint (`run` command) that boots the Nexus server.
- `src/nexus/`: runtime server components (`NexusServer`, socket servers, exchange worker, aggregation pipeline).
- `src/nexus/aggregator/`: tick-to-kline buffering and bucket logic.
- `src/domain/`: core domain models like `SIOKline` and `SIOTimeFrame`.
- `src/utils/`: shared helpers (logging, shutdown, symbols, DB utilities).
- `data/`: local runtime data (for example SQLite files).
- `build/`: compiled binary output (`build/x64/sio-nexus`).
- `scripts/`: deployment and service files (`deploy.sh`, `sio-nexus.service`).

## Build, Test, and Development Commands
- `bun run dev`: run with watch mode from `src/main.ts`.
- `bun run test`: run Bun tests.
- `bun run typecheck`: strict TypeScript checks with no emit.
- `bun run lint`: lint `src` with ESLint (`--max-warnings=0`).
- `bun run build`: compile/minify Bun Linux x64 binary into `build/x64/`.
- `bun run clean`: remove `build/` and `logs/`.
- `bun run deploy`: typecheck + build + rsync deployment + remote service restart.

## Coding Style & Naming Conventions
- Language/runtime: TypeScript (ESM) on Bun.
- Indentation: 2 spaces, LF endings, final newline (`.editorconfig`).
- Formatting: Prettier (`singleQuote: true`, `semi: true`, `printWidth: 100`).
- Linting: ESLint + `@typescript-eslint`; keep warnings at zero for CI parity.
- Naming: `PascalCase` for classes/types, `camelCase` for functions/variables, descriptive file names matching exported entity (for example `NexusServer.ts`).

## Testing Guidelines
- Test framework: Bun test runner.
- Add tests for new logic paths, especially aggregator behavior and socket request validation.
- Preferred naming: `*.test.ts` and colocate near source or under a dedicated `tests/` directory.
- Run `bun run test`, `bun run typecheck`, and `bun run lint` before opening a PR.

## Commit & Pull Request Guidelines
- Follow Conventional Commits seen in history: `feat(scope): ...`, `fix(scope): ...`, `refactor(scope): ...`.
- Keep commits focused; avoid bundling unrelated changes.
- PRs should include:
  - clear summary of behavior changes,
  - linked issue/task,
  - config or env updates (`.env-sample`, `nexus-config.json`) when relevant,
  - logs/screenshots only when they clarify operational impact.
