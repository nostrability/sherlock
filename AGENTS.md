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

## Rules for filing GitHub issues

CRITICAL: Every issue filed against a third-party app MUST be fact-checked before creation. Filing incorrect bug reports against other developers' apps damages credibility and wastes their time.

Before filing any issue:

1. **Verify the NIP**: Fetch the actual NIP specification (`https://raw.githubusercontent.com/nostr-protocol/nips/master/<N>.md`) and confirm which kind numbers it defines and what tag structure it requires. NEVER assume a kind number's purpose from memory — kind numbers are reused across NIPs (e.g., kind 1068 is NIP-88 Polls, NOT NIP-03 OpenTimestamps; kind 1018 is NIP-88 Poll Response, NOT only NIP-29 relay groups).

2. **Verify the schemata schema**: Read the actual schema file (`dist/nips/*/kind-<N>/schema.json`) and confirm it matches the NIP. Check: which NIP folder contains the schema? What tags does it require (`contains`)? What per-item constraints exist (`if/then`)? What patterns/maxItems apply?

3. **Cite the specific failing constraint with exact error paths** (BLOCKING — do not file without this): The issue body MUST include:
   - The **exact AJV error path** from the `violations` table (e.g., `/tags/1/0`, `/tags/0/2`).
   - The **error keyword** (e.g., `const`, `contains`, `pattern`, `minItems`, `additionalItems`).
   - The **error message** (e.g., "must be equal to constant", "must match pattern").
   - A concrete example showing the **actual tag value** vs **expected value** from the schema.
   - Query: `SELECT error_path, error_message, error_keyword, COUNT(*) FROM violations v JOIN events e ON v.event_id = e.id WHERE e.kind=<K> AND e.client_name='<app>' GROUP BY error_path, error_message, error_keyword ORDER BY COUNT(*) DESC`
   - Apply the `failure-pinpointed` label to confirm this step is done.
   - NEVER file a vague "suggests a partial schema compliance issue" or "fails validation" issue without these specifics. If the exact failure is unknown, investigate first — do not file the issue.

4. **Verify the event data**: Read actual event content (including the `content` field, not just tags) to understand what the client is actually doing. A kind 16 event with article content in `content` is a legitimate NIP-18 generic repost, not a "misuse."

5. **Cross-reference existing issues**: Check `gh issue list` to avoid duplicates. Search by app name AND kind number.

6. **Distinguish client bugs from schema gaps**: If events follow a NIP but fail validation because the schema is wrong or incomplete, the issue belongs to schemata (missing/incorrect schema), not the client. Label with `schema-gap`. If the client genuinely violates the NIP, label with `verified-nip` + `verified-schema`.

7. **Verify in app source code** (when possible): If the app is open-source, find the code that produces the violating events. Include the repository URL, specific file path, and line numbers in the issue body. Label with `verified-source`. This provides maximum value to the app developer — they can go straight to the fix.

8. **File upstream** (when source-verified): After verifying a bug in source code (Rule 7), file an issue in the app's own repository so the developer is notified. Link the upstream issue from the sherlock issue for cross-reference. If the fix is straightforward, consider opening a PR instead. Apps may be hosted outside GitHub (e.g., Codeberg, GitLab, self-hosted) — check the repository URL from the client tag or NIP-89 metadata.

### Available labels

- `false-positive` — validation failure caused by missing/incorrect schema, not a client bug. Close issue as "not planned".
- `failure-pinpointed` — exact AJV error paths, keywords, and sample values documented in the issue body (not just a comment). This label is a REQUIREMENT for any issue reporting validation failures — do not file without it.
- `verified-nip` — NIP specification verified against the actual NIP document
- `verified-schema` — schemata schema verified as correct for this kind
- `verified-source` — bug verified in app source code with file/line references
- `schema-gap` — schemata is missing or has wrong schema for this kind

## CI

GitHub Actions runs scan + export 3x/day. The SQLite DB is cached between runs.
