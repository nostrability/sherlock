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
