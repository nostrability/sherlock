import { createRequire } from 'node:module';
import Ajv, { type ValidateFunction } from 'ajv';
import type { NostrEvent, ValidationResult } from '../types.js';

const require = createRequire(import.meta.url);

// Load all schemas from the schemata package via require (avoids Node 22+ ESM JSON import issue)
let schemas: Record<string, unknown> | null = null;

function loadSchemas(): Record<string, unknown> {
  if (schemas) return schemas;
  // The bundle's schemas.js re-exports from .json files; require() handles JSON natively
  const bundlePath = require.resolve('@nostrability/schemata');
  // bundlePath points to dist/bundle/schemas.js — but that's ESM with re-exports.
  // Instead, walk the dist/nips directory to find kind schemas directly.
  const schemataDir = require.resolve('@nostrability/schemata/package.json');
  const pkgDir = schemataDir.replace('/package.json', '');
  const fs = require('fs');
  const path = require('path');

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
    const entries = fs.readdirSync(nipPath);
    for (const entry of entries) {
      const match = entry.match(/^kind-(\d+)$/);
      if (match) {
        const kindNum = match[1];
        const schemaPath = path.join(nipPath, entry, 'schema.json');
        if (fs.existsSync(schemaPath)) {
          const key = `kind${kindNum}Schema`;
          schemas[key] = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
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
 * Returns list of available kind schema keys.
 */
export function checkSchemaAvailability(kinds: number[]): { available: string[]; missing: string[] } {
  const allSchemas = loadSchemas();
  const available: string[] = [];
  const missing: string[] = [];
  for (const kind of kinds) {
    const key = `kind${kind}Schema`;
    if (allSchemas[key]) {
      available.push(key);
    } else {
      missing.push(key);
    }
  }
  return { available, missing };
}
