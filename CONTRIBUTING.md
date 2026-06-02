# Contributing

Thanks for considering a contribution.

## Getting started

```bash
git clone https://github.com/yyhezkel/lean-chronoscope-mcp.git
cd lean-chronoscope-mcp
pnpm install
pnpm typecheck
pnpm build
cd docker && docker compose up -d --build      # boot the daemon
node ../scripts/test-all-tools.mjs              # 56/56 must pass
```

## Project layout

```
src/
  daemon/      long-running side: owns Chrome via CDP, per-session SQLite + blobs
  mcp/         per-session MCP server (stdio + HTTP transports)
    tools/     one file per category (pages, input, storage, network, …)
    response/  MCP response builder + change-detect memo
    resources/ live MCP resources (subscriptions + listChanged)
  shared/      logger, paths, redaction, MCP/RPC protocol types
scripts/       e2e smoke tests + benchmarks
docs/          architecture, security, comparison, tests
docker/        Dockerfile + compose
```

See [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the design rationale.

## Tests

All tests are real end-to-end — no mocks. They drive the live daemon + real Chromium over CDP.

- **Required before opening a PR:** `node scripts/test-all-tools.mjs` (56/56 PASS).
- For new tools, add a row to `docs/TOOL_TESTS.md` and either an inline assertion in `scripts/test-all-tools.mjs` or a category file under `scripts/tools/`.
- For new modes / features touching the MCP surface, add a smoke under `scripts/smoke-test-*.mjs` and a row in `docs/TESTS.md`.
- Append every run to `docs/TEST_LOG.md` (newest on top).

Conventions:
- One `docker exec -i … node /app/dist/bin/mcp.js --session <id>` per smoke; `proc.kill("SIGTERM")` after `stdin.end()` (mandatory — `docker exec -i` doesn't propagate stdin EOF).
- Use `scripts/tools/harness.mjs` for the RPC + cleanup boilerplate.

## Adding a new MCP tool

1. Create `src/mcp/tools/<your-tool>.ts` using `defineTool({ name, description, category, inputSchema, handler })`.
2. Register it in `src/mcp/tools/tools.ts` (`allTools` array).
3. If a daemon-side method is needed, add it to `src/daemon/rpc-handlers.ts` and the dispatcher.
4. Add an entry to `docs/TOOL_TESTS.md` and an assertion in the test suite.
5. Update `CHANGELOG.md` under *Unreleased*.

The MCP-server `CallToolRequestSchema` handler already resolves any tool via `getTool(name)`, so a tool is callable as soon as it's in the registry. Gateway mode's `tools_invoke` will pick it up automatically.

## Style

- TypeScript strict mode; let `tsc` catch you.
- Prefer small, focused tool files (~50–200 LoC). One tool per file is fine.
- Tool descriptions are token cost; keep them informative but tight.
- No comments that restate code; reserve comments for non-obvious *why*.

## Reporting issues / proposing changes

- File an issue with a reproducer (browser-mcp logs + the failing tool call when applicable).
- Security issues: please email instead of opening a public issue (contact in commit metadata).

## License

By contributing you agree your contribution will be licensed under the [MIT License](LICENSE).
