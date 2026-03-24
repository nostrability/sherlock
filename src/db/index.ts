import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { DB_FILENAME } from '../config.js';
import type { NostrEvent, ValidationResult, ClientAttribution } from '../types.js';

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

CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_valid ON events(valid);
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_name);
CREATE INDEX IF NOT EXISTS idx_violations_event ON violations(event_id);
`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = resolve(process.cwd(), DB_FILENAME);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_DDL);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

const insertEventStmt = () => getDb().prepare(`
  INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, tags, raw, client_name, source_relay, valid)
  VALUES (@id, @pubkey, @kind, @created_at, @tags, @raw, @client_name, @source_relay, @valid)
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
 */
export function storeEvent(
  event: NostrEvent,
  validation: ValidationResult,
  client: ClientAttribution | null,
): boolean {
  const raw = JSON.stringify(event);
  const validValue = validation.valid === null ? null : validation.valid ? 1 : 0;

  const result = getInsertEvent().run({
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    tags: JSON.stringify(event.tags),
    raw,
    client_name: client?.name ?? null,
    source_relay: null,
    valid: validValue,
  });

  if (result.changes === 0) return false; // duplicate

  if (validation.errors.length > 0 && validation.schemaKey) {
    const stmt = getInsertViolation();
    for (const err of validation.errors) {
      stmt.run({
        event_id: event.id,
        schema_key: validation.schemaKey,
        error_path: err.instancePath || null,
        error_message: err.message || 'unknown error',
        error_keyword: err.keyword || null,
        severity: 'error',
      });
    }
  }

  return true;
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

export function getAppKindMatrix(): Array<{ client_name: string; kind: number; total: number; valid: number; invalid: number }> {
  return getDb().prepare(`
    SELECT COALESCE(client_name, '_unattributed') as client_name, kind,
      COUNT(*) as total,
      SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid,
      SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) as invalid
    FROM events
    GROUP BY 1, 2
    ORDER BY total DESC
  `).all() as Array<{ client_name: string; kind: number; total: number; valid: number; invalid: number }>;
}

export function getViolationDetails(): Array<{
  client_name: string; kind: number; error_keyword: string | null;
  error_path: string | null; error_message: string; count: number;
  sample_event_ids: string | null;
}> {
  return getDb().prepare(`
    SELECT base.*, (
      SELECT GROUP_CONCAT(sub_id) FROM (
        SELECT e2.id as sub_id FROM violations v2
        JOIN events e2 ON e2.id = v2.event_id
        WHERE COALESCE(e2.client_name, '_unattributed') = base.client_name
          AND e2.kind = base.kind
          AND v2.error_keyword IS base.error_keyword
          AND v2.error_path IS base.error_path
        LIMIT 3
      )
    ) as sample_event_ids
    FROM (
      SELECT COALESCE(e.client_name, '_unattributed') as client_name, e.kind,
        v.error_keyword, v.error_path, v.error_message, COUNT(*) as count
      FROM violations v JOIN events e ON e.id = v.event_id
      GROUP BY 1, 2, 3, 4, 5
    ) base
    ORDER BY count DESC
  `).all() as Array<{
    client_name: string; kind: number; error_keyword: string | null;
    error_path: string | null; error_message: string; count: number;
    sample_event_ids: string | null;
  }>;
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
