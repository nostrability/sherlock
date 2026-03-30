import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { DB_FILENAME } from '../config.js';
import type { NostrEvent, ValidationResult, ClientAttribution, Attribution, ScanRun } from '../types.js';

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  pubkey        TEXT NOT NULL,
  kind          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  tags          TEXT,
  raw           TEXT NOT NULL,
  client_name   TEXT,
  source_relay  TEXT,
  scanned_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  valid         INTEGER
);

CREATE TABLE IF NOT EXISTS violations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL REFERENCES events(id),
  schema_key    TEXT NOT NULL,
  error_path    TEXT,
  error_message TEXT NOT NULL,
  error_keyword TEXT,
  severity      TEXT NOT NULL DEFAULT 'error'
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at    INTEGER,
  kinds          TEXT,
  relays         TEXT,
  since_ts       INTEGER,
  events_fetched INTEGER DEFAULT 0,
  events_new     INTEGER DEFAULT 0,
  violations_found INTEGER DEFAULT 0,
  ci_run_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_valid ON events(valid);
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_name);
CREATE INDEX IF NOT EXISTS idx_violations_event ON violations(event_id);
`;

/** Idempotent migrations: add columns that may not exist yet */
function runMigrations(db: Database.Database): void {
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const colNames = new Set(eventCols.map(c => c.name));

  if (!colNames.has('scan_run_id')) {
    db.exec('ALTER TABLE events ADD COLUMN scan_run_id INTEGER REFERENCES scan_runs(id)');
  }
  if (!colNames.has('attribution_method')) {
    db.exec('ALTER TABLE events ADD COLUMN attribution_method TEXT');
  }
  if (!colNames.has('attribution_confidence')) {
    db.exec('ALTER TABLE events ADD COLUMN attribution_confidence TEXT');
  }

  // Migrate violations table (for existing DBs created before severity column)
  const violCols = db.prepare("PRAGMA table_info(violations)").all() as Array<{ name: string }>;
  const violColNames = new Set(violCols.map(c => c.name));
  if (!violColNames.has('severity')) {
    db.exec("ALTER TABLE violations ADD COLUMN severity TEXT NOT NULL DEFAULT 'error'");
  }

  // Create indexes on migrated columns (safe to run idempotently)
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_scan_run ON events(scan_run_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_violations_severity ON violations(severity)');

  // Composite indexes for export queries
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_client_created ON events(client_name, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_violations_event_keyword ON violations(event_id, error_keyword)');

  // One-time: strip raw JSON from valid unattributed events stored before conditional raw logic
  const needsCleanup = db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE valid = 1 AND client_name IS NULL AND raw != ''"
  ).get() as { cnt: number };
  if (needsCleanup.cnt > 0) {
    console.log(`  Cleaning raw JSON from ${needsCleanup.cnt} valid unattributed events...`);
    db.exec("UPDATE events SET raw = '' WHERE valid = 1 AND client_name IS NULL AND raw != ''");
    console.log('  Done. Running VACUUM to reclaim space...');
    db.exec('VACUUM');
    console.log('  VACUUM complete.');
  }
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = resolve(process.cwd(), DB_FILENAME);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_DDL);
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    _insertEvent = null;
    _insertViolation = null;
    db.close();
    db = null;
  }
}

const insertEventStmt = () => getDb().prepare(`
  INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, tags, raw, client_name, source_relay, valid, scan_run_id, attribution_method, attribution_confidence)
  VALUES (@id, @pubkey, @kind, @created_at, @tags, @raw, @client_name, @source_relay, @valid, @scan_run_id, @attribution_method, @attribution_confidence)
`);

const insertViolationStmt = () => getDb().prepare(`
  INSERT INTO violations (event_id, schema_key, error_path, error_message, error_keyword, severity)
  VALUES (@event_id, @schema_key, @error_path, @error_message, @error_keyword, @severity)
