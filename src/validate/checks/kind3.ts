import type { SemanticCheck } from '../semantic.js';
import type { NostrEvent, SemanticViolation } from '../../types.js';

export const kind3Checks: SemanticCheck[] = [
  {
    kind: 3,
    name: 'kind3_duplicate_pubkeys',
    check: (event: NostrEvent): SemanticViolation[] => {
      const pTags = event.tags.filter(t => t[0] === 'p' && t[1]);
      const pubkeys = pTags.map(t => t[1]);
      const unique = new Set(pubkeys);

      if (unique.size < pubkeys.length) {
        const dupeCount = pubkeys.length - unique.size;
        return [{
          check_name: 'kind3_duplicate_pubkeys',
          message: `Contact list has ${dupeCount} duplicate p tag(s) (${pubkeys.length} total, ${unique.size} unique)`,
          path: '/tags',
          severity: 'warning',
        }];
      }
      return [];
    },
  },
  {
    kind: 3,
    name: 'kind3_self_reference',
    check: (event: NostrEvent): SemanticViolation[] => {
      const selfRef = event.tags.find(t => t[0] === 'p' && t[1] === event.pubkey);
      if (selfRef) {
        return [{
          check_name: 'kind3_self_reference',
          message: 'Contact list contains a p tag referencing the event author',
          path: '/tags',
          severity: 'warning',
        }];
      }
      return [];
    },
  },
];
