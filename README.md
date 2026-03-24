# Sherlock

Passive schema validator for Nostr events. Fetches events from relays, validates them against [schemata](https://github.com/nostrability/schemata) JSON Schemas, and reports which apps produce malformed blobs.

## How it works

1. **Scan** relays for events across 16 kinds (NIP-01, NIP-02, NIP-17, NIP-23, NIP-47, NIP-57, NIP-59, NIP-65)
2. **Validate** each event against its JSON Schema using AJV
3. **Attribute** events to apps via NIP-89 client tags
4. **Store** results in SQLite for analysis
5. **Export** findings as JSON + HTML dashboard
6. **Publish** daily report to Nostr as kind:1 summary + kind:30023 long-form article

CI runs 3x/day via GitHub Actions with relay-friendly rate limiting, batch sizing, and randomized scan order.

## Commands

```bash
# Scan relays for events and validate
sherlock scan --since 24h --relays wss://relay.damus.io

# Show database statistics
sherlock stats

# Show violation reports (by kind, client, error, or recent)
sherlock report --by kind
sherlock report --by client --format json

# Export findings to JSON + HTML dashboard
sherlock export

# Export and publish report to Nostr
sherlock export --publish
```

## Output

- **`data/findings.json`** — Machine-readable findings with three views: by kind, by app, error patterns. Git-tracked; changes over time = trend data for free.
- **`docs/index.html`** — Interactive HTML dashboard with findings inlined (no fetch, no CORS, works as a local file). Served by GitHub Pages.
- **Nostr notes** — Daily kind:1 highlights + kind:30023 full report published by the [nostrability bot](https://njump.me/npub1g5qtwz2nh9q0mnw555kv787kh6lysds95522gzptre3qpvz9p20s83m80d).

## Setup

```bash
npm install --legacy-peer-deps
npx tsc
```

Requires [nak](https://github.com/fiatjaf/nak) on PATH for scanning and publishing.

## CI

The GitHub Actions workflow (`sherlock-scan.yml`) runs 3x/day at staggered UTC times. It:

1. Restores the SQLite DB from cache (incremental scanning)
2. Scans relays with randomized order and jitter
3. Exports `data/findings.json` + `docs/index.html`
4. Publishes to Nostr (daily, first run only)
5. Commits findings if changed
6. Caches DB for next run

To enable Nostr publishing, add `NOSTR_SECRET_KEY` (nsec or hex) to GitHub repo secrets.

## Schema coverage

| NIP | Kinds | Description |
|-----|-------|-------------|
| NIP-01 | 0 | Profile metadata |
| NIP-02 | 3 | Contact list |
| NIP-17 | 14, 15, 10050 | Direct messages, file messages, DM relay list |
| NIP-23 | 30023 | Long-form content |
| NIP-47 | 13194, 23194–23197 | Nostr Wallet Connect |
| NIP-57 | 9734, 9735 | Zap request, zap receipt |
| NIP-59 | 13, 1059 | Seal, gift wrap |
| NIP-65 | 10002 | Relay list metadata |
