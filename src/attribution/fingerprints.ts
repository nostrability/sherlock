import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppFingerprint } from '../types.js';

let cached: AppFingerprint[] | null = null;

/**
 * Load app fingerprint patterns from data/app-fingerprints.json.
 * Returns empty array if file doesn't exist (graceful degradation).
 */
export function loadFingerprints(): AppFingerprint[] {
  if (cached) return cached;

  const filePath = resolve(process.cwd(), 'data', 'app-fingerprints.json');
  if (!existsSync(filePath)) {
    cached = [];
    return cached;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown[];
    cached = parsed.filter((entry): entry is AppFingerprint =>
      typeof entry === 'object' && entry !== null && 'app_name' in entry
    );
    return cached;
  } catch (err) {
    console.error(`Warning: Failed to load fingerprints from ${filePath}: ${err}`);
    cached = [];
    return cached;
  }
}