`);

let _insertEvent: Database.Statement | null = null;
let _insertViolation: Database.Statement | null = null;

function getInsertEvent() {
  if (!_insertEvent) _insertEvent = insertEventStmt();
  return _insertEvent;
}

function getInsertViolation() {
  if (!_insertViolation) _insertViolation = insertViolationStmt();
  return _insertViolation;
}

/**
 * Insert an event and its violations in a single transaction.
 * Returns true if the event was new (inserted), false if duplicate.
 * `raw` is the full JSON string — caller decides whether to persist it or pass ''.
 */
export function storeEvent(
  event: NostrEvent,
  validation: ValidationResult,
  client: ClientAttribution | null,
  sourceRelay?: string,
  scanRunId?: number,
  attribution?: Attribution | null,
  raw?: string,
): boolean {
  const rawJson = raw ?? JSON.stringify(event);
  const validValue = validation.valid === null ? null : validation.valid ? 1 : 0;

  const txn = getDb().transaction(() => {
    const result = getInsertEvent().run({
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      created_at: event.created_at,
      tags: JSON.stringify(event.tags),
      raw: rawJson,
      client_name: attribution?.name ?? client?.name ?? null,
      source_relay: sourceRelay ?? null,
      valid: validValue,
      scan_run_id: scanRunId ?? null,
      attribution_method: attribution?.method ?? (client ? 'client_tag' : null),
      attribution_confidence: attribution?.confidence ?? (client ? 'high' : null),
    });

    if (result.changes === 0) return false; // duplicate

    if (validation.errors.length > 0) {
      const stmt = getInsertViolation();
      for (const err of validation.errors) {
        const sev = (err.params as Record<string, unknown>)?.severity;
        stmt.run({
          event_id: event.id,
          schema_key: validation.schemaKey ?? `kind${event.kind}Semantic`,
          error_path: err.instancePath || null,
          error_message: err.message || 'unknown error',
          error_keyword: err.keyword || null,
          severity: typeof sev === 'string' ? sev : 'error',
        });
      }
    }

    return true;
  });

  return txn();
}

/**
 * Get the most recent created_at for a given kind, used for --since on next scan.
 */
export function getHighWaterMark(kind?: number): number | null {
  const query = kind !== undefined
    ? getDb().prepare('SELECT MAX(created_at) as max_ts FROM events WHERE kind = ?').get(kind) as { max_ts: number | null } | undefined
    : getDb().prepare('SELECT MAX(created_at) as max_ts FROM events').get() as { max_ts: number | null } | undefined;
  return query?.max_ts ?? null;
}

export function getTotalEvents(): number {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number };
  return row.cnt;
}

export function getEventCountsByKind(): Array<{ kind: number; total: number; valid: number; invalid: number; no_schema: number }> {
  const rows = getDb().prepare(`
    SELECT kind,
      COUNT(*) as total,
      SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid,
      SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) as invalid,
      SUM(CASE WHEN valid IS NULL THEN 1 ELSE 0 END) as no_schema
    FROM events
    GROUP BY kind
    ORDER BY kind
  `).all() as Array<{ kind: number; total: number; valid: number; invalid: number; no_schema: number }>;
  return rows;
}

export function getViolationsByKind(): Array<{ kind: number; schema_key: string; error_keyword: string | null; error_count: number }> {
  const rows = getDb().prepare(`
    SELECT e.kind, v.schema_key, v.error_keyword, COUNT(*) as error_count
    FROM violations v
    JOIN events e ON e.id = v.event_id
    GROUP BY e.kind, v.schema_key, v.error_keyword
    ORDER BY error_count DESC
  `).all() as Array<{ kind: number; schema_key: string; error_keyword: string | null; error_count: number }>;
  return rows;
}

export function getViolationsByClient(): Array<{ client_name: string | null; total_events: number; invalid_events: number; violation_count: number }> {
  const rows = getDb().prepare(`
    SELECT
      e.client_name,
      COUNT(DISTINCT e.id) as total_events,
      COUNT(DISTINCT CASE WHEN e.valid = 0 THEN e.id END) as invalid_events,
      COUNT(v.id) as violation_count
    FROM events e
    LEFT JOIN violations v ON v.event_id = e.id
    WHERE e.client_name IS NOT NULL
    GROUP BY e.client_name
    ORDER BY violation_count DESC
  `).all() as Array<{ client_name: string | null; total_events: number; invalid_events: number; violation_count: number }>;
  return rows;
}

export function getViolationsByError(): Array<{ error_keyword: string | null; error_path: string | null; error_message: string; count: number }> {
  const rows = getDb().prepare(`
    SELECT error_keyword, error_path, error_message, COUNT(*) as count
    FROM violations
    GROUP BY error_keyword, error_path, error_message
    ORDER BY count DESC
    LIMIT 50
  `).all() as Array<{ error_keyword: string | null; error_path: string | null; error_message: string; count: number }>;
  return rows;
}

export function getRecentViolations(limit: number = 20): Array<{ event_id: string; kind: number; client_name: string | null; error_path: string | null; error_message: string; error_keyword: string | null }> {
  const rows = getDb().prepare(`
    SELECT v.event_id, e.kind, e.client_name, v.error_path, v.error_message, v.error_keyword
    FROM violations v
    JOIN events e ON e.id = v.event_id
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{ event_id: string; kind: number; client_name: string | null; error_path: string | null; error_message: string; error_keyword: string | null }>;
  return rows;
}

