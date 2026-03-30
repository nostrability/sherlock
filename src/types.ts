import type { ErrorObject } from 'ajv';

export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface ValidationResult {
  valid: boolean | null;  // null = no schema for this kind
  errors: ErrorObject[];
  schemaKey: string | null;
}

export interface ClientAttribution {
  name: string;
  address?: string;
}

export interface ScanOptions {
  kinds: number[];
  relays: string[];
  since: number;  // unix timestamp
}

export interface StoredEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string;       // JSON string
  raw: string;        // full JSON
  client_name: string | null;
  source_relay: string | null;
  scanned_at: number;
  valid: number | null;  // 1=pass, 0=fail, null=no schema
}

export interface StoredViolation {
  id: number;
  event_id: string;
  schema_key: string;
  error_path: string | null;
  error_message: string;
  error_keyword: string | null;
  severity: string;
}

export interface ScanProgress {
  fetched: number;
  duplicates: number;
  validated: number;
  violations: number;
  rateLimits: number;
}

export interface RateLimitEvent {
  relay: string;
  reason: string;
}

export interface ScanRun {
  id: number;
  started_at: number;
  finished_at: number | null;
  kinds: string | null;       // JSON array
  relays: string | null;      // JSON array
  since_ts: number | null;
  events_fetched: number;
  events_new: number;
  violations_found: number;
  ci_run_id: string | null;
}

export interface Attribution {
  name: string;
  method: 'client_tag' | 'nip89_pubkey' | 'fingerprint';
  confidence: 'high' | 'medium' | 'low';
  address?: string;
}

export interface AppFingerprint {
  _comment?: string;
  app_name: string;
  pubkey_prefix?: string[];
  tag_pattern?: { tag: string; value?: string }[];
  content_pattern?: string[];
  tag_name_present?: string[];
}

export interface SemanticViolation {
  check_name: string;
  message: string;
  path: string;
  severity: 'warning' | 'error';
}
