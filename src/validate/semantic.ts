import type { NostrEvent, SemanticViolation } from '../types.js';
import { universalChecks } from './checks/universal.js';
import { kind0Checks } from './checks/kind0.js';
import { kind3Checks } from './checks/kind3.js';
import { kind10002Checks } from './checks/kind10002.js';
import { kind9735Checks } from './checks/kind9735.js';

export interface SemanticCheck {
  kind: number | '*';
  name: string;
  check: (event: NostrEvent) => SemanticViolation[];
}

const registry: SemanticCheck[] = [
  ...universalChecks,
  ...kind0Checks,
  ...kind3Checks,
  ...kind10002Checks,
  ...kind9735Checks,
];

/**
 * Run all applicable semantic checks on an event.
 * Returns violations found (may be empty).
 */
export function runAllSemanticChecks(event: NostrEvent): SemanticViolation[] {
  const violations: SemanticViolation[] = [];

  for (const check of registry) {
    if (check.kind !== '*' && check.kind !== event.kind) continue;

    try {
      const results = check.check(event);
      violations.push(...results);
    } catch {
      // Don't let a buggy check break the pipeline
    }
  }

  return violations;
}