// --- Export queries ---

export function getAppKindMatrix(): Array<{ client_name: string; kind: number; total: number; valid: number; invalid: number; attribution_method: string | null }> {
  return getDb().prepare(`
    SELECT COALESCE(client_name, '_unattributed') as client_name, kind,
      COUNT(*) as total,
      SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid,
      SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) as invalid,
      MAX(attribution_method) as attribution_method
    FROM events
    GROUP BY 1, 2
    ORDER BY total DESC
  `).all() as Array<{ client_name: string; kind: number; total: number; valid: number; invalid: number; attribution_method: string | null }>;
}

export function getViolationDetails(): Array<{
  client_name: string; kind: number; error_keyword: string | null;
  error_path: string | null; error_message: string; count: number;
  sample_event_ids: string | null; severity: string;
}> {
  // Step 1: Fast aggregation (single pass, no correlated subquery)
  const base = getDb().prepare(`
    SELECT COALESCE(e.client_name, '_unattributed') as client_name, e.kind,
      v.error_keyword, v.error_path, v.error_message, v.severity,
      COUNT(*) as count
    FROM violations v JOIN events e ON e.id = v.event_id
    GROUP BY 1, 2, 3, 4, 5, 6
    ORDER BY count DESC
  `).all() as Array<{
    client_name: string; kind: number; error_keyword: string | null;
    error_path: string | null; error_message: string; count: number;
    sample_event_ids: string | null; severity: string;
  }>;

  // Step 2: Collect sample event IDs only for top patterns (avoids N correlated subqueries)
  const sampleStmtNamed = getDb().prepare(`
    SELECT e.id FROM violations v
    JOIN events e ON e.id = v.event_id
    WHERE e.client_name = ? AND e.kind = ?
      AND v.error_keyword IS ? AND v.error_path IS ?
      AND v.error_message = ?
    LIMIT 3
  `);
  const sampleStmtNull = getDb().prepare(`
    SELECT e.id FROM violations v
    JOIN events e ON e.id = v.event_id
    WHERE e.client_name IS NULL AND e.kind = ?
      AND v.error_keyword IS ? AND v.error_path IS ?
      AND v.error_message = ?
    LIMIT 3
  `);

  const MAX_SAMPLE_ROWS = 200;
  for (let i = 0; i < Math.min(base.length, MAX_SAMPLE_ROWS); i++) {
    const row = base[i];
    const samples = row.client_name === '_unattributed'
      ? sampleStmtNull.all(row.kind, row.error_keyword, row.error_path, row.error_message)
      : sampleStmtNamed.all(row.client_name, row.kind, row.error_keyword, row.error_path, row.error_message);
    row.sample_event_ids = (samples as Array<{ id: string }>).map(s => s.id).join(',') || null;
  }

  return base;
}

export function getTopPubkeysForErrors(): Array<{
  error_keyword: string | null; error_path: string | null; pubkey: string; cnt: number;
}> {
  return getDb().prepare(`
    SELECT v.error_keyword, v.error_path, e.pubkey, COUNT(*) as cnt
    FROM violations v JOIN events e ON e.id = v.event_id
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, cnt DESC
  `).all() as Array<{
    error_keyword: string | null; error_path: string | null; pubkey: string; cnt: number;
  }>;
}

export function getTimeRange(): { first_at: number | null; last_at: number | null } {
  return getDb().prepare(
    'SELECT MIN(created_at) as first_at, MAX(created_at) as last_at FROM events'
  ).get() as { first_at: number | null; last_at: number | null };
}

export function getDistinctRelays(): string[] {
  const rows = getDb().prepare(
    'SELECT DISTINCT source_relay FROM events WHERE source_relay IS NOT NULL ORDER BY source_relay'
  ).all() as Array<{ source_relay: string }>;
  return rows.map(r => r.source_relay);
}

// --- Retention ---

/**
 * Delete events (and their violations) older than `retainDays`.
 * Returns the number of events deleted.
 */
export function pruneOldEvents(retainDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - retainDays * 86400;
  const db = getDb();

  const txn = db.transaction(() => {
    // Delete violations for old events first (FK constraint)
    db.prepare('DELETE FROM violations WHERE event_id IN (SELECT id FROM events WHERE created_at < ?)').run(cutoff);
    const result = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
    return result.changes;
  });

  return txn();
}

// --- Scan run tracking ---

