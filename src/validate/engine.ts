import { createRequire } from 'node:module';
import Ajv, { type ValidateFunction } from 'ajv';
import type { NostrEvent, ValidationResult } from '../types.js';

const require = createRequire(import.meta.url);

// Load all schemas from the schemata package via require (avoids Node 22+ ESM JSON import issue)
let schemas: Record<string, unknown> | null = null;

function loadSchemas(): Record<string, unknown> {
  if (schemas) return schemas;
  // Walk the dist/nips directory to find kind schemas directly
  // (the ESM bundle re-exports don't work with require())
  const schemataDir = require.resolve('@nostrability/schemata/package.json');
  const path = require('path');
  const pkgDir = path.dirname(schemataDir);
  const fs = require('fs');

  schemas = {};
  const nipsDir = path.join(pkgDir, 'dist', 'nips');
  if (!fs.existsSync(nipsDir)) {
    console.error(`Warning: schemata nips directory not found at ${nipsDir}`);
    return schemas;
  }

  // Walk nips directory for kind-N/schema.json files
  const nipDirs = fs.readdirSync(nipsDir);
  for (const nipDir of nipDirs) {
    const nipPath = path.join(nipsDir, nipDir);
    try { if (!fs.statSync(nipPath).isDirectory()) continue; } catch { continue; }
    const entries = fs.readdirSync(nipPath);
    for (const entry of entries) {
      const match = entry.match(/^kind-(\d+)$/);
      if (match) {
        const kindNum = match[1];
        const schemaPath = path.join(nipPath, entry, 'schema.json');
        if (fs.existsSync(schemaPath)) {
          const key = `kind${kindNum}Schema`;
          try {
            schemas[key] = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
          } catch (err) {
            console.error(`Warning: Failed to parse ${schemaPath}:`, err);
          }
        }
      }
    }
  }

  return schemas;
}

const ajv = new Ajv({ strict: false, allErrors: true });
const cache = new Map<string, ValidateFunction | null>();

/**
 * Recursively remove $schema and $id from nested objects to prevent AJV conflicts.
 * Keeps root-level $schema intact (AJV uses it for draft detection).
 */
function stripNestedMetaFields(obj: unknown, isRoot = true): void {
  if (typeof obj !== 'object' || obj === null) return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripNestedMetaFields(item, false);
    return;
  }
  const record = obj as Record<string, unknown>;
  if (!isRoot) {
    delete record['$schema'];
    delete record['$id'];
  }
  for (const value of Object.values(record)) {
    stripNestedMetaFields(value, false);
  }
}

export function validateEvent(event: NostrEvent): ValidationResult {
  const key = `kind${event.kind}Schema`;
  if (!cache.has(key)) {
    const allSchemas = loadSchemas();
    const schema = allSchemas[key];
    if (!schema) {
      cache.set(key, null);
    } else {
      try {
        const cloned = structuredClone(schema);
        stripNestedMetaFields(cloned);
        // Remove errorMessage fields (requires ajv-errors plugin we don't use)
        stripErrorMessages(cloned);
        cache.set(key, ajv.compile(cloned as object));
      } catch (err) {
        console.error(`Warning: Failed to compile schema ${key}:`, err);
        cache.set(key, null);
      }
    }
  }

  const validate = cache.get(key);
  if (!validate) {
    return { valid: null, errors: [], schemaKey: null };
  }

  const valid = validate(event);
  return {
    valid: !!valid,
    errors: validate.errors ? [...validate.errors] : [],
    schemaKey: key,
  };
}

function stripErrorMessages(obj: unknown): void {
  if (typeof obj !== 'object' || obj === null) return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripErrorMessages(item);
    return;
  }
  const record = obj as Record<string, unknown>;
  delete record['errorMessage'];
  for (const value of Object.values(record)) {
    stripErrorMessages(value);
  }
}

/**
 * Check that schemata package is importable and has schemas for our target kinds.
 * Also verifies schemas can be compiled by AJV (triggers lazy compilation + caching).
 * Returns list of available kind schema keys.
 */
export function checkSchemaAvailability(kinds: number[]): { available: string[]; missing: string[] } {
  const available: string[] = [];
  const missing: string[] = [];
  for (const kind of kinds) {
    const key = `kind${kind}Schema`;
    // Trigger validateEvent to force schema compilation and caching.
    // A dummy event is used — we only care whether a validator was produced.
    const dummyEvent: NostrEvent = { id: '', pubkey: '', kind, created_at: 0, tags: [], content: '', sig: '' };
    const result = validateEvent(dummyEvent);
    if (result.schemaKey) {
      available.push(key);
    } else {
      missing.push(key);
    }
  }
  return { available, missing };
}
