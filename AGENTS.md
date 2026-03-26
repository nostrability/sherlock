# AGENTS.md

## Commands

- Install: `npm install --legacy-peer-deps` (schemata has peer dep conflicts)
- Build: `npm run build`
- Typecheck: `npx tsc --noEmit`
- Run: `node dist/index.js <command>`
- No test suite yet. Verify changes compile: `npm run build && npx tsc --noEmit`

## Architecture

```
src/
  index.ts              # CLI entry, commander setup
  config.ts             # Constants: relay lists, kind lists, thresholds
  types.ts              # Shared interfaces (NostrEvent, ValidationResult, etc.)
  util.ts               # parseDuration, formatNumber, which()
  commands/
    scan.ts             # Fetch events via nak, validate, store
    report.ts           # Query and display violation reports
    stats.ts            # Summary statistics
    export.ts           # Build findings JSON, HTML dashboard, optional Nostr publish
  fetch/
    nak.ts              # Spawns `nak` CLI as child process, handles JSONL parsing
  validate/
    engine.ts           # AJV validation against schemata schemas
  attribution/
    client-tag.ts       # NIP-89 client tag extraction
  db/
    index.ts            # SQLite via better-sqlite3, all queries
```

Four commands (`scan`, `report`, `stats`, `export`) share a SQLite database (`sherlock.db`).

IMPORTANT: The DB schema is the contract between all commands and CI. Schema changes affect every command and break the GitHub Actions cache. ALWAYS add new columns as nullable or with defaults. NEVER drop or rename columns without updating all commands.

## Rules for the HTML dashboard

`export.ts:238 generateHtml()` builds a self-contained HTML page as a TypeScript template literal. The `<script>` block inside runs in the browser, not Node.

When adding content to the dashboard:

1. ALWAYS use the `esc()` function at `export.ts:313` for user-derived text. It is defined inside the template string — do not create a second escaping function.
2. NEVER use inline `onclick` handlers. Use `data-*` attributes and the delegated click handler at `export.ts:412`. See `export.ts:377` for the `data-copy` pattern.
3. NEVER embed JSON in the page without `.replace(/</g, '\\u003c')`. See `export.ts:241` for the pattern.
4. For expandable rows, place `<tr class="detail">` elements immediately after the parent `<tr>`. The expand/collapse handler at `export.ts:396` uses `nextElementSibling` traversal — no `data-parent` attributes or IDs needed.

## Rules for relay fetching

NEVER parallelize relay connections. NEVER increase `DEFAULT_KIND_BATCH_SIZE` beyond 5. NEVER remove or reduce the pause intervals in `config.ts`. Nostr relays ban IPs that send aggressive requests.

Current spacing (`config.ts`):
- 5 kinds max per REQ filter
- 5s between paginated pages, 2s between kind batches, 3s between relays
- Relay and batch order randomized per run

## Rules for child processes

All spawned processes MUST follow the pattern in `nak.ts:14 activeProcs`:

1. Add the process to `activeProcs` immediately after `spawn()` — see `nak.ts:124`
2. Remove from `activeProcs` in the `close` handler — see `nak.ts:155`
3. Cap stderr to 10KB — see `nak.ts:145`
4. Handle exit codes: 0 = success, 3 = relay-level failure (non-fatal, resolve with count), other = reject

## Rules for scan resume

Each kind tracks its own most recent `created_at` as a resume point (`scan.ts:52 perKindSince`). NEVER use a single global timestamp — less-active kinds get skipped when active kinds advance the watermark. See `scan.ts:58-67` for the per-kind loop and `db/index.ts:131 getHighWaterMark(kind)`.

## AJV schema loading

Schemata schemas require preprocessing before AJV compiles them (see `engine.ts:59 stripNestedMetaFields` and `engine.ts:109 stripErrorMessages`):

- Strip nested `$schema` and `$id` fields (keep root `$schema`)
- Strip `errorMessage` fields (require ajv-errors plugin we don't use)
- Use `strict: false` (schemas use contains, if/then)
- NEVER import the `@nostrability/schemata` ESM bundle — it is broken on Node 22+. Use `createRequire` and walk `dist/nips/*.json` directly. See `engine.ts:5-10` for the pattern.

## CI

GitHub Actions runs scan + export 3x/day. The SQLite DB is cached between runs.