export function createScanRun(kinds: number[], relays: string[], sinceTs: number): number {
  const result = getDb().prepare(`
    INSERT INTO scan_runs (kinds, relays, since_ts, ci_run_id)
    VALUES (?, ?, ?, ?)
  `).run(
    JSON.stringify(kinds),
    JSON.stringify(relays),
    sinceTs,
    process.env.GITHUB_RUN_ID ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function finishScanRun(id: number, stats: { events_fetched: number; events_new: number; violations_found: number }): void {
  getDb().prepare(`
    UPDATE scan_runs
    SET finished_at = unixepoch(),
        events_fetched = ?,
        events_new = ?,
        violations_found = ?
    WHERE id = ?
  `).run(stats.events_fetched, stats.events_new, stats.violations_found, id);
}

export function getScanRunHistory(limit: number = 20): ScanRun[] {
  return getDb().prepare(`
    SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?
  `).all(limit) as ScanRun[];
}

export function getScanRunStats(): { total_runs: number; last_finished_at: number | null } {
  const row = getDb().prepare(`
    SELECT COUNT(*) as total_runs, MAX(finished_at) as last_finished_at FROM scan_runs WHERE finished_at IS NOT NULL
  `).get() as { total_runs: number; last_finished_at: number | null };
  return row;
}

// --- Phase 3: Drill-down queries ---

export function getSampleEvents(kind: number, clientName?: string, errorKeyword?: string, limit: number = 3): Array<{
  id: string; pubkey: string; kind: number; created_at: number; raw: string; client_name: string | null;
  attribution_method: string | null; attribution_confidence: string | null;
}> {
  let query = `
    SELECT e.id, e.pubkey, e.kind, e.created_at, e.raw, e.client_name,
           e.attribution_method, e.attribution_confidence
    FROM events e
  `;
  const params: unknown[] = [];

  if (errorKeyword) {
    query += ' JOIN violations v ON v.event_id = e.id';
  }
  query += ' WHERE e.kind = ?';
  params.push(kind);

  if (clientName === '_unattributed') {
    query += ' AND e.client_name IS NULL';
  } else if (clientName) {
    query += ' AND e.client_name = ?';
    params.push(clientName);
  }
  if (errorKeyword) {
    query += ' AND v.error_keyword = ?';
    params.push(errorKeyword);
  }
  query += ' GROUP BY e.id ORDER BY e.created_at DESC LIMIT ?';
  params.push(limit);

  return getDb().prepare(query).all(...params) as Array<{
    id: string; pubkey: string; kind: number; created_at: number; raw: string; client_name: string | null;
    attribution_method: string | null; attribution_confidence: string | null;
  }>;
}

export function getTagFrequency(kind: number, clientName?: string): Array<{ tag_name: string; count: number }> {
  // Parse tags in JS since SQLite JSON can be tricky with nested arrays
  const params: unknown[] = [kind];
  if (clientName && clientName !== '_unattributed') params.push(clientName);

  const rows = getDb().prepare(`
    SELECT e.tags FROM events e WHERE e.kind = ?
    ${clientName === '_unattributed' ? 'AND e.client_name IS NULL' : clientName ? 'AND e.client_name = ?' : ''}
    LIMIT 1000
  `).all(...params) as Array<{ tags: string }>;

  const freqMap = new Map<string, number>();
  for (const row of rows) {
    try {
      const tags = JSON.parse(row.tags) as string[][];
      for (const tag of tags) {
        if (tag[0]) {
          freqMap.set(tag[0], (freqMap.get(tag[0]) ?? 0) + 1);
        }
      }
    } catch { /* skip malformed */ }
  }

  return [...freqMap.entries()]
    .map(([tag_name, count]) => ({ tag_name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
}

export function getPubkeyCountByKind(): Array<{ kind: number; unique_pubkeys: number }> {
  return getDb().prepare(`
    SELECT kind, COUNT(DISTINCT pubkey) as unique_pubkeys
    FROM events
    GROUP BY kind
    ORDER BY unique_pubkeys DESC
  `).all() as Array<{ kind: number; unique_pubkeys: number }>;
}

export function getPubkeyCountByApp(): Array<{ client_name: string; unique_pubkeys: number }> {
  return getDb().prepare(`
    SELECT COALESCE(client_name, '_unattributed') as client_name,
           COUNT(DISTINCT pubkey) as unique_pubkeys
    FROM events
    GROUP BY 1
    ORDER BY unique_pubkeys DESC
  `).all() as Array<{ client_name: string; unique_pubkeys: number }>;
}

export function getAttributionSummary(): Array<{ method: string; count: number }> {
  return getDb().prepare(`
    SELECT COALESCE(attribution_method, 'unattributed') as method, COUNT(*) as count
    FROM events
    GROUP BY 1
    ORDER BY count DESC
  `).all() as Array<{ method: string; count: number }>;
}

// --- Phase 4: Trend queries ---

export function getAppTrend(clientName: string, groupBy: 'day' | 'week' = 'day'): Array<{
  period: string; total: number; invalid: number; error_rate: number;
}> {
  const dateFmt = groupBy === 'week' ? '%Y-W%W' : '%Y-%m-%d';
  const client = clientName === '_unattributed' ? null : clientName;

  return getDb().prepare(`
    SELECT strftime('${dateFmt}', e.created_at, 'unixepoch') as period,
           COUNT(*) as total,
           SUM(CASE WHEN e.valid = 0 THEN 1 ELSE 0 END) as invalid,
           CASE WHEN SUM(CASE WHEN e.valid IS NOT NULL THEN 1 ELSE 0 END) > 0
             THEN ROUND(CAST(SUM(CASE WHEN e.valid = 0 THEN 1 ELSE 0 END) AS REAL)
               / SUM(CASE WHEN e.valid IS NOT NULL THEN 1 ELSE 0 END), 4)
             ELSE 0
           END as error_rate
    FROM events e
    WHERE ${client === null ? 'e.client_name IS NULL' : 'e.client_name = ?'}
    GROUP BY period
    ORDER BY period
  `).all(...(client === null ? [] : [client])) as Array<{
    period: string; total: number; invalid: number; error_rate: number;
  }>;
}

export function getAllAppTrends(lastNDays: number = 30): Array<{
  client_name: string; total: number; invalid: number; error_rate: number;
  first_seen: string; last_seen: string; data_points: number;
}> {
  const cutoff = Math.floor(Date.now() / 1000) - lastNDays * 86400;
  return getDb().prepare(`
    SELECT COALESCE(e.client_name, '_unattributed') as client_name,
           COUNT(*) as total,
           SUM(CASE WHEN e.valid = 0 THEN 1 ELSE 0 END) as invalid,
           CASE WHEN SUM(CASE WHEN e.valid IS NOT NULL THEN 1 ELSE 0 END) > 0
             THEN ROUND(CAST(SUM(CASE WHEN e.valid = 0 THEN 1 ELSE 0 END) AS REAL)
               / SUM(CASE WHEN e.valid IS NOT NULL THEN 1 ELSE 0 END), 4)
             ELSE 0
           END as error_rate,
           strftime('%Y-%m-%d', MIN(e.created_at), 'unixepoch') as first_seen,
           strftime('%Y-%m-%d', MAX(e.created_at), 'unixepoch') as last_seen,
           COUNT(DISTINCT strftime('%Y-%m-%d', e.created_at, 'unixepoch')) as data_points
    FROM events e
    WHERE e.created_at >= ?
    GROUP BY 1
    ORDER BY total DESC
  `).all(cutoff) as Array<{
    client_name: string; total: number; invalid: number; error_rate: number;
    first_seen: string; last_seen: string; data_points: number;
  }>;
}

/**
 * Batch query: daily trend data for ALL apps in a single table scan.
 * Returns a Map keyed by client_name (with '_unattributed' for NULL).
 */
export function getBatchAppTrendsDaily(): Map<string, Array<{ period: string; total: number; invalid: number; error_rate: number }>> {
  const rows = getDb().prepare(`
    SELECT COALESCE(e.client_name, '_unattributed') as client_name,
           strftime('%Y-%m-%d', e.created_at, 'unixepoch') as period,
           COUNT(*) as total,
           SUM(CASE WHEN e.valid = 0 THEN 1 ELSE 0 END) as invalid,
           CASE WHEN SUM(CASE WHEN e.valid IS NOT NULL THEN 1 ELSE 0 END) > 0
             THEN ROUND(CAST(SUM(CASE WHEN e.valid = 0 THEN 1 ELSE 0 END) AS REAL)
               / SUM(CASE WHEN e.valid IS NOT NULL THEN 1 ELSE 0 END), 4)
             ELSE 0
           END as error_rate
    FROM events e
    GROUP BY 1, 2
    ORDER BY 1, 2
  `).all() as Array<{ client_name: string; period: string; total: number; invalid: number; error_rate: number }>;

  const map = new Map<string, Array<{ period: string; total: number; invalid: number; error_rate: number }>>();
  for (const row of rows) {
    if (!map.has(row.client_name)) map.set(row.client_name, []);
    map.get(row.client_name)!.push({ period: row.period, total: row.total, invalid: row.invalid, error_rate: row.error_rate });
  }
  return map;
}
