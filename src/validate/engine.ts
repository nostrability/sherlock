import { createRequire } from 'node:module';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { NostrEvent, ValidationResult, SemanticViolation } from '../types.js';
import { runAllSemanticChecks } from './semantic.js';
import { BASE_ERROR_MESSAGES, KIND_ERROR_MESSAGES } from '../generated/error-messages.js';

const require = createRequire(import.meta.url);

// Load all schemas from the schemata package via require (avoids Node 22+ ESM JSON import issue)
let schemas: Record<string, unknown> | null = null;
let kindNipMap: Map<number, string> | null = null;

function loadSchemas(): Record<string, unknown> {
  if (schemas) return schemas;
  // Walk the dist/nips directory to find kind schemas directly
  // (the ESM bundle re-exports don't work with require())
  const schemataDir = require.resolve('@nostrability/schemata/package.json');
  const fs = require('fs');
  const path = require('path');
  const pkgDir = path.dirname(schemataDir);

  schemas = {};
  kindNipMap = new Map();
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
          schemas[key] = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
          // Map kind number to NIP directory name (e.g., "nip-25" → "NIP-25")
          const nipLabel = nipDir.replace(/^nip-/, 'NIP-');
          kindNipMap!.set(Number(kindNum), nipLabel);
        }
      }
    }
  }

  return schemas;
}

/**
 * Get all kind numbers that have a schemata schema.
 */
export function getAvailableKinds(): number[] {
  loadSchemas();
  return [...kindNipMap!.keys()].sort((a, b) => a - b);
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

/**
 * Enrich AJV errors with human-friendly messages from generated error maps.
 *
 * Only enriches path-like keywords (e.g., "allOf[1].properties.kind") where the
 * generated keyword is specific enough for unambiguous schemaPath substring matching.
 * Bare leaf keywords (pattern, items, additionalItems, etc.) are too short and match
 * unrelated schema paths — skipped to avoid mislabeling errors.
 */
function enrichErrors(errors: ErrorObject[], kindNumber: number): void {
  const kindMsgs = KIND_ERROR_MESSAGES[kindNumber];

  for (const err of errors) {
    // 1. Kind-specific property errors — only match path-like keywords
    // Path-like keywords contain "properties" (e.g., "allOf[1].properties.kind")
    // and are specific enough for safe substring matching against AJV's schemaPath.
    // Bare keywords (pattern, items, contains, minItems, etc.) are skipped.
    if (kindMsgs) {
      const match = kindMsgs.find(km => {
        if (!km.keyword.includes('properties')) return false;
        // Normalize generated dotted notation to AJV's slash-separated schemaPath:
        // "allOf[1].properties.kind" → "allOf/1/properties/kind"
        const pathFragment = km.keyword.replace(/\[(\d+)\]/g, '/$1').replace(/\./g, '/');
        return err.schemaPath.includes(pathFragment);
      });
      if (match) { err.message = match.message; continue; }
    }
    // 2. Base field errors (e.g., instancePath "/kind" → "kind must equal constant value")
    // Skip "tags" — AJV's contains/minItems errors on /tags are more specific than the
    // generic base message ("tags must be an array of valid tag tuples").
    const field = err.instancePath.replace(/^\//, '');
    if (field && field !== 'tags' && BASE_ERROR_MESSAGES[field]) {
      err.message = BASE_ERROR_MESSAGES[field];
    }
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
  const errors = validate.errors ? [...validate.errors] : [];
  if (errors.length > 0) {
    enrichErrors(errors, event.kind);
  }
  return {
    valid: !!valid,
    errors,
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

/**
 * Run semantic validation checks on an event.
 * These go beyond JSON Schema to catch logical issues.
 */
export function runSemanticChecks(event: NostrEvent): SemanticViolation[] {
  return runAllSemanticChecks(event);
}
